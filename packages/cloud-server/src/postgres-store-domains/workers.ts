import { redactOperationalText } from '../operational-text-redaction.ts'
import { randomBytes } from 'node:crypto'
import {
  generateManagedWorkerCredential,
  hashManagedWorkerCredential,
} from '../in-memory-domains/workers.ts'
import type {
  CreateManagedWorkerPoolInput,
  IssueManagedWorkerCredentialInput,
  IssuedManagedWorkerCredentialRecord,
  ManagedWorkerCredentialRecord,
  ManagedWorkerCredentialScope,
  ManagedWorkerHeartbeatRecord,
  ManagedWorkerPoolMode,
  ManagedWorkerPoolRecord,
  ManagedWorkerPoolStatus,
  ManagedWorkerRecord,
  ManagedWorkerStatus,
  RecordAuditEventInput,
  RecordManagedWorkerHeartbeatInput,
  RegisterManagedWorkerInput,
  ResolvedManagedWorkerCredentialRecord,
  RevokeManagedWorkerCredentialInput,
  UpdateManagedWorkerPoolInput,
  UpdateManagedWorkerStatusInput,
} from '../control-plane-store.ts'
import {
  managedWorkerCredentialFromRow,
  managedWorkerFromRow,
  managedWorkerHeartbeatFromRow,
  managedWorkerPoolFromRow,
} from '../postgres-domains/workers.ts'
import { jsonRecord, type QueryResult, type QueryRow } from '../postgres-domains/shared.ts'

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresManagedWorkersRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  recordAuditEvent(executor: PgExecutor, input: RecordAuditEventInput): Promise<unknown>
}

const MANAGED_WORKER_TEXT_MAX_LENGTH = 256
const MANAGED_WORKER_METADATA_MAX_BYTES = 16_384
const MANAGED_WORKER_DEFAULT_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1000
const MANAGED_WORKER_SUPPORTED_POOL_MODES = new Set<ManagedWorkerPoolMode>(['saas_operated', 'self_hosted'])

export class PostgresManagedWorkersRepository {
  private readonly options: PostgresManagedWorkersRepositoryOptions

  constructor(options: PostgresManagedWorkersRepositoryOptions) {
    this.options = options
  }

