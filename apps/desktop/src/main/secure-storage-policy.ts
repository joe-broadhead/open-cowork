export type SecretStorageMode = 'encrypted' | 'plaintext' | 'unavailable'

export function resolveSecretStorageMode(options: {
  isPackaged: boolean
  encryptionAvailable: boolean
}): SecretStorageMode {
  if (options.encryptionAvailable) return 'encrypted'
  return options.isPackaged ? 'unavailable' : 'plaintext'
}
