import { randomUUID } from 'node:crypto'
import { nowIso } from '../postgres-store-id-helpers.ts'
import { verifyScimTokenHash } from '../control-plane-tokens.ts'
import {
  iso,
  jsonRecord,
  jsonStringArray,
  numberValue,
  stringOrNull,
  type QueryResult,
  type QueryRow,
} from '../postgres-domains/shared.ts'
import {
  mergeOrgSsoConfig,
  type OrgSsoConfigRecord,
  type SsoProtocol,
  type UpsertOrgSsoConfigInput,
} from '../control-plane-sso.ts'
import {
  normalizeScimSyncOperation,
  scimRetryDelayMs,
  SCIM_SYNC_DEFAULT_MAX_ATTEMPTS,
  type ClaimScimSyncEventsInput,
  type CompleteScimSyncEventInput,
  type EnqueueScimSyncEventInput,
  type FailScimSyncEventInput,
  type ListScimSyncEventsInput,
  type ScimSyncEventRecord,
  type ScimSyncEventStatus,
} from '../control-plane-scim.ts'
import type { RecordAuditEventInput } from '../control-plane-store.ts'

// Enterprise SSO + SCIM SQL domain (issue #895): the Postgres peer of the in-memory
// SSO domain. Owns cloud_org_sso_configs (org SSO config) + cloud_scim_sync_events
// (the durable SCIM sync queue). Covered by the pglite + real-Postgres contract suites.

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresSsoRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  recordAuditEvent(executor: PgExecutor, input: RecordAuditEventInput): Promise<unknown>
}

const SCIM_ERROR_MAX_LENGTH = 512

