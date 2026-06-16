import {
  normalizeByokProviderId,
  normalizeNullableText,
  normalizeText,
} from '../postgres-store-normalizers.ts'
import { nowIso } from '../postgres-store-id-helpers.ts'
import { byokSecretFromRow } from '../postgres-domains/byok.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'
import type {
  ByokSecretRecord,
  CreateByokSecretInput,
  DisableByokSecretInput,
  RecordAuditEventInput,
  RecordByokSecretValidationInput,
} from '../control-plane-store.ts'

// BYOK-secret SQL domain extracted from postgres-control-plane-store.ts. Owns the
// create / rotate / validate / disable / get / list lifecycle for org BYOK secrets,
// preserving the single-active-secret-per-(org,provider) invariant and the audit
// trail. Transaction + audit recording arrive via the injected host (the same
// repository pattern as workers/quotas/channel-* ). Behaviour-preserving; covered
// by the pglite + real-Postgres control-plane contract suites.

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresByokSecretsRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  recordAuditEvent(executor: PgExecutor, input: RecordAuditEventInput): Promise<unknown>
}

const BYOK_SECRET_TEXT_MAX_LENGTH = 4096
const BYOK_SECRET_ID_MAX_LENGTH = 256

export class PostgresByokSecretsRepository {
  private readonly options: PostgresByokSecretsRepositoryOptions

  constructor(options: PostgresByokSecretsRepositoryOptions) {
    this.options = options
  }

  async createByokSecret(input: CreateByokSecretInput) {
    return this.options.withTransaction(async (client) => {
      const providerId = normalizeByokProviderId(input.providerId)
      const ciphertext = normalizeNullableText(input.ciphertext, BYOK_SECRET_TEXT_MAX_LENGTH, 'BYOK ciphertext')
      const kmsRef = normalizeNullableText(input.kmsRef, BYOK_SECRET_TEXT_MAX_LENGTH, 'BYOK KMS ref')
      if ((ciphertext && kmsRef) || (!ciphertext && !kmsRef)) {
        throw new Error('BYOK secret requires exactly one of ciphertext or kmsRef.')
      }
      const status = input.status || 'pending_validation'
      const now = nowIso(input.createdAt)
      const prior = status === 'active'
        ? await client.query(
          `UPDATE cloud_byok_secrets
           SET status = 'disabled', updated_at = $3
           WHERE org_id = $1 AND provider_id = $2 AND status = 'active'
           RETURNING *`,
          [input.orgId, providerId, now],
        )
        : await client.query(
          `SELECT * FROM cloud_byok_secrets
           WHERE org_id = $1 AND provider_id = $2 AND status = 'active'
           LIMIT 1`,
          [input.orgId, providerId],
        )
      const priorActive = prior.rows[0] ? byokSecretFromRow(prior.rows[0]) : null
      const result = await client.query(
        `INSERT INTO cloud_byok_secrets (
          secret_id, org_id, provider_id, status, ciphertext, kms_ref, last4,
          key_fingerprint, created_by_account_id, rotated_from_secret_id,
          last_validated_at, validation_error, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL, $11, $11)
        RETURNING *`,
        [
          normalizeText(input.secretId, BYOK_SECRET_ID_MAX_LENGTH, 'BYOK secret id'),
          input.orgId,
          providerId,
          status,
          ciphertext,
          kmsRef,
          normalizeText(input.last4, 32, 'BYOK secret last4'),
          normalizeText(input.keyFingerprint, 128, 'BYOK key fingerprint'),
          input.createdByAccountId || null,
          input.rotatedFromSecretId || priorActive?.secretId || null,
          now,
        ],
      )
      const secret = byokSecretFromRow(result.rows[0])
      await this.options.recordAuditEvent(client, {
        orgId: secret.orgId,
        accountId: secret.createdByAccountId,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: priorActive
          ? status === 'active'
            ? 'byok_secret.rotated'
            : 'byok_secret.rotation_started'
          : 'byok_secret.created',
        targetType: 'byok_secret',
        targetId: secret.secretId,
        metadata: {
          providerId: secret.providerId,
          status: secret.status,
          last4: secret.last4,
          keyFingerprint: secret.keyFingerprint,
          rotatedFromSecretId: secret.rotatedFromSecretId,
        },
        createdAt: input.createdAt,
      })
      return secret
    })
  }

