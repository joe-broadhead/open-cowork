import { createHash, randomUUID } from 'node:crypto'

import {
  resolveCloudArtifactDirectUploadConfig,
  type CloudArtifactDirectUploadConfig,
} from './artifact-direct-upload-config.ts'
import {
  CloudArtifactService,
  type CloudArtifactDirectUploadOptions,
} from './artifact-service.ts'
import {
  ArtifactUploadLifecycle,
  type ArtifactUploadProviderPort,
  type ArtifactUploadProviderObject,
} from './artifact-upload-lifecycle.ts'
import type { ControlPlaneStore } from './control-plane-store.ts'
import type {
  ObjectStoreAdapter,
  ObjectStoreDirectUploadLifecycleCapability,
  ObjectStoreHeadResult,
  ObjectStorePresignedUploadCapability,
} from './object-store.ts'
import { recordCloudMetric, type CloudObservabilityAdapter } from './observability.ts'
import type { CloudSessionService } from './session-service.ts'

const DEFAULT_CLAIM_TTL_MS = 30_000
const CLEANUP_OWNER_ATTESTATION_TTL_MS = 30_000
const CLEANUP_OWNER_ATTESTATION_REFRESH_MS = 20_000
const CLEANUP_OWNER_LOOKUP_TIMEOUT_MS = 250
const CLEANUP_OWNER_ATTESTATION_KIND = 'artifact-upload-cleanup-v2'
const ARTIFACT_UPLOAD_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

function deploymentOrigin(value: string | undefined) {
  if (!value?.trim()) return null
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:')
      || url.username
      || url.password
      || url.pathname !== '/'
      || url.search
      || url.hash
    ) return null
    return url.origin
  } catch {
    return null
  }
}

function isCleanupProvider(
  provider: ObjectStorePresignedUploadCapability | undefined,
): provider is ObjectStorePresignedUploadCapability {
  return Boolean(
    provider
    && provider.enforcement === 'exact-content-length'
    && Number.isSafeInteger(provider.maxBytes)
    && provider.maxBytes > 0
    && deploymentOrigin(provider.origin) !== null
    && typeof provider.verifyCleanupSafety === 'function'
    && typeof provider.verifyBrowserPostSafety === 'function'
    && typeof provider.presignPost === 'function'
    && typeof provider.inspect === 'function'
    && typeof provider.promote === 'function'
    && typeof provider.delete === 'function',
  )
}

function isLifecycleProvider(
  provider: ObjectStoreDirectUploadLifecycleCapability | undefined,
): provider is ObjectStoreDirectUploadLifecycleCapability {
  return Boolean(
    provider
    && typeof provider.verifyCleanupSafety === 'function'
    && typeof provider.inspect === 'function'
    && typeof provider.promote === 'function'
    && typeof provider.delete === 'function',
  )
}

type ReconciliationProvider = ArtifactUploadProviderPort & {
  verifyCleanupSafety(): Promise<boolean>
}

function cleanupAttestation(input: {
  browserOrigin: string
  config: CloudArtifactDirectUploadConfig
  provider: ObjectStorePresignedUploadCapability
}) {
  const fingerprint = createHash('sha256').update(JSON.stringify({
    version: 2,
    browserOrigin: input.browserOrigin,
    mode: input.config.mode,
    configStatus: input.config.configStatus,
    cleanupBatchSize: input.config.cleanupBatchSize,
    cleanupIntervalMs: input.config.cleanupIntervalMs,
    enforcement: input.provider.enforcement,
    maxBytes: input.provider.maxBytes,
    providerOrigin: deploymentOrigin(input.provider.origin),
  })).digest('hex')
  return {
    fingerprint,
    key: `health/artifact-upload-cleanup/${fingerprint}`,
  }
}

function cleanupAttestationValidUntil(
  head: ObjectStoreHeadResult | null,
  fingerprint: string,
  nowMs: number,
) {
  if (
    !head
    || head.metadata['attestation-kind'] !== CLEANUP_OWNER_ATTESTATION_KIND
    || head.metadata['contract-fingerprint'] !== fingerprint
  ) return null
  const observedAtMs = Number(head.metadata['observed-at-ms'])
  if (!Number.isFinite(observedAtMs)) return null
  const ageMs = nowMs - observedAtMs
  return ageMs >= -CLEANUP_OWNER_ATTESTATION_TTL_MS
    && ageMs <= CLEANUP_OWNER_ATTESTATION_TTL_MS
    ? observedAtMs + CLEANUP_OWNER_ATTESTATION_TTL_MS
    : null
}

