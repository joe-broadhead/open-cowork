const AZURE_KEY_VAULT_HOST_SUFFIX = '.vault.azure.net'
const AZURE_KEY_VAULT_NAME_PATTERN = /^[a-z][a-z0-9-]{1,22}[a-z0-9]$/i

function isValidAzureVaultName(value: string) {
  return AZURE_KEY_VAULT_NAME_PATTERN.test(value) && !value.includes('--')
}

export function isAzureKeyVaultSecretUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }

  const hostname = url.hostname.toLowerCase()
  const vaultName = hostname.endsWith(AZURE_KEY_VAULT_HOST_SUFFIX)
    ? hostname.slice(0, -AZURE_KEY_VAULT_HOST_SUFFIX.length)
    : ''
  const pathParts = url.pathname.split('/').filter(Boolean)
  const queryKeys = Array.from(url.searchParams.keys())

  return url.protocol === 'https:'
    && !url.username
    && !url.password
    && !url.hash
    && isValidAzureVaultName(vaultName)
    && pathParts.length >= 2
    && pathParts.length <= 3
    && pathParts[0] === 'secrets'
    && Boolean(pathParts[1])
    && queryKeys.every((key) => key === 'api-version')
}

export function assertAzureKeyVaultSecretUrl(value: string) {
  if (!isAzureKeyVaultSecretUrl(value)) {
    throw new Error('Azure Key Vault HTTPS references must use https://{vault}.vault.azure.net/secrets/{secret}/{version?} without credentials, fragments, or unexpected query parameters.')
  }
}

export function isSupportedCloudSecretRef(ref: string | null | undefined) {
  if (!ref) return true
  const trimmed = ref.trim()
  return trimmed.startsWith('env:')
    || trimmed.startsWith('gcp-sm://')
    || trimmed.startsWith('aws-sm://')
    || trimmed.startsWith('azure-kv://')
    || (trimmed.startsWith('https://') && isAzureKeyVaultSecretUrl(trimmed))
}

export function isManagedCloudSecretRef(ref: string | null | undefined) {
  if (!ref) return false
  const trimmed = ref.trim()
  return trimmed.startsWith('gcp-sm://')
    || trimmed.startsWith('aws-sm://')
    || trimmed.startsWith('azure-kv://')
    || (trimmed.startsWith('https://') && isAzureKeyVaultSecretUrl(trimmed))
}
