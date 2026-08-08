import {
  artifactUploadPublicationMetadataEqual,
  normalizeArtifactUploadPublicationMetadata,
} from '../artifact-upload-publication.ts'
import type {
  ArtifactUploadReconciliationClaim,
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
import { quotaWindowStart } from './usage-quota.ts'
import {
  clone,
  key,
  normalizeNonNegativeInteger,
  nowIso,
} from './store-helpers.ts'

type UsageQuotaAdjustment = {
  orgId: string
  quotaKey: string
  windowStartedAtMs: number
  quantityDelta: number
}

type InMemoryArtifactUploadReservationsHost = {
  orgExists(orgId: string): boolean
  requireSession(tenantId: string, sessionId: string): void
  consumeUsageQuota(input: ConsumeUsageQuotaInput): QuotaConsumptionRecord
  adjustUsageQuota(input: UsageQuotaAdjustment): void
}

function reservationKey(orgId: string, tenantId: string, sessionId: string, artifactId: string) {
  return key(orgId, tenantId, sessionId, artifactId)
}

export class InMemoryArtifactUploadReservationsDomain {
  private readonly reservations = new Map<string, ArtifactUploadReservationRecord>()
  private readonly host: InMemoryArtifactUploadReservationsHost

  constructor(host: InMemoryArtifactUploadReservationsHost) {
    this.host = host
  }

  create(input: CreateArtifactUploadReservationInput): {
    reservation: ArtifactUploadReservationRecord | null
    quota: QuotaConsumptionRecord | null
  } {
    if (!this.host.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    this.host.requireSession(input.tenantId, input.sessionId)
    const publication = normalizeArtifactUploadPublicationMetadata(input.publication)
    const recordKey = reservationKey(input.orgId, input.tenantId, input.sessionId, input.artifactId)
    const existing = this.reservations.get(recordKey)
    if (existing) {
      const immutableReplayMatches = existing.userId === input.userId
        && existing.stagingObjectKey === (input.stagingObjectKey || input.objectKey)
        && existing.finalObjectKey === (input.finalObjectKey || input.objectKey)
        && existing.filename === input.filename
        && existing.contentType === (input.contentType || null)
        && existing.checksumSha256 === (input.checksumSha256 || null)
        && artifactUploadPublicationMetadataEqual(existing.publication, publication)
        && existing.reservedBytes === normalizeNonNegativeInteger(input.reservedBytes, 'Reserved artifact bytes')
      if (!immutableReplayMatches) {
        throw new Error('Artifact upload idempotency key conflicts with an existing reservation.')
      }
      return { reservation: clone(existing), quota: null }
    }
    const quota = input.quota ? this.host.consumeUsageQuota(input.quota) : null
    if (quota && !quota.allowed) return { reservation: null, quota }
    const now = input.createdAt || input.quota?.now || new Date()
    const expiresAt = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt)
    const quotaWindowMs = input.quota?.windowMs ?? null
    const quotaWindowStartedAtMs = input.quota
      ? quotaWindowStart((input.quota.now || now).getTime(), input.quota.windowMs)
      : null
    const reservation: ArtifactUploadReservationRecord = {
      orgId: input.orgId,
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      artifactId: input.artifactId,
      objectKey: input.objectKey,
      stagingObjectKey: input.stagingObjectKey || input.objectKey,
      finalObjectKey: input.finalObjectKey || input.objectKey,
      filename: input.filename,
      contentType: input.contentType || null,
      checksumSha256: input.checksumSha256 || null,
      stagingCleanedAt: null,
      publication,
      quotaKey: input.quota?.quotaKey ?? null,
      quotaWindowMs,
      quotaWindowStartedAtMs,
      reservedBytes: normalizeNonNegativeInteger(input.reservedBytes, 'Reserved artifact bytes'),
      status: 'reserved',
      cleanupReason: null,
      cleanupRequestedAt: null,
      claimOwner: null,
      claimToken: null,
      claimExpiresAt: null,
      cleanupAttempts: 0,
      cleanupPasses: 0,
      finalizationAttempts: 0,
      nextCleanupAttemptAt: null,
      lastErrorCode: null,
      expiresAt: nowIso(expiresAt),
      createdAt: nowIso(now),
      updatedAt: nowIso(now),
    }
    this.reservations.set(recordKey, reservation)
    return { reservation: clone(reservation), quota }
  }

  get(input: {
    orgId: string
    tenantId: string
    sessionId: string
    artifactId: string
  }): ArtifactUploadReservationRecord | null {
    const reservation = this.reservations.get(reservationKey(
      input.orgId,
      input.tenantId,
      input.sessionId,
      input.artifactId,
    ))
    return reservation ? clone(reservation) : null
  }

  claimFinalization(input: ClaimArtifactUploadFinalizationInput): ArtifactUploadReservationRecord | null {
    const recordKey = reservationKey(input.orgId, input.tenantId, input.sessionId, input.artifactId)
    const reservation = this.reservations.get(recordKey)
    if (!reservation) return null
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const sameClaim = reservation.status === 'finalizing'
      && reservation.claimOwner === input.claimOwner
      && reservation.claimToken === input.claimToken
    const claimAvailable = reservation.status === 'reserved'
      || (reservation.status === 'finalizing'
        && (!reservation.claimExpiresAt || Date.parse(reservation.claimExpiresAt) <= nowMs)
        && (!reservation.nextCleanupAttemptAt || Date.parse(reservation.nextCleanupAttemptAt) <= nowMs))
    if (!sameClaim && !claimAvailable) return null
    if (reservation.status === 'reserved' && Date.parse(reservation.expiresAt) <= nowMs) return null
    const claimed: ArtifactUploadReservationRecord = {
      ...reservation,
      status: 'finalizing',
      claimOwner: input.claimOwner,
      claimToken: input.claimToken,
      claimExpiresAt: new Date(nowMs + Math.max(1, Math.floor(input.claimTtlMs))).toISOString(),
      lastErrorCode: null,
      updatedAt: nowIso(now),
    }
    this.reservations.set(recordKey, claimed)
    return clone(claimed)
  }

  completeFinalization(input: CompleteArtifactUploadFinalizationInput): ArtifactUploadReservationRecord | null {
    const recordKey = reservationKey(input.orgId, input.tenantId, input.sessionId, input.artifactId)
    const reservation = this.reservations.get(recordKey)
    if (!reservation) return null
    if (reservation.status === 'finalized') return clone(reservation)
    if (
      reservation.status !== 'finalizing'
      || reservation.claimOwner !== input.claimOwner
      || reservation.claimToken !== input.claimToken
    ) return null
    const finalized: ArtifactUploadReservationRecord = {
      ...reservation,
      status: 'finalized',
      claimOwner: null,
      claimToken: null,
      claimExpiresAt: null,
      nextCleanupAttemptAt: null,
      lastErrorCode: null,
      updatedAt: nowIso(input.now),
    }
    this.reservations.set(recordKey, finalized)
    return clone(finalized)
  }

  releaseClaim(input: ReleaseArtifactUploadClaimInput): ArtifactUploadReservationRecord | null {
    const recordKey = reservationKey(input.orgId, input.tenantId, input.sessionId, input.artifactId)
    const reservation = this.reservations.get(recordKey)
    if (!reservation) return null
    if (
      reservation.status !== 'finalizing'
      || reservation.claimOwner !== input.claimOwner
      || reservation.claimToken !== input.claimToken
    ) return clone(reservation)
    const now = input.now || new Date()
    const finalizationAttempts = reservation.finalizationAttempts + 1
    const exhausted = input.cleanupOnExhaustion !== false
      && finalizationAttempts >= Math.max(1, Math.floor(input.maxAttempts))
    const cleanupNotBefore = input.cleanupNotBefore instanceof Date
      ? input.cleanupNotBefore
      : new Date(input.cleanupNotBefore)
    const released: ArtifactUploadReservationRecord = {
      ...reservation,
      status: exhausted ? 'cleanup_pending' : reservation.status,
      cleanupReason: exhausted ? reservation.cleanupReason || 'failed' : reservation.cleanupReason,
      cleanupRequestedAt: exhausted ? reservation.cleanupRequestedAt || nowIso(now) : reservation.cleanupRequestedAt,
      claimOwner: null,
      claimToken: null,
      claimExpiresAt: null,
      finalizationAttempts,
      nextCleanupAttemptAt: exhausted
        ? new Date(Math.max(now.getTime(), cleanupNotBefore.getTime())).toISOString()
        : nowIso(input.retryAt instanceof Date ? input.retryAt : new Date(input.retryAt)),
      lastErrorCode: input.errorCode,
      updatedAt: nowIso(now),
    }
    this.reservations.set(recordKey, released)
    return clone(released)
  }

  requestCleanup(input: RequestArtifactUploadCleanupInput): ArtifactUploadReservationRecord | null {
    const recordKey = reservationKey(input.orgId, input.tenantId, input.sessionId, input.artifactId)
    const reservation = this.reservations.get(recordKey)
    if (!reservation) return null
    if (reservation.status === 'cleaned' || reservation.status === 'finalized') return clone(reservation)
    const now = input.now || new Date()
    const nowMs = now.getTime()
    if (reservation.status === 'cleanup_pending') {
      const sameClaim = reservation.claimOwner === input.claimOwner
        && reservation.claimToken === input.claimToken
      const claimIsActive = reservation.claimOwner !== null
        && reservation.claimToken !== null
        && reservation.claimExpiresAt !== null
        && Date.parse(reservation.claimExpiresAt) > nowMs
      const retryIsDue = reservation.nextCleanupAttemptAt === null
        || Date.parse(reservation.nextCleanupAttemptAt) <= nowMs
      if (sameClaim || claimIsActive || !retryIsDue) return clone(reservation)
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
    const deferCleanup = cleanupNotBefore !== null && cleanupNotBefore.getTime() > nowMs
    const cleanupPending: ArtifactUploadReservationRecord = {
      ...reservation,
      status: 'cleanup_pending',
      cleanupReason: reservation.cleanupReason || input.reason,
      cleanupRequestedAt: reservation.cleanupRequestedAt || nowIso(now),
      claimOwner: deferCleanup ? null : input.claimOwner,
      claimToken: deferCleanup ? null : input.claimToken,
      claimExpiresAt: deferCleanup
        ? null
        : new Date(now.getTime() + Math.max(1, Math.floor(input.claimTtlMs))).toISOString(),
      nextCleanupAttemptAt: deferCleanup ? nowIso(cleanupNotBefore) : null,
      lastErrorCode: null,
      updatedAt: nowIso(now),
    }
    this.reservations.set(recordKey, cleanupPending)
    return clone(cleanupPending)
  }

  deferCleanup(input: DeferArtifactUploadCleanupInput): ArtifactUploadReservationRecord | null {
    const recordKey = reservationKey(input.orgId, input.tenantId, input.sessionId, input.artifactId)
    const reservation = this.reservations.get(recordKey)
    if (!reservation) return null
    if (reservation.status !== 'cleanup_pending' && reservation.status !== 'finalized') return null
    if (reservation.claimOwner !== input.claimOwner || reservation.claimToken !== input.claimToken) return null
    const deferred: ArtifactUploadReservationRecord = {
      ...reservation,
      claimOwner: null,
      claimToken: null,
      claimExpiresAt: null,
      cleanupPasses: reservation.cleanupPasses + 1,
      nextCleanupAttemptAt: nowIso(input.retryAt instanceof Date ? input.retryAt : new Date(input.retryAt)),
      lastErrorCode: null,
      updatedAt: nowIso(input.now),
    }
    this.reservations.set(recordKey, deferred)
    return clone(deferred)
  }

  completeCleanup(input: CompleteArtifactUploadCleanupInput): ArtifactUploadReservationRecord | null {
    const recordKey = reservationKey(input.orgId, input.tenantId, input.sessionId, input.artifactId)
    const reservation = this.reservations.get(recordKey)
    if (!reservation) return null
    if (reservation.status === 'cleaned') return clone(reservation)
    if (reservation.status !== 'cleanup_pending' && reservation.status !== 'finalized') return null
    if (reservation.claimOwner !== input.claimOwner || reservation.claimToken !== input.claimToken) return null
    if (reservation.cleanupPasses < 1) return null
    if (reservation.status === 'finalized') {
      const stagingCleaned: ArtifactUploadReservationRecord = {
        ...reservation,
        stagingCleanedAt: nowIso(input.now),
        claimOwner: null,
        claimToken: null,
        claimExpiresAt: null,
        nextCleanupAttemptAt: null,
        lastErrorCode: null,
        updatedAt: nowIso(input.now),
      }
      this.reservations.set(recordKey, stagingCleaned)
      return clone(stagingCleaned)
    }
    if (reservation.quotaKey && reservation.quotaWindowStartedAtMs !== null) {
      this.host.adjustUsageQuota({
        orgId: reservation.orgId,
        quotaKey: reservation.quotaKey,
        windowStartedAtMs: reservation.quotaWindowStartedAtMs,
        quantityDelta: -reservation.reservedBytes,
      })
    }
    const cleaned: ArtifactUploadReservationRecord = {
      ...reservation,
      status: 'cleaned',
      claimOwner: null,
      claimToken: null,
      claimExpiresAt: null,
      nextCleanupAttemptAt: null,
      lastErrorCode: null,
      updatedAt: nowIso(input.now),
    }
    this.reservations.set(recordKey, cleaned)
    return clone(cleaned)
  }

  failCleanup(input: FailArtifactUploadCleanupInput): ArtifactUploadReservationRecord | null {
    const recordKey = reservationKey(input.orgId, input.tenantId, input.sessionId, input.artifactId)
    const reservation = this.reservations.get(recordKey)
    if (!reservation) return null
    if (reservation.status !== 'cleanup_pending' && reservation.status !== 'finalized') return clone(reservation)
    if (reservation.claimOwner !== input.claimOwner || reservation.claimToken !== input.claimToken) {
      return clone(reservation)
    }
    const failed: ArtifactUploadReservationRecord = {
      ...reservation,
      claimOwner: null,
      claimToken: null,
      claimExpiresAt: null,
      cleanupAttempts: reservation.cleanupAttempts + 1,
      nextCleanupAttemptAt: nowIso(input.retryAt instanceof Date ? input.retryAt : new Date(input.retryAt)),
      lastErrorCode: input.errorCode,
      updatedAt: nowIso(input.now),
    }
    this.reservations.set(recordKey, failed)
    return clone(failed)
  }

  claimReconciliation(input: ClaimArtifactUploadReconciliationInput): ArtifactUploadReconciliationClaim[] {
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const limit = Math.max(0, Math.floor(input.limit))
    if (limit === 0) return []
    const claims: ArtifactUploadReconciliationClaim[] = []
    const reservations = [...this.reservations.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))

    for (const [recordKey, reservation] of reservations) {
      if (claims.length >= limit) break
      const claimIsActive = reservation.claimOwner !== null
        && reservation.claimToken !== null
        && reservation.claimExpiresAt !== null
        && Date.parse(reservation.claimExpiresAt) > nowMs
      const retryIsDue = reservation.nextCleanupAttemptAt === null
        || Date.parse(reservation.nextCleanupAttemptAt) <= nowMs
      const isExpired = Date.parse(reservation.expiresAt) <= nowMs

      if (reservation.status === 'cleanup_pending') {
        if (claimIsActive || !retryIsDue) continue
        const claimed: ArtifactUploadReservationRecord = {
          ...reservation,
          claimOwner: input.claimOwner,
          claimToken: input.claimToken,
          claimExpiresAt: new Date(nowMs + Math.max(1, Math.floor(input.claimTtlMs))).toISOString(),
          updatedAt: nowIso(now),
        }
        this.reservations.set(recordKey, claimed)
        claims.push({ action: 'cleanup', reservation: clone(claimed) })
        continue
      }

      if (reservation.status === 'finalized') {
        if (reservation.stagingCleanedAt || !isExpired || claimIsActive || !retryIsDue) continue
        const claimed: ArtifactUploadReservationRecord = {
          ...reservation,
          claimOwner: input.claimOwner,
          claimToken: input.claimToken,
          claimExpiresAt: new Date(nowMs + Math.max(1, Math.floor(input.claimTtlMs))).toISOString(),
          updatedAt: nowIso(now),
        }
        this.reservations.set(recordKey, claimed)
        claims.push({ action: 'cleanup_staging', reservation: clone(claimed) })
        continue
      }

      if (reservation.status === 'reserved' && !isExpired) continue
      if (reservation.status === 'finalizing' && (claimIsActive || !retryIsDue)) continue
      if (reservation.status !== 'reserved' && reservation.status !== 'finalizing') continue

      const claimed: ArtifactUploadReservationRecord = {
        ...reservation,
        status: 'finalizing',
        claimOwner: input.claimOwner,
        claimToken: input.claimToken,
        claimExpiresAt: new Date(nowMs + Math.max(1, Math.floor(input.claimTtlMs))).toISOString(),
        updatedAt: nowIso(now),
      }
      this.reservations.set(recordKey, claimed)
      claims.push({ action: 'finalize', reservation: clone(claimed) })
    }
    return claims
  }

  reconciliationStats(now: Date): ArtifactUploadReconciliationStats {
    const nowMs = now.getTime()
    let pendingCount = 0
    let oldestPendingAtMs = Number.POSITIVE_INFINITY
    for (const reservation of this.reservations.values()) {
      const expiresAtMs = Date.parse(reservation.expiresAt)
      const pendingAtMs = reservation.status === 'cleanup_pending'
        ? Date.parse(reservation.cleanupRequestedAt || reservation.updatedAt)
        : expiresAtMs <= nowMs && (
          reservation.status === 'reserved'
          || reservation.status === 'finalizing'
          || (reservation.status === 'finalized' && reservation.stagingCleanedAt === null)
        )
          ? expiresAtMs
          : null
      if (pendingAtMs === null) continue
      pendingCount += 1
      oldestPendingAtMs = Math.min(oldestPendingAtMs, pendingAtMs)
    }
    return {
      pendingCount: Math.min(Number.MAX_SAFE_INTEGER, pendingCount),
      oldestPendingAgeMs: pendingCount === 0
        ? 0
        : Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, nowMs - oldestPendingAtMs)),
    }
  }

  prune(input: PruneArtifactUploadReservationsInput): number {
    const limit = Math.min(1_000, Math.max(0, Math.floor(input.limit)))
    if (limit === 0) return 0
    const cutoff = input.olderThan.toISOString()
    const terminal = [...this.reservations.entries()]
      .filter(([, reservation]) => (
        reservation.updatedAt < cutoff
        && (
          reservation.status === 'cleaned'
          || (reservation.status === 'finalized' && reservation.stagingCleanedAt !== null)
        )
      ))
      .sort((left, right) => (
        left[1].updatedAt.localeCompare(right[1].updatedAt)
        || left[0].localeCompare(right[0])
      ))
      .slice(0, limit)
    for (const [recordKey] of terminal) this.reservations.delete(recordKey)
    return terminal.length
  }
}
