export type SecretStorageMode = 'encrypted' | 'plaintext' | 'unavailable'

const NON_PROTECTIVE_BACKENDS = new Set(['basic_text'])

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