function configFromRow(row: QueryRow): OrgSsoConfigRecord {
  return {
    orgId: String(row.org_id),
    protocol: String(row.protocol) as SsoProtocol,
    enabled: row.enabled === true,
    enforced: row.enforced === true,
    displayName: stringOrNull(row.display_name),
    verifiedDomains: jsonStringArray(row.verified_domains),
    domainVerificationToken: String(row.domain_verification_token),
    oidcIssuer: stringOrNull(row.oidc_issuer),
    oidcClientId: stringOrNull(row.oidc_client_id),
    oidcClientSecretCiphertext: stringOrNull(row.oidc_client_secret_ciphertext),
    samlEntityId: stringOrNull(row.saml_entity_id),
    samlAcsUrl: stringOrNull(row.saml_acs_url),
    samlSloUrl: stringOrNull(row.saml_slo_url),
    samlIdpEntityId: stringOrNull(row.saml_idp_entity_id),
    samlIdpSsoUrl: stringOrNull(row.saml_idp_sso_url),
    samlIdpMetadataUrl: stringOrNull(row.saml_idp_metadata_url),
    samlIdpCertificateCiphertext: stringOrNull(row.saml_idp_certificate_ciphertext),
    scimEnabled: row.scim_enabled === true,
    scimTokenHash: stringOrNull(row.scim_token_hash),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function eventFromRow(row: QueryRow): ScimSyncEventRecord {
  return {
    eventId: String(row.event_id),
    orgId: String(row.org_id),
    operation: normalizeScimSyncOperation(row.operation),
    externalId: stringOrNull(row.external_id),
    payload: jsonRecord(row.payload),
    status: String(row.status) as ScimSyncEventStatus,
    attempts: numberValue(row.attempts),
    maxAttempts: numberValue(row.max_attempts),
    nextAttemptAt: iso(row.next_attempt_at),
    lastError: stringOrNull(row.last_error),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

const CONFIG_COLUMNS = `org_id, protocol, enabled, enforced, display_name, verified_domains,
  domain_verification_token, oidc_issuer, oidc_client_id, oidc_client_secret_ciphertext,
  saml_entity_id, saml_acs_url, saml_slo_url, saml_idp_entity_id, saml_idp_sso_url,
  saml_idp_metadata_url, saml_idp_certificate_ciphertext, scim_enabled, scim_token_hash,
  created_at, updated_at`

export class PostgresSsoRepository {
  private readonly options: PostgresSsoRepositoryOptions

  constructor(options: PostgresSsoRepositoryOptions) {
    this.options = options
  }

  async getOrgSsoConfig(orgId: string): Promise<OrgSsoConfigRecord | null> {
    const result = await this.options.pool.query(`SELECT * FROM cloud_org_sso_configs WHERE org_id = $1`, [orgId])
    return result.rows[0] ? configFromRow(result.rows[0]) : null
  }

  async upsertOrgSsoConfig(input: UpsertOrgSsoConfigInput): Promise<OrgSsoConfigRecord> {
    return this.options.withTransaction(async (client) => {
      const now = nowIso(input.updatedAt)
      const current = await client.query(`SELECT * FROM cloud_org_sso_configs WHERE org_id = $1 FOR UPDATE`, [input.orgId])
      const existing = current.rows[0] ? configFromRow(current.rows[0]) : null
      const merged = mergeOrgSsoConfig(existing, input, now)
      const result = await client.query(
        `INSERT INTO cloud_org_sso_configs (${CONFIG_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
         ON CONFLICT (org_id) DO UPDATE SET
           protocol = EXCLUDED.protocol,
           enabled = EXCLUDED.enabled,
           enforced = EXCLUDED.enforced,
           display_name = EXCLUDED.display_name,
           verified_domains = EXCLUDED.verified_domains,
           domain_verification_token = EXCLUDED.domain_verification_token,
           oidc_issuer = EXCLUDED.oidc_issuer,
           oidc_client_id = EXCLUDED.oidc_client_id,
           oidc_client_secret_ciphertext = EXCLUDED.oidc_client_secret_ciphertext,
           saml_entity_id = EXCLUDED.saml_entity_id,
           saml_acs_url = EXCLUDED.saml_acs_url,
           saml_slo_url = EXCLUDED.saml_slo_url,
           saml_idp_entity_id = EXCLUDED.saml_idp_entity_id,
           saml_idp_sso_url = EXCLUDED.saml_idp_sso_url,
           saml_idp_metadata_url = EXCLUDED.saml_idp_metadata_url,
           saml_idp_certificate_ciphertext = EXCLUDED.saml_idp_certificate_ciphertext,
           scim_enabled = EXCLUDED.scim_enabled,
           scim_token_hash = EXCLUDED.scim_token_hash,
           updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          merged.orgId, merged.protocol, merged.enabled, merged.enforced, merged.displayName,
          JSON.stringify(merged.verifiedDomains), merged.domainVerificationToken, merged.oidcIssuer,
          merged.oidcClientId, merged.oidcClientSecretCiphertext, merged.samlEntityId, merged.samlAcsUrl,
          merged.samlSloUrl, merged.samlIdpEntityId, merged.samlIdpSsoUrl, merged.samlIdpMetadataUrl,
          merged.samlIdpCertificateCiphertext, merged.scimEnabled, merged.scimTokenHash, merged.createdAt, merged.updatedAt,
        ],
      )
      const record = configFromRow(result.rows[0]!)
      await this.options.recordAuditEvent(client, {
        orgId: input.orgId,
        accountId: input.actor?.accountId || null,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: existing ? 'sso_config.updated' : 'sso_config.created',
        targetType: 'sso_config',
        targetId: input.orgId,
        metadata: { protocol: record.protocol, enabled: record.enabled, enforced: record.enforced, scimEnabled: record.scimEnabled },
        createdAt: input.updatedAt,
      })
      return record
    })
  }

  async deleteOrgSsoConfig(orgId: string): Promise<boolean> {
    return this.options.withTransaction(async (client) => {
      const result = await client.query(`DELETE FROM cloud_org_sso_configs WHERE org_id = $1 RETURNING org_id`, [orgId])
      if (!result.rows[0]) return false
      await this.options.recordAuditEvent(client, {
        orgId,
        actorType: 'system',
        actorId: 'sso_config.delete',
        eventType: 'sso_config.deleted',
        targetType: 'sso_config',
        targetId: orgId,
        metadata: {},
      })
      return true
    })
  }

  async findOrgSsoConfigByScimToken(plaintext: string): Promise<OrgSsoConfigRecord | null> {
    if (!plaintext) return null
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_org_sso_configs WHERE scim_enabled = true AND scim_token_hash IS NOT NULL`,
    )
    for (const row of result.rows) {
      const record = configFromRow(row)
      if (record.scimTokenHash && await verifyScimTokenHash(plaintext, record.scimTokenHash)) return record
    }
    return null
  }

  async findOrgSsoConfigByDomain(domain: string): Promise<OrgSsoConfigRecord | null> {
    const normalized = domain.trim().toLowerCase()
    if (!normalized) return null
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_org_sso_configs
       WHERE enabled = true AND verified_domains @> $1::jsonb
       ORDER BY org_id LIMIT 1`,
      [JSON.stringify([normalized])],
    )
    return result.rows[0] ? configFromRow(result.rows[0]) : null
  }

  async enqueueScimSyncEvent(input: EnqueueScimSyncEventInput): Promise<ScimSyncEventRecord> {
    const now = nowIso(input.createdAt)
    const eventId = input.eventId?.trim() || randomUUID()
    const nextAttemptAt = (input.availableAt || input.createdAt || new Date()).toISOString()
    const result = await this.options.pool.query(
      `INSERT INTO cloud_scim_sync_events
         (event_id, org_id, operation, external_id, payload, status, attempts, max_attempts, next_attempt_at, last_error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', 0, $6, $7, NULL, $8, $8)
       RETURNING *`,
      [
        eventId, input.orgId, normalizeScimSyncOperation(input.operation), input.externalId?.trim() || null,
        JSON.stringify(input.payload || {}), Math.max(1, Math.floor(input.maxAttempts ?? SCIM_SYNC_DEFAULT_MAX_ATTEMPTS)),
        nextAttemptAt, now,
      ],
    )
    return eventFromRow(result.rows[0]!)
  }

  async claimNextScimSyncEvents(input: ClaimScimSyncEventsInput = {}): Promise<ScimSyncEventRecord[]> {
    const now = input.now || new Date()
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)))
    const result = await this.options.pool.query(
      `UPDATE cloud_scim_sync_events SET status = 'processing', attempts = attempts + 1, updated_at = $1
       WHERE event_id IN (
         SELECT event_id FROM cloud_scim_sync_events
         WHERE status = 'pending' AND next_attempt_at <= $1 AND ($2::text IS NULL OR org_id = $2)
         ORDER BY next_attempt_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $3
       )
       RETURNING *`,
      [now.toISOString(), input.orgId ?? null, limit],
    )
    return result.rows.map(eventFromRow)
  }

  async completeScimSyncEvent(input: CompleteScimSyncEventInput): Promise<ScimSyncEventRecord | null> {
    const result = await this.options.pool.query(
      `UPDATE cloud_scim_sync_events SET status = 'succeeded', last_error = NULL, updated_at = $3
       WHERE event_id = $1 AND org_id = $2 RETURNING *`,
      [input.eventId, input.orgId, (input.now || new Date()).toISOString()],
    )
    return result.rows[0] ? eventFromRow(result.rows[0]) : null
  }

  async failScimSyncEvent(input: FailScimSyncEventInput): Promise<ScimSyncEventRecord | null> {
    const now = input.now || new Date()
    const error = input.error.trim().slice(0, SCIM_ERROR_MAX_LENGTH) || null
    return this.options.withTransaction(async (client) => {
      const current = await client.query(`SELECT * FROM cloud_scim_sync_events WHERE event_id = $1 AND org_id = $2 FOR UPDATE`, [input.eventId, input.orgId])
      if (!current.rows[0]) return null
      const event = eventFromRow(current.rows[0])
      const exhausted = event.attempts >= event.maxAttempts
      const nextAttemptAt = exhausted ? now.toISOString() : new Date(now.getTime() + scimRetryDelayMs(event.attempts)).toISOString()
      const result = await client.query(
        `UPDATE cloud_scim_sync_events SET status = $3, last_error = $4, next_attempt_at = $5, updated_at = $6
         WHERE event_id = $1 AND org_id = $2 RETURNING *`,
        [input.eventId, input.orgId, exhausted ? 'failed' : 'pending', error, nextAttemptAt, now.toISOString()],
      )
      return result.rows[0] ? eventFromRow(result.rows[0]) : null
    })
  }

  async listScimSyncEvents(input: ListScimSyncEventsInput): Promise<ScimSyncEventRecord[]> {
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)))
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_scim_sync_events
       WHERE org_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY created_at DESC, event_id
       LIMIT $3`,
      [input.orgId, input.status ?? null, limit],
    )
    return result.rows.map(eventFromRow)
  }
}