function probeObjectMatches(
  observed: ArtifactUploadProviderObject | null,
  expected: Pick<ArtifactUploadProviderObject, 'size' | 'contentType' | 'checksumSha256'>,
) {
  return Boolean(
    observed
    && observed.size === expected.size
    && observed.contentType === expected.contentType
    && observed.checksumSha256 === expected.checksumSha256
    && typeof observed.versionToken === 'string'
    && observed.versionToken.length > 0,
  )
}

export type CloudArtifactUploadComposition = {
  artifacts: CloudArtifactService
  config: CloudArtifactDirectUploadConfig
  providerAttested: boolean
  durableStore: boolean
  cleanupOwnerReady(): Promise<boolean>
  reconcile(now?: Date): Promise<void>
}

export function createCloudArtifactUploadComposition(input: {
  env: Record<string, string | undefined>
  service: CloudSessionService
  store: ControlPlaneStore
  objectStore: ObjectStoreAdapter
  observability: CloudObservabilityAdapter | null
  claimOwner: string
  schedulerOwner: boolean
  ids?: { randomUUID(): string }
  now?: () => Date
}): CloudArtifactUploadComposition {
  const now = input.now || (() => new Date())
  const config = resolveCloudArtifactDirectUploadConfig(input.env)
  const provider = input.objectStore.presignedUpload
  const issuanceProvider = isCleanupProvider(provider) ? provider : null
  const lifecycleProvider = isLifecycleProvider(input.objectStore.directUploadLifecycle)
    ? input.objectStore.directUploadLifecycle
    : isLifecycleProvider(issuanceProvider || undefined)
      ? issuanceProvider
      : null
  // Legacy custom adapters may have durable reservations without the new provider
  // lifecycle port. They can still be reclaimed after expiry through the adapter's
  // generic delete seam, but can never be inspected, promoted, or published.
  const cleanupOnlyProvider: ReconciliationProvider = {
    async verifyCleanupSafety() { return true },
    async inspect() { return null },
    async promote() { throw new Error('Cleanup-only artifact reconciliation cannot promote objects.') },
    delete: (key) => input.objectStore.deleteObject(key),
  }
  const reconciliationProvider: ReconciliationProvider = lifecycleProvider || cleanupOnlyProvider
  const browserOrigin = deploymentOrigin(input.env.OPEN_COWORK_CLOUD_PUBLIC_URL)
  const providerOrigin = deploymentOrigin(issuanceProvider?.origin)
  const providerAttested = issuanceProvider !== null
    && browserOrigin !== null
    && providerOrigin !== null
    && (!browserOrigin.startsWith('https:') || providerOrigin.startsWith('https:'))
  const durableStore = input.store.artifactUploadLifecycleCapability.persistence === 'durable'
  const lifecycle = new ArtifactUploadLifecycle({
    store: input.store,
    provider: reconciliationProvider,
    now,
    ids: input.ids,
    ...(lifecycleProvider
      ? {
          onPromoted: (reservation) => input.service.publishFinalizedArtifactUpload(reservation).then(() => undefined),
          isPublished: (reservation) => input.service.isFinalizedArtifactUploadPublished(reservation),
        }
      : {}),
  })
  const attestation = issuanceProvider && browserOrigin
    ? cleanupAttestation({ browserOrigin, config, provider: issuanceProvider })
    : null
  let localCleanupAttestedAtMs: number | null = null
  let localCleanupProbeAtMs: number | null = null
  let externalCleanupReadyUntilMs = 0
  let externalCleanupCheck: Promise<number | null> | null = null
  let lastReconcileAtMs: number | null = null
  let lastReconcileSucceeded = false
  let reconciliationFailureOutstanding = false
  let lastPruneAtMs: number | null = null

  const cleanupOwnerReady = async () => {
    if (!providerAttested || !durableStore || !attestation) return false
    const currentMs = now().getTime()
    if (input.schedulerOwner) {
      if (localCleanupAttestedAtMs === null) return false
      const ageMs = currentMs - localCleanupAttestedAtMs
      return ageMs >= -CLEANUP_OWNER_ATTESTATION_TTL_MS
        && ageMs <= CLEANUP_OWNER_ATTESTATION_TTL_MS
    }
    if (externalCleanupReadyUntilMs >= currentMs) return true
    if (!externalCleanupCheck) {
      externalCleanupCheck = input.objectStore.headObject(attestation.key)
        .then((head) => cleanupAttestationValidUntil(head, attestation.fingerprint, now().getTime()))
        .catch(() => null)
        .then((validUntil) => {
          externalCleanupReadyUntilMs = validUntil || 0
          return validUntil
        })
        .finally(() => { externalCleanupCheck = null })
    }
    let timeout: ReturnType<typeof setTimeout> | null = null
    const validUntil = await Promise.race([
      externalCleanupCheck,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), CLEANUP_OWNER_LOOKUP_TIMEOUT_MS)
      }),
    ])
    if (timeout) clearTimeout(timeout)
    return validUntil !== null && validUntil >= currentMs
  }

  const directUpload: CloudArtifactDirectUploadOptions = {
    config,
    lifecycle,
    finalizationAvailable: lifecycleProvider !== null,
    browserOrigin,
    claimOwner: input.claimOwner,
    claimTtlMs: DEFAULT_CLAIM_TTL_MS,
    now,
    observability: input.observability,
    cleanupOwnerReady,
  }
  const artifacts = new CloudArtifactService(
    input.service,
    input.objectStore,
    input.ids || { randomUUID },
    { directUpload },
  )

  const reconcile = async (reconcileAt = now()) => {
    if (
      !input.schedulerOwner
      || !durableStore
    ) return
    const reconcileAtMs = reconcileAt.getTime()
    try {
      if (
        lastPruneAtMs === null
        || reconcileAtMs - lastPruneAtMs < 0
        || reconcileAtMs - lastPruneAtMs >= config.cleanupIntervalMs
      ) {
        const pruned = await input.store.pruneArtifactUploadReservations({
          olderThan: new Date(reconcileAtMs - ARTIFACT_UPLOAD_TERMINAL_RETENTION_MS),
          limit: config.cleanupBatchSize,
        })
        lastPruneAtMs = reconcileAtMs
        await recordCloudMetric(input.observability, {
          name: 'open_cowork_cloud_artifact_upload_reservations_pruned_total',
          kind: 'counter',
          value: pruned,
          unit: '1',
        })
      }
      if (
        config.mode !== 'enabled'
        && lastReconcileAtMs === null
      ) {
        const pending = await input.store.getArtifactUploadReconciliationStats(reconcileAt)
        if (pending.pendingCount === 0) {
          lastReconcileAtMs = reconcileAtMs
          lastReconcileSucceeded = true
          return
        }
      }
      let cleanupSafe = false
      try {
        cleanupSafe = await reconciliationProvider.verifyCleanupSafety()
      } catch {
        cleanupSafe = false
      }
      if (!cleanupSafe) {
        localCleanupAttestedAtMs = null
        lastReconcileSucceeded = false
        lastReconcileAtMs = null
        return
      }
      if (
        reconciliationFailureOutstanding
        || lastReconcileAtMs === null
        || reconcileAtMs - lastReconcileAtMs >= config.cleanupIntervalMs
      ) {
        const result = await lifecycle.reconcile({
          claimOwner: input.claimOwner,
          claimTtlMs: DEFAULT_CLAIM_TTL_MS,
          limit: config.cleanupBatchSize,
        })
        if (result.failed > 0) reconciliationFailureOutstanding = true
        else if (!reconciliationFailureOutstanding || result.claimed > 0) reconciliationFailureOutstanding = false
        lastReconcileAtMs = reconciliationFailureOutstanding ? null : reconcileAtMs
        lastReconcileSucceeded = !reconciliationFailureOutstanding && result.failed === 0
        const stats = await input.store.getArtifactUploadReconciliationStats(reconcileAt)
        await Promise.all([
          recordCloudMetric(input.observability, {
            name: 'open_cowork_cloud_artifact_upload_reconciliation_pending',
            kind: 'gauge',
            value: stats.pendingCount,
            unit: '1',
          }),
          recordCloudMetric(input.observability, {
            name: 'open_cowork_cloud_artifact_upload_cleanup_oldest_age_ms',
            kind: 'gauge',
            value: stats.oldestPendingAgeMs,
            unit: 'ms',
          }),
          recordCloudMetric(input.observability, {
            name: 'open_cowork_cloud_artifact_upload_reconciliation_total',
            value: result.claimed,
            unit: '1',
            attributes: { status: result.failed > 0 ? 'partial' : 'ok' },
          }),
        ])
      }
      let browserSafe = false
      if (attestation && browserOrigin) {
        try {
          browserSafe = await issuanceProvider?.verifyBrowserPostSafety(browserOrigin) || false
        } catch {
          browserSafe = false
        }
      }
      if (
        !lastReconcileSucceeded
        || config.mode !== 'enabled'
        || config.configStatus !== 'valid'
        || !attestation
        || !browserOrigin
        || !browserSafe
      ) {
        localCleanupAttestedAtMs = null
        return
      }
      const attestationAgeMs = localCleanupAttestedAtMs === null
        ? Number.POSITIVE_INFINITY
        : reconcileAtMs - localCleanupAttestedAtMs
      if (attestationAgeMs >= 0 && attestationAgeMs < CLEANUP_OWNER_ATTESTATION_REFRESH_MS) return
      const probeAgeMs = localCleanupProbeAtMs === null
        ? Number.POSITIVE_INFINITY
        : reconcileAtMs - localCleanupProbeAtMs
      if (probeAgeMs < 0 || probeAgeMs > CLEANUP_OWNER_ATTESTATION_TTL_MS) {
        const probeNonce = createHash('sha256')
          .update((input.ids || { randomUUID }).randomUUID())
          .digest('hex')
        const probeSourceKey = `${attestation.key}-probe/${probeNonce}/source`
        const probeFinalKey = `${attestation.key}-probe/${probeNonce}/final`
        const probeBody = createHash('sha256').update(`artifact-upload-probe:${probeNonce}`).digest('hex')
        const expectedProbe = {
          size: Buffer.byteLength(probeBody),
          contentType: 'application/octet-stream',
          checksumSha256: createHash('sha256').update(probeBody).digest('hex'),
        }
        let probeVerified = false
        try {
          await input.objectStore.putObject({
            key: probeSourceKey,
            body: probeBody,
            contentType: 'application/octet-stream',
          })
          const source = await issuanceProvider!.inspect(probeSourceKey)
          if (!probeObjectMatches(source, expectedProbe)) {
            throw new Error('Artifact upload probe source inspection did not match.')
          }
          await issuanceProvider!.promote({
            stagingKey: probeSourceKey,
            finalKey: probeFinalKey,
            expected: source!,
          })
          const promoted = await issuanceProvider!.inspect(probeFinalKey)
          if (!probeObjectMatches(promoted, expectedProbe)) {
            throw new Error('Artifact upload probe promotion did not match.')
          }
          await issuanceProvider!.delete(probeSourceKey)
          await issuanceProvider!.delete(probeFinalKey)
          if (
            await issuanceProvider!.inspect(probeSourceKey)
            || await issuanceProvider!.inspect(probeFinalKey)
          ) throw new Error('Artifact upload probe objects survived deletion.')
          probeVerified = true
          localCleanupProbeAtMs = reconcileAtMs
        } catch {
          localCleanupAttestedAtMs = null
        } finally {
          await Promise.allSettled([
            issuanceProvider!.delete(probeSourceKey),
            issuanceProvider!.delete(probeFinalKey),
          ])
        }
        if (!probeVerified) return
      }
      await input.objectStore.putObject({
        key: attestation.key,
        body: '',
        contentType: 'application/octet-stream',
        metadata: {
          'attestation-kind': CLEANUP_OWNER_ATTESTATION_KIND,
          'contract-fingerprint': attestation.fingerprint,
          'observed-at-ms': String(reconcileAtMs),
        },
      })
      localCleanupAttestedAtMs = reconcileAtMs
    } catch {
      localCleanupAttestedAtMs = null
      lastReconcileSucceeded = false
      lastReconcileAtMs = null
      reconciliationFailureOutstanding = true
      await recordCloudMetric(input.observability, {
        name: 'open_cowork_cloud_artifact_upload_reconciliation_total',
        value: 0,
        unit: '1',
        attributes: { status: 'error' },
      }).catch(() => undefined)
    }
  }

  return {
    artifacts,
    config,
    providerAttested,
    durableStore,
    cleanupOwnerReady,
    reconcile,
  }
}