  async createPool(input: CreateManagedWorkerPoolInput): Promise<ManagedWorkerPoolRecord> {
    const now = nowIso(input.createdAt)
    const org = await this.maybeOne(`SELECT * FROM cloud_orgs WHERE org_id = $1`, [input.orgId])
    if (!org) throw new Error(`Unknown org ${input.orgId}.`)
    const poolId = input.poolId || randomRecordId('mwp')
    return this.options.withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO cloud_worker_pools (
          pool_id, org_id, tenant_id, name, mode, status, region, capabilities,
          max_workers, max_concurrent_work, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $11)
         ON CONFLICT (pool_id) DO NOTHING
         RETURNING *`,
        [
          poolId,
          input.orgId,
          String(org.tenant_id),
          normalizeText(input.name, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker pool name'),
          normalizePoolMode(input.mode),
          normalizePoolStatus(input.status),
          normalizeNullableText(input.region, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker pool region'),
          JSON.stringify(normalizeMetadata(input.capabilities, 'Managed worker pool capabilities')),
          normalizeNullablePositiveInteger(input.maxWorkers, 'Managed worker max workers'),
          normalizeNullablePositiveInteger(input.maxConcurrentWork, 'Managed worker max concurrent work'),
          now,
        ],
      )
      const pool = result.rows[0]
        ? managedWorkerPoolFromRow(result.rows[0])
        : managedWorkerPoolFromRow(await this.one(`SELECT * FROM cloud_worker_pools WHERE pool_id = $1`, [poolId], client))
      await this.options.recordAuditEvent(client, {
        orgId: pool.orgId,
        accountId: input.actor?.accountId || null,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'managed_worker_pool.created',
        targetType: 'managed_worker_pool',
        targetId: pool.poolId,
        metadata: { name: pool.name, mode: pool.mode, status: pool.status, region: pool.region },
        createdAt: input.createdAt,
      })
      return pool
    })
  }

  async updatePool(input: UpdateManagedWorkerPoolInput): Promise<ManagedWorkerPoolRecord | null> {
    const existing = await this.getPool(input.orgId, input.poolId)
    if (!existing) return null
    const updatedAt = nowIso(input.updatedAt)
    return this.options.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE cloud_worker_pools
         SET name = COALESCE($3, name),
             status = COALESCE($4, status),
             region = $5,
             capabilities = COALESCE($6::jsonb, capabilities),
             max_workers = $7,
             max_concurrent_work = $8,
             updated_at = $9
         WHERE org_id = $1 AND pool_id = $2
         RETURNING *`,
        [
          input.orgId,
          input.poolId,
          input.name === undefined ? null : normalizeText(input.name, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker pool name'),
          input.status === undefined ? null : normalizePoolStatus(input.status),
          input.region === undefined ? existing.region : normalizeNullableText(input.region, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker pool region'),
          input.capabilities === undefined ? null : JSON.stringify(normalizeMetadata(input.capabilities, 'Managed worker pool capabilities')),
          input.maxWorkers === undefined ? existing.maxWorkers : normalizeNullablePositiveInteger(input.maxWorkers, 'Managed worker max workers'),
          input.maxConcurrentWork === undefined ? existing.maxConcurrentWork : normalizeNullablePositiveInteger(input.maxConcurrentWork, 'Managed worker max concurrent work'),
          updatedAt,
        ],
      )
      if (!result.rows[0]) return null
      const pool = managedWorkerPoolFromRow(result.rows[0])
      await this.options.recordAuditEvent(client, {
        orgId: pool.orgId,
        accountId: input.actor?.accountId || null,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'managed_worker_pool.updated',
        targetType: 'managed_worker_pool',
        targetId: pool.poolId,
        metadata: { name: pool.name, status: pool.status },
        createdAt: input.updatedAt,
      })
      return pool
    })
  }

  async getPool(orgId: string, poolId: string) {
    const row = await this.maybeOne(`SELECT * FROM cloud_worker_pools WHERE org_id = $1 AND pool_id = $2`, [orgId, poolId])
    return row ? managedWorkerPoolFromRow(row) : null
  }

  async listPools(orgId: string, input: { status?: ManagedWorkerPoolStatus | null, limit?: number | null } = {}) {
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_worker_pools
       WHERE org_id = $1 AND ($2::text IS NULL OR status = $2)
       ORDER BY updated_at DESC, pool_id ASC
       LIMIT $3`,
      [orgId, input.status || null, normalizeListLimit(input.limit, 100, 500)],
    )
    return result.rows.map(managedWorkerPoolFromRow)
  }

  async registerWorker(input: RegisterManagedWorkerInput): Promise<ManagedWorkerRecord> {
    const pool = await this.getPool(input.orgId, input.poolId)
    if (!pool) throw new Error(`Unknown managed worker pool ${input.poolId}.`)
    const now = nowIso(input.createdAt)
    const workerId = input.workerId || randomRecordId('mworker')
    return this.options.withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO cloud_managed_workers (
          worker_id, org_id, tenant_id, pool_id, display_name, status, version,
          capabilities, last_heartbeat_at, last_error_code, last_error_summary,
          current_load, created_at, updated_at, revoked_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NULL, NULL, NULL, 0, $9, $9, $10)
         ON CONFLICT (worker_id) DO NOTHING
         RETURNING *`,
        [
          workerId,
          input.orgId,
          pool.tenantId,
          input.poolId,
          normalizeText(input.displayName, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker display name'),
          normalizeWorkerStatus(input.status),
          normalizeNullableText(input.version, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker version'),
          JSON.stringify(normalizeMetadata(input.capabilities, 'Managed worker capabilities')),
          now,
          input.status === 'revoked' ? now : null,
        ],
      )
      const worker = result.rows[0]
        ? managedWorkerFromRow(result.rows[0])
        : managedWorkerFromRow(await this.one(`SELECT * FROM cloud_managed_workers WHERE worker_id = $1`, [workerId], client))
      await this.options.recordAuditEvent(client, {
        orgId: worker.orgId,
        accountId: input.actor?.accountId || null,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'managed_worker.registered',
        targetType: 'managed_worker',
        targetId: worker.workerId,
        metadata: { poolId: worker.poolId, status: worker.status, displayName: worker.displayName },
        createdAt: input.createdAt,
      })
      return worker
    })
  }

  async updateWorkerStatus(input: UpdateManagedWorkerStatusInput): Promise<ManagedWorkerRecord | null> {
    const existing = await this.getWorker(input.orgId, input.workerId)
    if (!existing) return null
    const status = normalizeWorkerStatus(input.status)
    assertWorkerStatusTransition(existing.status, status)
    const updatedAt = nowIso(input.updatedAt)
    return this.options.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE cloud_managed_workers
         SET status = $3,
             updated_at = $4,
             revoked_at = CASE WHEN $3 = 'revoked' THEN COALESCE(revoked_at, $4) ELSE revoked_at END
         WHERE org_id = $1 AND worker_id = $2
         RETURNING *`,
        [input.orgId, input.workerId, status, updatedAt],
      )
      if (!result.rows[0]) return null
      const worker = managedWorkerFromRow(result.rows[0])
      await this.options.recordAuditEvent(client, {
        orgId: worker.orgId,
        accountId: input.actor?.accountId || null,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: `managed_worker.${status}`,
        targetType: 'managed_worker',
        targetId: worker.workerId,
        metadata: { poolId: worker.poolId, status, reason: input.reason || null },
        createdAt: input.updatedAt,
      })
      return worker
    })
  }

  async getWorker(orgId: string, workerId: string) {
    const row = await this.maybeOne(`SELECT * FROM cloud_managed_workers WHERE org_id = $1 AND worker_id = $2`, [orgId, workerId])
    return row ? managedWorkerFromRow(row) : null
  }

  async listWorkers(orgId: string, input: { poolId?: string | null, status?: ManagedWorkerStatus | null, limit?: number | null } = {}) {
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_managed_workers
       WHERE org_id = $1
         AND ($2::text IS NULL OR pool_id = $2)
         AND ($3::text IS NULL OR status = $3)
       ORDER BY updated_at DESC, worker_id ASC
       LIMIT $4`,
      [orgId, input.poolId || null, input.status || null, normalizeListLimit(input.limit, 100, 500)],
    )
    return result.rows.map(managedWorkerFromRow)
  }

  async issueCredential(input: IssueManagedWorkerCredentialInput): Promise<IssuedManagedWorkerCredentialRecord> {
    const worker = await this.getWorker(input.orgId, input.workerId)
    if (!worker) throw new Error(`Unknown managed worker ${input.workerId}.`)
    if (worker.status === 'revoked' || worker.status === 'retired') throw new Error('Cannot issue credentials for a terminal managed worker.')
    const generated = generateManagedWorkerCredential(input)
    const createdAt = input.createdAt || new Date()
    const now = createdAt.toISOString()
    const expiresAt = input.expiresAt || new Date(createdAt.getTime() + MANAGED_WORKER_DEFAULT_CREDENTIAL_TTL_MS)
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= createdAt.getTime()) {
      throw new Error('Managed worker credential expiration must be in the future.')
    }
    return this.options.withTransaction(async (client) => {
      const result = await client.query(
        `INSERT INTO cloud_worker_credentials (
          credential_id, org_id, worker_id, pool_id, token_hash, scopes, last4,
          expires_at, revoked_at, last_used_at, rotated_from_credential_id, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NULL, NULL, $9, $10, $10)
         RETURNING *`,
        [
          generated.credentialId,
          worker.orgId,
          worker.workerId,
          worker.poolId,
          hashManagedWorkerCredential(generated.plaintext),
          JSON.stringify(normalizeCredentialScopes(input.scopes)),
          generated.plaintext.slice(-4),
          expiresAt.toISOString(),
          input.rotatedFromCredentialId || null,
          now,
        ],
      )
      const credential = managedWorkerCredentialFromRow(result.rows[0]!)
      await this.options.recordAuditEvent(client, {
        orgId: credential.orgId,
        accountId: input.actor?.accountId || null,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: input.rotatedFromCredentialId ? 'managed_worker_credential.rotated' : 'managed_worker_credential.issued',
        targetType: 'managed_worker_credential',
        targetId: credential.credentialId,
        metadata: { workerId: credential.workerId, scopes: credential.scopes, last4: credential.last4 },
        createdAt: input.createdAt,
      })
      return { credential, plaintext: generated.plaintext }
    })
  }

  async listCredentials(orgId: string, workerId: string) {
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_worker_credentials
       WHERE org_id = $1 AND worker_id = $2
       ORDER BY created_at DESC`,
      [orgId, workerId],
    )
    return result.rows.map(managedWorkerCredentialFromRow)
  }

  async findCredentialByPlaintext(plaintext: string, now = new Date()): Promise<ResolvedManagedWorkerCredentialRecord | null> {
    const tokenHash = hashManagedWorkerCredential(plaintext)
    return this.options.withTransaction(async (client) => {
      const nowText = nowIso(now)
      const result = await client.query(
        `SELECT * FROM cloud_worker_credentials WHERE token_hash = $1`,
        [tokenHash],
      )
      if (!result.rows[0]) return null
      const credential = managedWorkerCredentialFromRow(result.rows[0])
      if (credential.revokedAt) {
        await this.recordHeartbeatRejected(client, credential, 'credential_revoked', now)
        return null
      }
      if (new Date(credential.expiresAt).getTime() <= now.getTime()) {
        await this.recordHeartbeatRejected(client, credential, 'credential_expired', now)
        return null
      }
      const workerRow = await this.maybeOne(
        `SELECT * FROM cloud_managed_workers
         WHERE org_id = $1 AND worker_id = $2 AND status NOT IN ('retired', 'revoked')`,
        [credential.orgId, credential.workerId],
        client,
      )
      if (!workerRow) {
        const terminalWorker = await this.maybeOne(
          `SELECT * FROM cloud_managed_workers
           WHERE org_id = $1 AND worker_id = $2`,
          [credential.orgId, credential.workerId],
          client,
        )
        await this.recordHeartbeatRejected(
          client,
          credential,
          terminalWorker ? `worker_${String(terminalWorker.status)}` : 'worker_missing',
          now,
        )
        return null
      }
      const poolRow = await this.maybeOne(
        `SELECT * FROM cloud_worker_pools WHERE org_id = $1 AND pool_id = $2`,
        [credential.orgId, credential.poolId],
        client,
      )
      if (!poolRow) {
        await this.recordHeartbeatRejected(client, credential, 'pool_missing', now)
        return null
      }
      const updatedCredentialRow = await client.query(
        `UPDATE cloud_worker_credentials
         SET last_used_at = $2, updated_at = $2
         WHERE credential_id = $1
         RETURNING *`,
        [credential.credentialId, nowText],
      )
      return {
        credential: managedWorkerCredentialFromRow(updatedCredentialRow.rows[0]!),
        worker: managedWorkerFromRow(workerRow),
        pool: managedWorkerPoolFromRow(poolRow),
      }
    })
  }

  async revokeCredential(input: RevokeManagedWorkerCredentialInput): Promise<ManagedWorkerCredentialRecord | null> {
    return this.options.withTransaction(async (client) => {
      const now = nowIso(input.revokedAt)
      const result = await client.query(
        `UPDATE cloud_worker_credentials
         SET revoked_at = COALESCE(revoked_at, $3), updated_at = $3
         WHERE org_id = $1
           AND credential_id = $2
           AND ($4::text IS NULL OR worker_id = $4)
         RETURNING *`,
        [input.orgId, input.credentialId, now, input.workerId || null],
      )
      if (!result.rows[0]) return null
      const credential = managedWorkerCredentialFromRow(result.rows[0])
      await this.options.recordAuditEvent(client, {
        orgId: credential.orgId,
        accountId: input.actor?.accountId || null,
        actorType: input.actor?.actorType || 'system',
        actorId: input.actor?.actorId || null,
        eventType: 'managed_worker_credential.revoked',
        targetType: 'managed_worker_credential',
        targetId: credential.credentialId,
        metadata: { workerId: credential.workerId, last4: credential.last4 },
        createdAt: input.revokedAt,
      })
      return credential
    })
  }

  async recordHeartbeat(input: RecordManagedWorkerHeartbeatInput): Promise<ManagedWorkerHeartbeatRecord> {
    const now = nowIso(input.now)
    const worker = await this.getWorker(input.orgId, input.workerId)
    if (!worker) throw new Error(`Managed worker ${input.workerId} is not registered.`)
    const credential = await this.maybeOne(
      `SELECT * FROM cloud_worker_credentials
       WHERE org_id = $1 AND worker_id = $2 AND credential_id = $3
         AND revoked_at IS NULL AND expires_at > $4`,
      [input.orgId, input.workerId, input.credentialId, now],
    )
    if (!credential) throw new Error('Managed worker credential is invalid, expired, or revoked.')
    if (worker.status === 'revoked' || worker.status === 'retired') {
      throw new Error(`Managed worker ${worker.workerId} cannot heartbeat while ${worker.status}.`)
    }
    const version = input.version === undefined
      ? worker.version
      : normalizeNullableText(input.version, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker version')
    const capabilities = input.capabilities === undefined
      ? worker.capabilities
      : normalizeMetadata(input.capabilities, 'Managed worker capabilities')
    const currentLoad = normalizeNonNegativeInteger(input.currentLoad || 0, 'Managed worker current load')
    const lastErrorCode = input.lastErrorCode === undefined
      ? worker.lastErrorCode
      : normalizeNullableText(input.lastErrorCode, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker error code')
    const lastErrorSummary = input.lastErrorSummary === undefined
      ? worker.lastErrorSummary
      : input.lastErrorSummary
        ? redactOperationalText(input.lastErrorSummary, 1024, 'Managed worker error summary')
        : null
    const activeWorkIds = normalizeIdList(input.activeWorkIds || [], 'Managed worker active work ids', 500)
    const heartbeatSequence = input.heartbeatSequence === undefined || input.heartbeatSequence === null
      ? null
      : normalizeNonNegativeInteger(input.heartbeatSequence, 'Managed worker heartbeat sequence')
    return this.options.withTransaction(async (client) => {
      await client.query(
        `UPDATE cloud_managed_workers
         SET version = $3,
             capabilities = $4::jsonb,
             current_load = $5,
             last_error_code = $6,
             last_error_summary = $7,
             last_heartbeat_at = $8,
             updated_at = $8
         WHERE org_id = $1 AND worker_id = $2`,
        [input.orgId, input.workerId, version, JSON.stringify(capabilities), currentLoad, lastErrorCode, lastErrorSummary, now],
      )
      await client.query(
        `UPDATE cloud_worker_credentials
         SET last_used_at = $3, updated_at = $3
         WHERE org_id = $1 AND credential_id = $2`,
        [input.orgId, input.credentialId, now],
      )
      const result = await client.query(
        `INSERT INTO cloud_managed_worker_heartbeats (
          worker_id, org_id, tenant_id, pool_id, version, capabilities, current_load,
          active_work_ids, last_error_code, last_error_summary, heartbeat_sequence, received_at
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $12)
         ON CONFLICT (worker_id) DO UPDATE
         SET version = EXCLUDED.version,
             capabilities = EXCLUDED.capabilities,
             current_load = EXCLUDED.current_load,
             active_work_ids = EXCLUDED.active_work_ids,
             last_error_code = EXCLUDED.last_error_code,
             last_error_summary = EXCLUDED.last_error_summary,
             heartbeat_sequence = EXCLUDED.heartbeat_sequence,
             received_at = EXCLUDED.received_at
         RETURNING *`,
        [
          input.workerId,
          input.orgId,
          worker.tenantId,
          worker.poolId,
          version,
          JSON.stringify(capabilities),
          currentLoad,
          JSON.stringify(activeWorkIds),
          lastErrorCode,
          lastErrorSummary,
          heartbeatSequence,
          now,
        ],
      )
      return managedWorkerHeartbeatFromRow(result.rows[0]!)
    })
  }

  async listHeartbeats(orgId: string, input: { workerId?: string | null, limit?: number | null } = {}) {
    const result = await this.options.pool.query(
      `SELECT * FROM cloud_managed_worker_heartbeats
       WHERE org_id = $1 AND ($2::text IS NULL OR worker_id = $2)
       ORDER BY received_at DESC
       LIMIT $3`,
      [orgId, input.workerId || null, normalizeListLimit(input.limit, 100, 500)],
    )
    return result.rows.map(managedWorkerHeartbeatFromRow)
  }

  private async one<Row extends QueryRow = QueryRow>(
    text: string,
    values?: unknown[],
    executor: PgExecutor = this.options.pool,
  ) {
    const result = await executor.query<Row>(text, values)
    if (!result.rows[0]) throw new Error('Expected query to return a row.')
    return result.rows[0]
  }

  private async maybeOne<Row extends QueryRow = QueryRow>(
    text: string,
    values?: unknown[],
    executor: PgExecutor = this.options.pool,
  ) {
    const result = await executor.query<Row>(text, values)
    return result.rows[0] || null
  }

  private async recordHeartbeatRejected(
    executor: PgExecutor,
    credential: ManagedWorkerCredentialRecord,
    reason: string,
    now: Date,
  ) {
    await this.options.recordAuditEvent(executor, {
      orgId: credential.orgId,
      actorType: 'system',
      actorId: credential.workerId,
      eventType: 'managed_worker_heartbeat.rejected',
      targetType: 'managed_worker',
      targetId: credential.workerId,
      metadata: {
        credentialId: credential.credentialId,
        poolId: credential.poolId,
        reason,
        last4: credential.last4,
      },
      createdAt: now,
    })
  }
}

function nowIso(now: Date | undefined) {
  return (now || new Date()).toISOString()
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, entry]) => `${JSON.stringify(field)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function normalizeListLimit(value: number | null | undefined, fallback = 100, max = 500) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(max, Math.floor(value || fallback)))
}

