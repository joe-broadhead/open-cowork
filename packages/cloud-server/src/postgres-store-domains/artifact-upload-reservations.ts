import { nowIso } from '../postgres-store-id-helpers.ts'
import { normalizeNonNegativeInteger, windowStart } from '../postgres-store-normalizers.ts'
import { artifactUploadReservationFromRow } from '../postgres-domains/billing.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'
import type {
  ArtifactUploadReservationRecord,
  ConsumeUsageQuotaInput,
  CreateArtifactUploadReservationInput,
  QuotaConsumptionRecord,
  ReleaseArtifactUploadReservationInput,
  SettleArtifactUploadReservationInput,
} from '../control-plane-store.ts'

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: () => void }

type PostgresArtifactUploadReservationsRepositoryOptions = {
  pool: PgExecutor
  withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T>
  consumeUsageQuota(executor: PgExecutor, input: ConsumeUsageQuotaInput): Promise<QuotaConsumptionRecord>
  adjustUsageQuota(executor: PgExecutor, input: {
    orgId: string
    quotaKey: string
    windowStartedAtMs: number
    quantityDelta: number
  }): Promise<void>
}

// Presigned upload reservations are quota-backed side effects. Keeping them in a
// focused repository makes the transaction boundary explicit: reservation insert,
// quota consume/adjust, settlement, and release all happen on the same client.
export class PostgresArtifactUploadReservationsRepository {
  private readonly options: PostgresArtifactUploadReservationsRepositoryOptions

  constructor(options: PostgresArtifactUploadReservationsRepositoryOptions) {
    this.options = options
  }

