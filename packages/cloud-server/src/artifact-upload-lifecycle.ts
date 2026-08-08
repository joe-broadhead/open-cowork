import { randomUUID } from 'node:crypto'
import type {
  ArtifactUploadReservationIdentity,
  ArtifactUploadReservationRecord,
  ControlPlaneStore,
} from './control-plane-store.ts'

// A successful delete is confirmed only after the provider's longest plausible
// accepted-request completion window. This quarantines a POST that crossed expiry
// in flight and commits after the first delete returned.
export const ARTIFACT_UPLOAD_CLEANUP_CONFIRMATION_HORIZON_MS = 30 * 60 * 1_000
export const ARTIFACT_UPLOAD_MAX_FINALIZATION_ATTEMPTS = 5

export type ArtifactUploadProviderObject = {
  size: number
  contentType: string | null
  checksumSha256: string
  versionToken: string
}

export type ArtifactUploadProviderPort = {
  inspect(key: string): Promise<ArtifactUploadProviderObject | null>
  promote(input: {
    stagingKey: string
    finalKey: string
    expected: ArtifactUploadProviderObject
  }): Promise<void>
  delete(key: string): Promise<void>
}

type ArtifactUploadLifecycleStore = Pick<ControlPlaneStore,
  | 'artifactUploadLifecycleCapability'
  | 'getArtifactUploadReservation'
  | 'claimArtifactUploadFinalization'
  | 'completeArtifactUploadFinalization'
  | 'releaseArtifactUploadClaim'
  | 'requestArtifactUploadCleanup'
  | 'deferArtifactUploadCleanup'
  | 'completeArtifactUploadCleanup'
  | 'failArtifactUploadCleanup'
  | 'claimArtifactUploadReconciliation'
>

export type ArtifactUploadLifecycleOptions = {
  store: ArtifactUploadLifecycleStore
  provider: ArtifactUploadProviderPort
  now?: () => Date
  ids?: { randomUUID(): string }
  onPromoted?: (reservation: ArtifactUploadReservationRecord) => void | Promise<void>
  isPublished?: (reservation: ArtifactUploadReservationRecord) => boolean | Promise<boolean>
}

type PublishedFinalizationRecovery =
  | { outcome: 'finalized', reservation: ArtifactUploadReservationRecord }
  | { outcome: 'not_recoverable' }
  | { outcome: 'defer', error: Error }
  | { outcome: 'repair_failed', error: Error }

export class ArtifactUploadLifecycle {
  private readonly store: ArtifactUploadLifecycleStore
  private readonly provider: ArtifactUploadProviderPort
  private readonly now: () => Date
  private readonly ids: { randomUUID(): string }
  private readonly onPromoted: ((reservation: ArtifactUploadReservationRecord) => void | Promise<void>) | null
  private readonly isPublished: ((reservation: ArtifactUploadReservationRecord) => boolean | Promise<boolean>) | null
  readonly capability: ControlPlaneStore['artifactUploadLifecycleCapability']

  constructor(options: ArtifactUploadLifecycleOptions) {
    this.store = options.store
    this.provider = options.provider
    this.now = options.now || (() => new Date())
    this.ids = options.ids || { randomUUID }
    this.onPromoted = options.onPromoted || null
    this.isPublished = options.isPublished || null
    this.capability = options.store.artifactUploadLifecycleCapability
  }

  async finalize(input: ArtifactUploadReservationIdentity & {
    claimOwner: string
    claimTtlMs: number
  }): Promise<{
    outcome: 'finalized' | 'already_finalized' | 'rejected' | 'in_progress' | 'not_found'
    reservation: ArtifactUploadReservationRecord | null
  }> {
    const existing = await this.store.getArtifactUploadReservation(input)
    if (!existing) return { outcome: 'not_found', reservation: null }
    if (existing.status === 'finalized') {
      if (this.isPublished && !await this.isPublished(existing)) {
        throw new Error('Artifact upload publication does not match its finalized reservation.')
      }
      return { outcome: 'already_finalized', reservation: existing }
    }
    if (existing.status === 'cleanup_pending' || existing.status === 'cleaned') {
      return { outcome: 'rejected', reservation: existing }
    }
    const now = this.now()
    const claimToken = this.ids.randomUUID()
    const claimed = await this.store.claimArtifactUploadFinalization({
      ...input,
      claimToken,
      now,
    })
    if (!claimed) {
      return {
        outcome: 'in_progress',
        reservation: await this.store.getArtifactUploadReservation(input),
      }
    }
    return this.finalizeClaim(claimed, input.claimOwner, claimToken)
  }