  async getByokSecret(orgId: string, providerId: string) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_byok_secrets
       WHERE org_id = $1 AND provider_id = $2
       ORDER BY updated_at DESC, created_at DESC, secret_id DESC
       LIMIT 1`,
      [orgId, normalizeByokProviderId(providerId)],
    )
    return row ? byokSecretFromRow(row) : null
  }

  async getActiveByokSecret(orgId: string, providerId: string) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_byok_secrets
       WHERE org_id = $1 AND provider_id = $2 AND status = 'active'
       ORDER BY updated_at DESC, created_at DESC, secret_id DESC
       LIMIT 1`,
      [orgId, normalizeByokProviderId(providerId)],
    )
    return row ? byokSecretFromRow(row) : null
  }

  async listByokSecrets(orgId: string) {
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_byok_secrets
       WHERE org_id = $1
       ORDER BY updated_at DESC, created_at DESC, provider_id, secret_id DESC`,
      [orgId],
    )
    return result.rows.map(byokSecretFromRow)
  }

  async disableByokSecret(input: DisableByokSecretInput) {
    return this.options.withTransaction(async (client) => {
      const providerId = normalizeByokProviderId(input.providerId)
      const now = nowIso(input.disabledAt)
      const result = await client.query(
        `UPDATE cloud_byok_secrets
         SET status = 'disabled', updated_at = $4
         WHERE org_id = $1
           AND provider_id = $2
           AND ($3::text IS NULL OR secret_id = $3)
           AND status <> 'disabled'
         RETURNING *`,
        [input.orgId, providerId, input.secretId || null, now],
      )
      if (!result.rows[0]) return null
      const secrets = result.rows
        .map(byokSecretFromRow)
        .sort((left, right) => (
          right.updatedAt.localeCompare(left.updatedAt)
          || right.createdAt.localeCompare(left.createdAt)
          || right.secretId.localeCompare(left.secretId)
        ))
      for (const secret of secrets) {
        await this.options.recordAuditEvent(client, {
          orgId: secret.orgId,
          accountId: input.actor?.accountId || secret.createdByAccountId,
          actorType: input.actor?.actorType || 'system',
          actorId: input.actor?.actorId || null,
          eventType: 'byok_secret.disabled',
          targetType: 'byok_secret',
          targetId: secret.secretId,
          metadata: { providerId: secret.providerId, status: secret.status, last4: secret.last4, keyFingerprint: secret.keyFingerprint },
          createdAt: input.disabledAt,
        })
      }
      return secrets[0]
    })
  }

  async recordByokSecretValidation(input: RecordByokSecretValidationInput) {
    return this.options.withTransaction(async (client) => {
      const providerId = normalizeByokProviderId(input.providerId)
      const now = nowIso(input.validatedAt)
      let priorActive: ByokSecretRecord | null = null
      let targetSecretId = input.secretId || null
      if (input.status === 'active') {
        const target = await client.query(
          `SELECT * FROM cloud_byok_secrets
           WHERE org_id = $1
             AND provider_id = $2
             AND ($3::text IS NULL OR secret_id = $3)
             AND ($3::text IS NOT NULL OR status = 'active')
           ORDER BY updated_at DESC, created_at DESC, secret_id DESC
           LIMIT 1
           FOR UPDATE`,
          [input.orgId, providerId, targetSecretId],
        )
        if (!target.rows[0]) return null
        targetSecretId = String(target.rows[0].secret_id)
        const prior = await client.query(
          `UPDATE cloud_byok_secrets
           SET status = 'disabled', updated_at = $4
           WHERE org_id = $1
             AND provider_id = $2
             AND secret_id <> $3
             AND status = 'active'
           RETURNING *`,
          [input.orgId, providerId, targetSecretId, now],
        )
        priorActive = prior.rows
          .map(byokSecretFromRow)
          .sort((left, right) => (
            right.updatedAt.localeCompare(left.updatedAt)
            || right.createdAt.localeCompare(left.createdAt)
            || right.secretId.localeCompare(left.secretId)
          ))[0] || null
      }
      const result = await client.query(
        `UPDATE cloud_byok_secrets
         SET status = COALESCE($4, status),
             last_validated_at = $5,
             validation_error = $6,
             rotated_from_secret_id = COALESCE(rotated_from_secret_id, $7),
             updated_at = $5
         WHERE org_id = $1
           AND provider_id = $2
           AND ($3::text IS NULL OR secret_id = $3)
           AND ($3::text IS NOT NULL OR status = 'active')
         RETURNING *`,
        [
          input.orgId,
          providerId,
          targetSecretId,
          input.status || null,
          now,
          input.validationError || null,
          input.status === 'active' ? priorActive?.secretId || null : null,
        ],
      )
      if (!result.rows[0]) return null
      const secret = byokSecretFromRow(result.rows[0])
      await this.options.recordAuditEvent(client, {
        orgId: secret.orgId,
        accountId: input.actor?.accountId || secret.createdByAccountId,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'byok_secret.validated',
        targetType: 'byok_secret',
        targetId: secret.secretId,
        metadata: {
          providerId: secret.providerId,
          status: secret.status,
          last4: secret.last4,
          keyFingerprint: secret.keyFingerprint,
          validationError: secret.validationError,
        },
        createdAt: input.validatedAt,
      })
      if (input.status === 'active' && (priorActive || secret.rotatedFromSecretId)) {
        await this.options.recordAuditEvent(client, {
          orgId: secret.orgId,
          accountId: input.actor?.accountId || secret.createdByAccountId,
          actorType: input.actor?.actorType || 'system',
          actorId: input.actor?.actorId || null,
          eventType: 'byok_secret.rotated',
          targetType: 'byok_secret',
          targetId: secret.secretId,
          metadata: {
            providerId: secret.providerId,
            status: secret.status,
            last4: secret.last4,
            keyFingerprint: secret.keyFingerprint,
            rotatedFromSecretId: secret.rotatedFromSecretId || priorActive?.secretId || null,
          },
          createdAt: input.validatedAt,
        })
      }
      return secret
    })
  }

  private async maybeOne<Row extends QueryRow = QueryRow>(
    text: string,
    values?: unknown[],
    executor: PgExecutor = this.options.pool,
  ) {
    const result = await executor.query<Row>(text, values)
    return result.rows[0] || null
  }
}
