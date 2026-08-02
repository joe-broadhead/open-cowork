export type CloudArtifactDirectUploadMode = 'off' | 'enabled'

export type CloudArtifactDirectUploadConfig = {
  mode: CloudArtifactDirectUploadMode
  requested: boolean
  configStatus: 'valid' | 'invalid'
  reason: 'disabled' | 'enabled' | 'invalid_mode'
  cleanupBatchSize: number
  cleanupIntervalMs: number
}

const DEFAULT_CLEANUP_BATCH_SIZE = 100
const DEFAULT_CLEANUP_INTERVAL_MS = 60_000

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
) {
  if (!value?.trim()) return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback
  return Math.min(parsed, maximum)
}

/** Resolve the deployment-only direct-upload gate without throwing at bootstrap. */
export function resolveCloudArtifactDirectUploadConfig(
  env: Record<string, string | undefined>,
): CloudArtifactDirectUploadConfig {
  const rawMode = env.OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_MODE?.trim().toLowerCase()
  const requested = Boolean(rawMode && rawMode !== 'off')
  const common = {
    requested,
    cleanupBatchSize: boundedPositiveInteger(
      env.OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_CLEANUP_BATCH_SIZE,
      DEFAULT_CLEANUP_BATCH_SIZE,
      100,
    ),
    cleanupIntervalMs: boundedPositiveInteger(
      env.OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_CLEANUP_INTERVAL_MS,
      DEFAULT_CLEANUP_INTERVAL_MS,
      24 * 60 * 60 * 1_000,
    ),
  }
  if (!rawMode || rawMode === 'off') {
    return { ...common, mode: 'off', configStatus: 'valid', reason: 'disabled' }
  }
  if (rawMode === 'enabled') {
    return { ...common, mode: 'enabled', configStatus: 'valid', reason: 'enabled' }
  }
  return { ...common, mode: 'off', configStatus: 'invalid', reason: 'invalid_mode' }
}