  async create(input: CreateArtifactUploadReservationInput): Promise<{
    reservation: ArtifactUploadReservationRecord | null
    quota: QuotaConsumptionRecord | null
  }> {
    return this.options.withTransaction(async (client) => {
      const existing = await this.find(input.orgId, input.tenantId, input.sessionId, input.artifactId, client)
      if (existing) return { reservation: existing, quota: null }
      const now = input.createdAt || input.quota?.now || new Date()
      const quotaNow = input.quota?.now || now
      const quotaWindowMs = input.quota?.windowMs ?? null
      const quotaWindowStartedAtMs = input.quota ? windowStart(quotaNow.getTime(), input.quota.windowMs) : null
      const result = await client.query(
        `INSERT INTO cloud_artifact_upload_reservations (
          org_id, tenant_id, user_id, session_id, artifact_id, object_key, filename,
          content_type, quota_key, quota_window_ms, quota_window_started_at_ms,
          reserved_bytes, settled_bytes, status, expires_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, 'reserved', $13, $14, $14)
        ON CONFLICT (org_id, tenant_id, session_id, artifact_id) DO NOTHING
        RETURNING *`,
        [
          input.orgId,
          input.tenantId,
          input.userId,
          input.sessionId,
          input.artifactId,
          input.objectKey,
          input.filename,
          input.contentType || null,
          input.quota?.quotaKey || null,
          quotaWindowMs,
          quotaWindowStartedAtMs,
          normalizeNonNegativeInteger(input.reservedBytes, 'Reserved artifact bytes'),
          nowIso(input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt)),
          nowIso(now),
        ],
      )
      if (!result.rows[0]) {
        const raced = await this.one(
          `SELECT * FROM cloud_artifact_upload_reservations
           WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4`,
          [input.orgId, input.tenantId, input.sessionId, input.artifactId],
          client,
        )
        return { reservation: artifactUploadReservationFromRow(raced), quota: null }
      }
      const quota = input.quota ? await this.options.consumeUsageQuota(client, input.quota) : null
      if (quota && !quota.allowed) {
        await client.query(
          `DELETE FROM cloud_artifact_upload_reservations
           WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4`,
          [input.orgId, input.tenantId, input.sessionId, input.artifactId],
        )
        return { reservation: null, quota }
      }
      const row = await this.one(
        `SELECT * FROM cloud_artifact_upload_reservations
         WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4`,
        [input.orgId, input.tenantId, input.sessionId, input.artifactId],
        client,
      )
      return { reservation: artifactUploadReservationFromRow(row), quota }
    })
  }

  async get(input: {
    orgId: string
    tenantId: string
    sessionId: string
    artifactId: string
  }): Promise<ArtifactUploadReservationRecord | null> {
    return this.find(input.orgId, input.tenantId, input.sessionId, input.artifactId)
  }

  async settle(input: SettleArtifactUploadReservationInput): Promise<{
    reservation: ArtifactUploadReservationRecord | null
    quota: QuotaConsumptionRecord | null
    settled: boolean
  }> {
    return this.options.withTransaction(async (client) => {
      const reservation = await this.lock(input.orgId, input.tenantId, input.sessionId, input.artifactId, client)
      if (!reservation) return { reservation: null, quota: null, settled: false }
      if (reservation.status !== 'reserved') return { reservation, quota: null, settled: reservation.status === 'settled' }
      const actualBytes = normalizeNonNegativeInteger(input.actualBytes, 'Artifact upload size')
      const delta = actualBytes - reservation.reservedBytes
      const quota = delta > 0 && input.quota
        ? await this.options.consumeUsageQuota(client, { ...input.quota, quantity: delta })
        : null
      if (quota && !quota.allowed) return { reservation, quota, settled: false }
      if (delta < 0 && reservation.quotaKey && reservation.quotaWindowStartedAtMs !== null) {
        await this.options.adjustUsageQuota(client, {
          orgId: reservation.orgId,
          quotaKey: reservation.quotaKey,
          windowStartedAtMs: reservation.quotaWindowStartedAtMs,
          quantityDelta: delta,
        })
      }
      const now = nowIso(input.now)
      const result = await client.query(
        `UPDATE cloud_artifact_upload_reservations
         SET status = 'settled', settled_bytes = $5, updated_at = $6
         WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4
         RETURNING *`,
        [input.orgId, input.tenantId, input.sessionId, input.artifactId, actualBytes, now],
      )
      return { reservation: artifactUploadReservationFromRow(result.rows[0]!), quota, settled: true }
    })
  }

  async release(input: ReleaseArtifactUploadReservationInput): Promise<ArtifactUploadReservationRecord | null> {
    return this.options.withTransaction(async (client) => {
      const reservation = await this.lock(input.orgId, input.tenantId, input.sessionId, input.artifactId, client)
      if (!reservation) return null
      if (reservation.status === 'reserved' && reservation.quotaKey && reservation.quotaWindowStartedAtMs !== null) {
        await this.options.adjustUsageQuota(client, {
          orgId: reservation.orgId,
          quotaKey: reservation.quotaKey,
          windowStartedAtMs: reservation.quotaWindowStartedAtMs,
          quantityDelta: -reservation.reservedBytes,
        })
      }
      const result = await client.query(
        `UPDATE cloud_artifact_upload_reservations
         SET status = CASE WHEN status = 'reserved' THEN $5 ELSE status END,
             updated_at = $6
         WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4
         RETURNING *`,
        [input.orgId, input.tenantId, input.sessionId, input.artifactId, input.status, nowIso(input.now)],
      )
      return result.rows[0] ? artifactUploadReservationFromRow(result.rows[0]) : null
    })
  }

  private async find(
    orgId: string,
    tenantId: string,
    sessionId: string,
    artifactId: string,
    executor: PgExecutor = this.options.pool,
  ): Promise<ArtifactUploadReservationRecord | null> {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_artifact_upload_reservations
       WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4`,
      [orgId, tenantId, sessionId, artifactId],
      executor,
    )
    return row ? artifactUploadReservationFromRow(row) : null
  }

  private async lock(
    orgId: string,
    tenantId: string,
    sessionId: string,
    artifactId: string,
    executor: PgExecutor,
  ): Promise<ArtifactUploadReservationRecord | null> {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_artifact_upload_reservations
       WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4
       FOR UPDATE`,
      [orgId, tenantId, sessionId, artifactId],
      executor,
    )
    return row ? artifactUploadReservationFromRow(row) : null
  }

  private async one<Row extends QueryRow = QueryRow>(text: string, values?: unknown[], executor: PgExecutor = this.options.pool) {
    const result = await executor.query<Row>(text, values)
    if (!result.rows[0]) throw new Error('Expected query to return a row.')
    return result.rows[0]
  }

  private async maybeOne<Row extends QueryRow = QueryRow>(text: string, values?: unknown[], executor: PgExecutor = this.options.pool) {
    const result = await executor.query<Row>(text, values)
    return result.rows[0] || null
  }
}