  async abort(input: ArtifactUploadReservationIdentity & {
    claimOwner: string
    claimTtlMs: number
  }): Promise<{
    outcome: 'cleanup_pending' | 'cleaned' | 'already_finalized' | 'not_found'
    reservation: ArtifactUploadReservationRecord | null
  }> {
    const existing = await this.store.getArtifactUploadReservation(input)
    if (!existing) return { outcome: 'not_found', reservation: null }
    if (existing.status === 'finalized') {
      return { outcome: 'already_finalized', reservation: existing }
    }
    if (existing.status === 'cleaned') return { outcome: 'cleaned', reservation: existing }
    const claimToken = this.ids.randomUUID()
    const claimed = await this.store.requestArtifactUploadCleanup({
      ...input,
      reason: 'aborted',
      claimToken,
      cleanupNotBefore: existing.expiresAt,
      now: this.now(),
    })
    if (!claimed) {
      return {
        outcome: 'cleanup_pending',
        reservation: await this.store.getArtifactUploadReservation(input),
      }
    }
    if (claimed.status === 'cleaned') return { outcome: 'cleaned', reservation: claimed }
    if (claimed.status === 'finalized') {
      return { outcome: 'already_finalized', reservation: claimed }
    }
    if (claimed.claimOwner !== input.claimOwner || claimed.claimToken !== claimToken) {
      return { outcome: 'cleanup_pending', reservation: claimed }
    }
    try {
      const cleaned = await this.cleanupClaim(claimed, input.claimOwner, claimToken)
      return { outcome: 'cleaned', reservation: cleaned }
    } catch {
      return {
        outcome: 'cleanup_pending',
        reservation: await this.store.getArtifactUploadReservation(input),
      }
    }
  }

  async reconcile(input: {
    claimOwner: string
    claimTtlMs: number
    limit: number
  }): Promise<{ claimed: number; finalized: number; cleaned: number; stagingCleaned: number; failed: number }> {
    const claimToken = this.ids.randomUUID()
    const claims = await this.store.claimArtifactUploadReconciliation({
      ...input,
      claimToken,
      limit: Math.min(100, Math.max(0, Math.floor(input.limit))),
      now: this.now(),
    })
    const stats = { claimed: claims.length, finalized: 0, cleaned: 0, stagingCleaned: 0, failed: 0 }
    for (const claim of claims) {
      try {
        if (claim.action === 'cleanup' || claim.action === 'cleanup_staging') {
          const cleaned = await this.cleanupClaim(
            claim.reservation,
            input.claimOwner,
            claimToken,
            claim.action === 'cleanup_staging' ? 'staging' : 'all',
          )
          if (claim.action === 'cleanup_staging' && cleaned.stagingCleanedAt) stats.stagingCleaned += 1
          if (claim.action === 'cleanup' && cleaned.status === 'cleaned') stats.cleaned += 1
          continue
        }
        const result = await this.finalizeClaim(claim.reservation, input.claimOwner, claimToken)
        if (result.reservation?.status === 'finalized') stats.finalized += 1
        else if (result.reservation?.status === 'cleaned') stats.cleaned += 1
        else stats.failed += 1
      } catch {
        stats.failed += 1
      }
    }
    return stats
  }

