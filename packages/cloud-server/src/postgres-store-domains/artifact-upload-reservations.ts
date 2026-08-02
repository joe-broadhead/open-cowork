import { nowIso } from '../postgres-store-id-helpers.ts'
import { normalizeNonNegativeInteger, windowStart } from '../postgres-store-normalizers.ts'
import { artifactUploadReservationFromRow } from '../postgres-domains/billing.ts'
import {
  artifactUploadPublicationMetadataEqual,
  normalizeArtifactUploadPublicationMetadata,
} from '../artifact-upload-publication.ts'
import type { QueryResult, QueryRow } from '../postgres-domains/shared.ts'
import type {
  ArtifactUploadReconciliationClaim,
  ArtifactUploadPublicationMetadata,
  ArtifactUploadReconciliationStats,
  ArtifactUploadReservationRecord,
  ClaimArtifactUploadFinalizationInput,
  ClaimArtifactUploadReconciliationInput,
  CompleteArtifactUploadCleanupInput,
  CompleteArtifactUploadFinalizationInput,
  ConsumeUsageQuotaInput,
  CreateArtifactUploadReservationInput,
  DeferArtifactUploadCleanupInput,
  FailArtifactUploadCleanupInput,
  PruneArtifactUploadReservationsInput,
  QuotaConsumptionRecord,
  ReleaseArtifactUploadClaimInput,
  RequestArtifactUploadCleanupInput,
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

export class PostgresArtifactUploadReservationsRepository {
  private readonly options: PostgresArtifactUploadReservationsRepositoryOptions

  constructor(options: PostgresArtifactUploadReservationsRepositoryOptions) {
    this.options = options
  }

  async create(input: CreateArtifactUploadReservationInput): Promise<{
    reservation: ArtifactUploadReservationRecord | null
    quota: QuotaConsumptionRecord | null
  }> {
    const publication = normalizeArtifactUploadPublicationMetadata(input.publication)
    return this.options.withTransaction(async (client) => {
      const existing = await this.find(input.orgId, input.tenantId, input.sessionId, input.artifactId, client)
      if (existing) {
        assertArtifactUploadReplay(existing, input, publication)
        return { reservation: existing, quota: null }
      }
      const now = input.createdAt || input.quota?.now || new Date()
      const quotaNow = input.quota?.now || now
      const quotaWindowMs = input.quota?.windowMs ?? null
      const quotaWindowStartedAtMs = input.quota ? windowStart(quotaNow.getTime(), input.quota.windowMs) : null
      const result = await client.query(
        `INSERT INTO cloud_artifact_upload_reservations (
          org_id, tenant_id, user_id, session_id, artifact_id, object_key,
          staging_object_key, final_object_key, filename, content_type, checksum_sha256,
          publication_metadata, quota_key, quota_window_ms, quota_window_started_at_ms, reserved_bytes,
          status, staging_cleaned_at, cleanup_reason, cleanup_requested_at, claim_owner,
          claim_token, claim_expires_at, cleanup_attempts, next_cleanup_attempt_at,
          last_error_code, expires_at, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, 'reserved', NULL, NULL, NULL, NULL,
          NULL, NULL, 0, NULL, NULL, $17, $18, $18
        )
        ON CONFLICT (org_id, tenant_id, session_id, artifact_id) DO NOTHING
        RETURNING *`,
        [
          input.orgId,
          input.tenantId,
          input.userId,
          input.sessionId,
          input.artifactId,
          input.objectKey,
          input.stagingObjectKey || input.objectKey,
          input.finalObjectKey || input.objectKey,
          input.filename,
          input.contentType || null,
          input.checksumSha256 || null,
          JSON.stringify(publication),
          input.quota?.quotaKey || null,
          quotaWindowMs,
          quotaWindowStartedAtMs,
          normalizeNonNegativeInteger(input.reservedBytes, 'Reserved artifact bytes'),
          nowIso(input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt)),
          nowIso(now),
        ],
      )
      if (!result.rows[0]) {
        const raced = await this.find(input.orgId, input.tenantId, input.sessionId, input.artifactId, client)
        if (!raced) throw new Error('Artifact upload reservation conflict did not resolve to a row.')
        assertArtifactUploadReplay(raced, input, publication)
        return { reservation: raced, quota: null }
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
      return {
        reservation: artifactUploadReservationFromRow(result.rows[0]),
        quota,
      }
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

  async claimFinalization(input: ClaimArtifactUploadFinalizationInput): Promise<ArtifactUploadReservationRecord | null> {
    return this.options.withTransaction(async (client) => {
      const reservation = await this.lockIdentity(input, client)
      if (!reservation) return null
      const now = input.now || new Date()
      const sameClaim = reservation.status === 'finalizing'
        && reservation.claimOwner === input.claimOwner
        && reservation.claimToken === input.claimToken
      const claimAvailable = reservation.status === 'reserved'
        || (reservation.status === 'finalizing'
          && (!reservation.claimExpiresAt || Date.parse(reservation.claimExpiresAt) <= now.getTime())
          && (!reservation.nextCleanupAttemptAt || Date.parse(reservation.nextCleanupAttemptAt) <= now.getTime()))
      if (!sameClaim && !claimAvailable) return null
      if (reservation.status === 'reserved' && Date.parse(reservation.expiresAt) <= now.getTime()) return null
      return this.updateOne(
        `UPDATE cloud_artifact_upload_reservations
         SET status = 'finalizing', claim_owner = $5, claim_token = $6,
             claim_expires_at = $7, last_error_code = NULL, updated_at = $8
         WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4
         RETURNING *`,
        [
          input.orgId, input.tenantId, input.sessionId, input.artifactId,
          input.claimOwner, input.claimToken,
          new Date(now.getTime() + normalizedTtl(input.claimTtlMs)).toISOString(), nowIso(now),
        ],
        client,
      )
    })
  }

  async completeFinalization(input: CompleteArtifactUploadFinalizationInput): Promise<ArtifactUploadReservationRecord | null> {
    return this.options.withTransaction(async (client) => {
      const reservation = await this.lockIdentity(input, client)
      if (!reservation) return null
      if (reservation.status === 'finalized') return reservation
      if (!hasClaim(reservation, 'finalizing', input.claimOwner, input.claimToken)) return null
      return this.updateOne(
        `UPDATE cloud_artifact_upload_reservations
         SET status = 'finalized',
             claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL,
             next_cleanup_attempt_at = NULL, last_error_code = NULL, updated_at = $5
         WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4
         RETURNING *`,
        [input.orgId, input.tenantId, input.sessionId, input.artifactId, nowIso(input.now)],
        client,
      )
    })
  }

  async releaseClaim(input: ReleaseArtifactUploadClaimInput): Promise<ArtifactUploadReservationRecord | null> {
    return this.options.withTransaction(async (client) => {
      const reservation = await this.lockIdentity(input, client)
      if (!reservation) return null
      if (!hasClaim(reservation, 'finalizing', input.claimOwner, input.claimToken)) return reservation
      const now = input.now || new Date()
      const finalizationAttempts = reservation.finalizationAttempts + 1
      const exhausted = input.cleanupOnExhaustion !== false
        && finalizationAttempts >= Math.max(1, Math.floor(input.maxAttempts))
      const cleanupNotBefore = input.cleanupNotBefore instanceof Date
        ? input.cleanupNotBefore
        : new Date(input.cleanupNotBefore)
      const nextAttemptAt = exhausted
        ? new Date(Math.max(now.getTime(), cleanupNotBefore.getTime()))
        : input.retryAt instanceof Date ? input.retryAt : new Date(input.retryAt)
      return this.updateOne(
        `UPDATE cloud_artifact_upload_reservations
         SET status = CASE WHEN $5 THEN 'cleanup_pending' ELSE status END,
             cleanup_reason = CASE WHEN $5 THEN COALESCE(cleanup_reason, 'failed') ELSE cleanup_reason END,
             cleanup_requested_at = CASE WHEN $5 THEN COALESCE(cleanup_requested_at, $8) ELSE cleanup_requested_at END,
             claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL,
             finalization_attempts = finalization_attempts + 1,
             next_cleanup_attempt_at = $6, last_error_code = $7, updated_at = $8
         WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4
         RETURNING *`,
        [
          input.orgId, input.tenantId, input.sessionId, input.artifactId,
          exhausted, nowIso(nextAttemptAt), input.errorCode, nowIso(now),
        ],
        client,
      )
    })
  }

  async requestCleanup(input: RequestArtifactUploadCleanupInput): Promise<ArtifactUploadReservationRecord | null> {
    return this.options.withTransaction(async (client) => {
      const reservation = await this.lockIdentity(input, client)
      if (!reservation) return null
      if (reservation.status === 'cleaned' || reservation.status === 'finalized') return reservation
      const now = input.now || new Date()
      if (reservation.status === 'cleanup_pending') {
        const sameClaim = reservation.claimOwner === input.claimOwner && reservation.claimToken === input.claimToken
        const claimIsActive = hasActiveClaim(reservation, now)
        const retryIsDue = !reservation.nextCleanupAttemptAt || Date.parse(reservation.nextCleanupAttemptAt) <= now.getTime()
        if (sameClaim || claimIsActive || !retryIsDue) return reservation
      }
      if (
        reservation.status === 'finalizing'
        && (
          reservation.claimOwner !== input.expectedFinalizationClaimOwner
          || reservation.claimToken !== input.expectedFinalizationClaimToken
        )
      ) return null
      const cleanupNotBefore = input.cleanupNotBefore
        ? input.cleanupNotBefore instanceof Date
          ? input.cleanupNotBefore
          : new Date(input.cleanupNotBefore)
        : null
      const deferCleanup = cleanupNotBefore !== null && cleanupNotBefore.getTime() > now.getTime()
      return this.updateOne(
        `UPDATE cloud_artifact_upload_reservations
         SET status = 'cleanup_pending', cleanup_reason = COALESCE(cleanup_reason, $5),
             cleanup_requested_at = COALESCE(cleanup_requested_at, $9),
             claim_owner = $6, claim_token = $7, claim_expires_at = $8,
             next_cleanup_attempt_at = $10, last_error_code = NULL, updated_at = $9
         WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4
         RETURNING *`,
        [
          input.orgId, input.tenantId, input.sessionId, input.artifactId, input.reason,
          deferCleanup ? null : input.claimOwner,
          deferCleanup ? null : input.claimToken,
          deferCleanup ? null : new Date(now.getTime() + normalizedTtl(input.claimTtlMs)).toISOString(),
          nowIso(now), deferCleanup && cleanupNotBefore ? nowIso(cleanupNotBefore) : null,
        ],
        client,
      )
    })
  }

  async deferCleanup(input: DeferArtifactUploadCleanupInput): Promise<ArtifactUploadReservationRecord | null> {
    return this.options.withTransaction(async (client) => {
      const reservation = await this.lockIdentity(input, client)
      if (!reservation) return null
      if (
        (reservation.status !== 'cleanup_pending' && reservation.status !== 'finalized')
        || reservation.claimOwner !== input.claimOwner
        || reservation.claimToken !== input.claimToken
      ) return null
      return this.updateOne(
        `UPDATE cloud_artifact_upload_reservations
         SET claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL,
             cleanup_passes = cleanup_passes + 1, next_cleanup_attempt_at = $5,
             last_error_code = NULL, updated_at = $6
         WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4
         RETURNING *`,
        [
          input.orgId, input.tenantId, input.sessionId, input.artifactId,
          nowIso(input.retryAt instanceof Date ? input.retryAt : new Date(input.retryAt)),
          nowIso(input.now),
        ],
        client,
      )
    })
  }

  async completeCleanup(input: CompleteArtifactUploadCleanupInput): Promise<ArtifactUploadReservationRecord | null> {
    return this.options.withTransaction(async (client) => {
      const reservation = await this.lockIdentity(input, client)
      if (!reservation) return null
      if (reservation.status === 'cleaned') return reservation
      if (
        (reservation.status !== 'cleanup_pending' && reservation.status !== 'finalized')
        || reservation.claimOwner !== input.claimOwner
        || reservation.claimToken !== input.claimToken
      ) return null
      if (reservation.cleanupPasses < 1) return null
      const stagingOnly = reservation.status === 'finalized'
      if (!stagingOnly) await this.refundReservation(client, reservation)
      return this.updateOne(
        `UPDATE cloud_artifact_upload_reservations
         SET status = CASE WHEN $5 THEN status ELSE 'cleaned' END,
             staging_cleaned_at = CASE WHEN $5 THEN $6 ELSE staging_cleaned_at END,
             claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL,
             next_cleanup_attempt_at = NULL, last_error_code = NULL, updated_at = $6
         WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4
         RETURNING *`,
        [input.orgId, input.tenantId, input.sessionId, input.artifactId, stagingOnly, nowIso(input.now)],
        client,
      )
    })
  }

  async failCleanup(input: FailArtifactUploadCleanupInput): Promise<ArtifactUploadReservationRecord | null> {
    return this.options.withTransaction(async (client) => {
      const reservation = await this.lockIdentity(input, client)
      if (!reservation) return null
      if (
        (reservation.status !== 'cleanup_pending' && reservation.status !== 'finalized')
        || reservation.claimOwner !== input.claimOwner
        || reservation.claimToken !== input.claimToken
      ) return reservation
      return this.updateOne(
        `UPDATE cloud_artifact_upload_reservations
         SET claim_owner = NULL, claim_token = NULL, claim_expires_at = NULL,
             cleanup_attempts = cleanup_attempts + 1, next_cleanup_attempt_at = $5,
             last_error_code = $6, updated_at = $7
         WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4
         RETURNING *`,
        [
          input.orgId, input.tenantId, input.sessionId, input.artifactId,
          nowIso(input.retryAt instanceof Date ? input.retryAt : new Date(input.retryAt)),
          input.errorCode, nowIso(input.now),
        ],
        client,
      )
    })
  }

  async claimReconciliation(input: ClaimArtifactUploadReconciliationInput): Promise<ArtifactUploadReconciliationClaim[]> {
    return this.options.withTransaction(async (client) => {
      const now = input.now || new Date()
      const nowValue = nowIso(now)
      const candidates = await client.query(
        `SELECT * FROM cloud_artifact_upload_reservations
         WHERE (
           (status = 'reserved' AND expires_at <= $1)
           OR (status = 'finalizing'
             AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
             AND (next_cleanup_attempt_at IS NULL OR next_cleanup_attempt_at <= $1))
           OR (status = 'cleanup_pending'
             AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
             AND (next_cleanup_attempt_at IS NULL OR next_cleanup_attempt_at <= $1))
           OR (status = 'finalized' AND staging_cleaned_at IS NULL AND expires_at <= $1
             AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
             AND (next_cleanup_attempt_at IS NULL OR next_cleanup_attempt_at <= $1))
         )
         ORDER BY expires_at ASC, org_id ASC, tenant_id ASC, session_id ASC, artifact_id ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [nowValue, Math.min(100, Math.max(0, Math.floor(input.limit)))],
      )
      const claims: ArtifactUploadReconciliationClaim[] = []
      for (const row of candidates.rows) {
        const reservation = artifactUploadReservationFromRow(row)
        if (reservation.status === 'reserved' || reservation.status === 'finalizing') {
          const claimed = await this.claimReconciliationRow(client, reservation, input, now, {
            status: 'finalizing',
            cleanupReason: null,
          })
          claims.push({ action: 'finalize', reservation: claimed })
          continue
        }
        if (reservation.status === 'cleanup_pending') {
          const claimed = await this.claimReconciliationRow(client, reservation, input, now)
          claims.push({ action: 'cleanup', reservation: claimed })
          continue
        }
        if (reservation.status === 'finalized') {
          const claimed = await this.claimReconciliationRow(client, reservation, input, now)
          claims.push({ action: 'cleanup_staging', reservation: claimed })
          continue
        }
        const claimed = await this.claimReconciliationRow(client, reservation, input, now)
        claims.push({ action: 'finalize', reservation: claimed })
      }
      return claims
    })
  }

  async reconciliationStats(now: Date): Promise<ArtifactUploadReconciliationStats> {
    const result = await this.options.pool.query(
      `SELECT COUNT(*)::text AS pending_count,
              MIN(CASE
                WHEN status = 'cleanup_pending' THEN COALESCE(cleanup_requested_at, updated_at)
                ELSE expires_at
              END) AS oldest_pending_at
       FROM cloud_artifact_upload_reservations
       WHERE status = 'cleanup_pending'
          OR (status IN ('reserved', 'finalizing') AND expires_at <= $1)
          OR (status = 'finalized' AND staging_cleaned_at IS NULL AND expires_at <= $1)`,
      [nowIso(now)],
    )
    const row = result.rows[0] || {}
    const pendingCount = boundedNonNegativeNumber(row.pending_count)
    const oldestPendingAtMs = timestampOrNull(row.oldest_pending_at)
    return {
      pendingCount,
      oldestPendingAgeMs: oldestPendingAtMs === null
        ? 0
        : Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, now.getTime() - oldestPendingAtMs)),
    }
  }

  async prune(input: PruneArtifactUploadReservationsInput): Promise<number> {
    const limit = Math.min(1_000, Math.max(0, Math.floor(input.limit)))
    if (limit === 0) return 0
    const result = await this.options.pool.query(
      `DELETE FROM cloud_artifact_upload_reservations
       WHERE ctid IN (
         SELECT ctid FROM cloud_artifact_upload_reservations
         WHERE updated_at < $1
           AND (status = 'cleaned' OR (status = 'finalized' AND staging_cleaned_at IS NOT NULL))
         ORDER BY updated_at, org_id, tenant_id, session_id, artifact_id
         LIMIT $2
       )
       RETURNING artifact_id`,
      [input.olderThan.toISOString(), limit],
    )
    return result.rows.length
  }

  private async claimReconciliationRow(
    client: PgExecutor,
    reservation: ArtifactUploadReservationRecord,
    input: ClaimArtifactUploadReconciliationInput,
    now: Date,
    transition?: {
      status: 'cleanup_pending' | 'finalizing'
      cleanupReason: ArtifactUploadReservationRecord['cleanupReason']
    },
  ) {
    return this.updateOne(
      `UPDATE cloud_artifact_upload_reservations
       SET status = COALESCE($5, status), cleanup_reason = COALESCE(cleanup_reason, $6),
           claim_owner = $7, claim_token = $8, claim_expires_at = $9, updated_at = $10
       WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4
       RETURNING *`,
      [
        reservation.orgId, reservation.tenantId, reservation.sessionId, reservation.artifactId,
        transition?.status || null, transition?.cleanupReason || null,
        input.claimOwner, input.claimToken,
        new Date(now.getTime() + normalizedTtl(input.claimTtlMs)).toISOString(), nowIso(now),
      ],
      client,
    )
  }

  private async refundReservation(client: PgExecutor, reservation: ArtifactUploadReservationRecord) {
    if (!reservation.quotaKey || reservation.quotaWindowStartedAtMs === null) return
    await this.options.adjustUsageQuota(client, {
      orgId: reservation.orgId,
      quotaKey: reservation.quotaKey,
      windowStartedAtMs: reservation.quotaWindowStartedAtMs,
      quantityDelta: -reservation.reservedBytes,
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

  private async lockIdentity(
    input: { orgId: string; tenantId: string; sessionId: string; artifactId: string },
    executor: PgExecutor,
  ) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_artifact_upload_reservations
       WHERE org_id = $1 AND tenant_id = $2 AND session_id = $3 AND artifact_id = $4
       FOR UPDATE`,
      [input.orgId, input.tenantId, input.sessionId, input.artifactId],
      executor,
    )
    return row ? artifactUploadReservationFromRow(row) : null
  }

  private async updateOne(text: string, values: unknown[], executor: PgExecutor) {
    const row = await this.one(text, values, executor)
    return artifactUploadReservationFromRow(row)
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

function hasClaim(
  reservation: ArtifactUploadReservationRecord,
  status: ArtifactUploadReservationRecord['status'],
  owner: string,
  token: string,
) {
  return reservation.status === status && reservation.claimOwner === owner && reservation.claimToken === token
}

function hasActiveClaim(reservation: ArtifactUploadReservationRecord, now: Date) {
  return reservation.claimOwner !== null
    && reservation.claimToken !== null
    && reservation.claimExpiresAt !== null
    && Date.parse(reservation.claimExpiresAt) > now.getTime()
}

function normalizedTtl(value: number) {
  return Math.max(1, Math.floor(value))
}

function boundedNonNegativeNumber(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error('Expected a numeric artifact reconciliation statistic.')
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(parsed)))
}

function timestampOrNull(value: unknown) {
  if (value === null || value === undefined) return null
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value))
  if (!Number.isFinite(parsed)) throw new Error('Expected an artifact reconciliation timestamp.')
  return parsed
}

function assertArtifactUploadReplay(
  reservation: ArtifactUploadReservationRecord,
  input: CreateArtifactUploadReservationInput,
  publication: ArtifactUploadPublicationMetadata,
) {
  const matches = reservation.userId === input.userId
    && reservation.stagingObjectKey === (input.stagingObjectKey || input.objectKey)
    && reservation.finalObjectKey === (input.finalObjectKey || input.objectKey)
    && reservation.filename === input.filename
    && reservation.contentType === (input.contentType || null)
    && reservation.checksumSha256 === (input.checksumSha256 || null)
    && artifactUploadPublicationMetadataEqual(reservation.publication, publication)
    && reservation.reservedBytes === normalizeNonNegativeInteger(input.reservedBytes, 'Reserved artifact bytes')
  if (!matches) throw new Error('Artifact upload idempotency key conflicts with an existing reservation.')
}
