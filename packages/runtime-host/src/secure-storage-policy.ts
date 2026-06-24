export type SecretStorageMode = 'encrypted' | 'plaintext' | 'unavailable'

const NON_PROTECTIVE_BACKENDS = new Set(['basic_text'])

export function readSafeStorageBackendForPolicy(
  readBackend: (() => string | null | undefined) | undefined,
  platform = process.platform,
) {
  if (platform !== 'linux' || !readBackend) return null
  try {
    return readBackend() || null
  } catch {
    return null
  }
}

export function resolveSecretStorageMode(options: {
  isPackaged: boolean
  encryptionAvailable: boolean
  selectedStorageBackend?: string | null
}): SecretStorageMode {
  if (options.encryptionAvailable) {
    const backend = options.selectedStorageBackend?.trim().toLowerCase()
    if (!backend || !NON_PROTECTIVE_BACKENDS.has(backend)) return 'encrypted'
  }
  return options.isPackaged ? 'unavailable' : 'plaintext'
}