  private async finalizeClaim(
    reservation: ArtifactUploadReservationRecord,
    claimOwner: string,
    claimToken: string,
  ): Promise<{
    outcome: 'finalized' | 'rejected'
    reservation: ArtifactUploadReservationRecord | null
  }> {
    const identity = reservationIdentity(reservation)
    const recovered = await this.completePublishedFinalization(
      reservation,
      claimOwner,
      claimToken,
      { repairPublication: true },
    )
    if (recovered.outcome === 'finalized') {
      return { outcome: 'finalized', reservation: recovered.reservation }
    }
    if (recovered.outcome === 'defer' || recovered.outcome === 'repair_failed') {
      await this.releaseFinalizationClaim(reservation, claimOwner, claimToken, {
        cleanupOnExhaustion: recovered.outcome === 'repair_failed',
      })
      throw recovered.error
    }
    let observed: ArtifactUploadProviderObject | null
    try {
      observed = await this.provider.inspect(reservation.stagingObjectKey)
    } catch (error) {
      const publishedAfterProbe = await this.completePublishedFinalization(
        reservation,
        claimOwner,
        claimToken,
        { repairPublication: true },
      )
      if (publishedAfterProbe.outcome === 'finalized') {
        return { outcome: 'finalized', reservation: publishedAfterProbe.reservation }
      }
      const recoveryError = publishedAfterProbe.outcome === 'defer'
        || publishedAfterProbe.outcome === 'repair_failed'
        ? publishedAfterProbe.error
        : asError(error, 'Artifact upload staging inspection failed.')
      await this.releaseFinalizationClaim(reservation, claimOwner, claimToken, {
        cleanupOnExhaustion: publishedAfterProbe.outcome === 'repair_failed',
      })
      throw recoveryError
    }
    if (!observed || !providerObjectMatchesReservation(observed, reservation)) {
      const cleanup = await this.store.requestArtifactUploadCleanup({
        ...identity,
        reason: 'mismatch',
        claimOwner,
        claimToken,
        claimTtlMs: remainingClaimTtlMs(reservation, this.now()),
        cleanupNotBefore: reservation.expiresAt,
        expectedFinalizationClaimOwner: claimOwner,
        expectedFinalizationClaimToken: claimToken,
        now: this.now(),
      })
      if (!cleanup) throw new Error('Artifact upload finalization claim is no longer current.')
      if (cleanup.claimOwner !== claimOwner || cleanup.claimToken !== claimToken) {
        return { outcome: 'rejected', reservation: cleanup }
      }
      try {
        return {
          outcome: 'rejected',
          reservation: await this.cleanupClaim(cleanup, claimOwner, claimToken),
        }
      } catch {
        return {
          outcome: 'rejected',
          reservation: await this.store.getArtifactUploadReservation(identity),
        }
      }
    }
    try {
      await this.provider.promote({
        stagingKey: reservation.stagingObjectKey,
        finalKey: reservation.finalObjectKey,
        expected: observed,
      })
      await this.onPromoted?.(reservation)
      const finalized = await this.store.completeArtifactUploadFinalization({
        ...identity,
        claimOwner,
        claimToken,
        now: this.now(),
      })
      if (!finalized) throw new Error('Artifact upload finalization claim is no longer current.')
      return { outcome: 'finalized', reservation: finalized }
    } catch (error) {
      // Do not invoke publication twice in the same attempt. A later claimed retry
      // repairs a matching final object idempotently; here we only prove whether the
      // first publication call committed before its response was lost.
      const recoveredAfterFailure = await this.completePublishedFinalization(
        reservation,
        claimOwner,
        claimToken,
        { repairPublication: false },
      )
      if (recoveredAfterFailure.outcome === 'finalized') {
        return { outcome: 'finalized', reservation: recoveredAfterFailure.reservation }
      }
      const recoveryError = recoveredAfterFailure.outcome === 'defer'
        || recoveredAfterFailure.outcome === 'repair_failed'
        ? recoveredAfterFailure.error
        : asError(error, 'Artifact upload promotion failed.')
      await this.releaseFinalizationClaim(reservation, claimOwner, claimToken, {
        cleanupOnExhaustion: recoveredAfterFailure.outcome === 'repair_failed',
      })
      throw recoveryError
    }
  }

  private async releaseFinalizationClaim(
    reservation: ArtifactUploadReservationRecord,
    claimOwner: string,
    claimToken: string,
    options: { cleanupOnExhaustion: boolean },
  ) {
    await this.store.releaseArtifactUploadClaim({
      ...reservationIdentity(reservation),
      claimOwner,
      claimToken,
      errorCode: 'finalize_failed',
      retryAt: new Date(this.now().getTime() + finalizationRetryDelayMs(reservation.finalizationAttempts)),
      cleanupNotBefore: reservation.expiresAt,
      maxAttempts: ARTIFACT_UPLOAD_MAX_FINALIZATION_ATTEMPTS,
      cleanupOnExhaustion: options.cleanupOnExhaustion,
      now: this.now(),
    })
  }