function normalizeNullablePositiveInteger(value: number | null | undefined, label: string): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`)
  return value
}

function normalizePoolMode(value: ManagedWorkerPoolMode): ManagedWorkerPoolMode {
  if (!MANAGED_WORKER_SUPPORTED_POOL_MODES.has(value)) {
    throw new Error(`Managed worker pool mode ${value} is not supported in v1.`)
  }
  return value
}

function normalizePoolStatus(value: ManagedWorkerPoolStatus | undefined): ManagedWorkerPoolStatus {
  if (!value) return 'active'
  if (value === 'active' || value === 'paused' || value === 'retired') return value
  throw new Error(`Unsupported managed worker pool status ${String(value)}.`)
}

function normalizeWorkerStatus(value: ManagedWorkerStatus | undefined): ManagedWorkerStatus {
  if (!value) return 'pending'
  if (
    value === 'pending'
    || value === 'active'
    || value === 'draining'
    || value === 'paused'
    || value === 'retired'
    || value === 'revoked'
    || value === 'unhealthy'
  ) return value
  throw new Error(`Unsupported managed worker status ${String(value)}.`)
}

function assertWorkerStatusTransition(from: ManagedWorkerStatus, to: ManagedWorkerStatus) {
  if (from === to) return
  const allowed: Record<ManagedWorkerStatus, ManagedWorkerStatus[]> = {
    pending: ['active', 'revoked'],
    active: ['draining', 'paused', 'unhealthy', 'retired', 'revoked'],
    draining: ['active', 'retired', 'revoked', 'unhealthy'],
    paused: ['active', 'retired', 'revoked'],
    unhealthy: ['active', 'draining', 'retired', 'revoked'],
    retired: [],
    revoked: [],
  }
  if (!allowed[from].includes(to)) throw new Error(`Invalid managed worker transition from ${from} to ${to}.`)
}

function normalizeCredentialScopes(scopes: ManagedWorkerCredentialScope[] | undefined): ManagedWorkerCredentialScope[] {
  const normalized = [...new Set(scopes?.length ? scopes : ['heartbeat'])]
  if (normalized.some((scope) => scope !== 'heartbeat')) throw new Error('Managed worker credential scope is unsupported.')
  return normalized as ManagedWorkerCredentialScope[]
}

function randomRecordId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${randomBytes(8).toString('base64url')}`
}

function normalizeMetadata(value: Record<string, unknown> | undefined, label: string) {
  return normalizeRecord(value || {}, label, MANAGED_WORKER_METADATA_MAX_BYTES)
}

function normalizeRecord(value: unknown, label: string, maxBytes: number): Record<string, unknown> {
  const record = jsonRecord(value)
  const serialized = stableJson(record)
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  }
  return record
}

function normalizeText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`)
  return normalized
}

function normalizeNullableText(value: unknown, maxLength: number, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return normalizeText(value, maxLength, label)
}

function normalizeNonNegativeInteger(value: unknown, label: string) {
  const parsed = Number(value ?? 0)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer.`)
  return parsed
}

function normalizeIdList(values: readonly unknown[], label: string, maxLength: number) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`)
  if (values.length > maxLength) throw new Error(`${label} exceeds ${maxLength} entries.`)
  return [...new Set(values.map((value) => normalizeText(value, 256, label)))]
}