  private async completePublishedFinalization(
    reservation: ArtifactUploadReservationRecord,
    claimOwner: string,
    claimToken: string,
    options: { repairPublication: boolean },
  ): Promise<PublishedFinalizationRecovery> {
    if (!this.isPublished) return { outcome: 'not_recoverable' }
    let finalObject: ArtifactUploadProviderObject | null
    try {
      finalObject = await this.provider.inspect(reservation.finalObjectKey)
    } catch (error) {
      return {
        outcome: 'defer',
        error: asError(error, 'Artifact upload final-object inspection failed.'),
      }
    }
    if (!finalObject || !providerObjectMatchesReservation(finalObject, reservation)) {
      return { outcome: 'not_recoverable' }
    }

    const publication = await this.probePublication(reservation)
    if (publication.outcome === 'defer') return publication
    if (!publication.published) {
      if (!options.repairPublication || !this.onPromoted) {
        return {
          outcome: 'repair_failed',
          error: new Error('Artifact upload final object exists but publication is incomplete.'),
        }
      }
      let repairError: Error | null = null
      try {
        await this.onPromoted(reservation)
      } catch (error) {
        repairError = asError(error, 'Artifact upload publication repair failed.')
      }
      const repaired = await this.probePublication(reservation)
      if (repaired.outcome === 'defer') return repaired
      if (!repaired.published) {
        return {
          outcome: 'repair_failed',
          error: repairError || new Error('Artifact upload publication repair did not publish the final object.'),
        }
      }
    }

    try {
      const finalized = await this.store.completeArtifactUploadFinalization({
        ...reservationIdentity(reservation),
        claimOwner,
        claimToken,
        now: this.now(),
      })
      if (!finalized) throw new Error('Artifact upload finalization claim is no longer current.')
      return { outcome: 'finalized', reservation: finalized }
    } catch (error) {
      return {
        outcome: 'defer',
        error: asError(error, 'Artifact upload finalization commit failed.'),
      }
    }
  }

  private async probePublication(
    reservation: ArtifactUploadReservationRecord,
  ): Promise<{ outcome: 'published', published: boolean } | { outcome: 'defer', error: Error }> {
    try {
      return { outcome: 'published', published: await this.isPublished!(reservation) }
    } catch (error) {
      return {
        outcome: 'defer',
        error: asError(error, 'Artifact upload publication verification failed.'),
      }
    }
  }

  private async cleanupClaim(
    reservation: ArtifactUploadReservationRecord,
    claimOwner: string,
    claimToken: string,
    scope: 'all' | 'staging' = 'all',
  ) {
    try {
      await this.provider.delete(reservation.stagingObjectKey)
      if (scope === 'all' && reservation.finalObjectKey !== reservation.stagingObjectKey) {
        await this.provider.delete(reservation.finalObjectKey)
      }
      if (reservation.cleanupPasses < 1) {
        const deferred = await this.store.deferArtifactUploadCleanup({
          ...reservationIdentity(reservation),
          claimOwner,
          claimToken,
          retryAt: new Date(this.now().getTime() + ARTIFACT_UPLOAD_CLEANUP_CONFIRMATION_HORIZON_MS),
          now: this.now(),
        })
        if (!deferred) throw new Error('Artifact upload cleanup claim is no longer current.')
        return deferred
      }
      const cleaned = await this.store.completeArtifactUploadCleanup({
        orgId: reservation.orgId,
        tenantId: reservation.tenantId,
        sessionId: reservation.sessionId,
        artifactId: reservation.artifactId,
        claimOwner,
        claimToken,
        now: this.now(),
      })
      if (!cleaned) throw new Error('Artifact upload cleanup claim is no longer current.')
      return cleaned
    } catch (error) {
      await this.store.failArtifactUploadCleanup({
        orgId: reservation.orgId,
        tenantId: reservation.tenantId,
        sessionId: reservation.sessionId,
        artifactId: reservation.artifactId,
        claimOwner,
        claimToken,
        errorCode: 'provider_delete_failed',
        retryAt: new Date(this.now().getTime() + cleanupRetryDelayMs(reservation.cleanupAttempts)),
        now: this.now(),
      })
      throw error
    }
  }
}

function reservationIdentity(reservation: ArtifactUploadReservationRecord): ArtifactUploadReservationIdentity {
  return {
    orgId: reservation.orgId,
    tenantId: reservation.tenantId,
    sessionId: reservation.sessionId,
    artifactId: reservation.artifactId,
  }
}

function remainingClaimTtlMs(reservation: ArtifactUploadReservationRecord, now: Date) {
  if (!reservation.claimExpiresAt) return 1
  return Math.max(1, Date.parse(reservation.claimExpiresAt) - now.getTime())
}

function cleanupRetryDelayMs(attempts: number) {
  return Math.min(60_000, 1_000 * (2 ** Math.min(Math.max(0, attempts), 6)))
}

function finalizationRetryDelayMs(attempts: number) {
  return Math.min(60_000, 1_000 * (2 ** Math.min(Math.max(0, attempts), 6)))
}

function asError(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback)
}

function providerObjectMatchesReservation(
  observed: ArtifactUploadProviderObject,
  reservation: ArtifactUploadReservationRecord,
) {
  return observed.size === reservation.reservedBytes
    && observed.contentType === (reservation.contentType || 'application/octet-stream')
    && observed.checksumSha256 === reservation.checksumSha256
}
