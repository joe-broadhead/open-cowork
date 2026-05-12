import {
  COWORK_GOVERNANCE_SCHEMA_VERSION,
  type GovernanceSecretVault,
  type GovernanceSecretVaultStatus,
} from '@open-cowork/shared'
import type { SecretStorageMode } from './secure-storage-policy.ts'

export const LOCAL_SECRET_VAULT_ID = 'secret-vault:local-os'
export const MANAGED_EXTERNAL_SECRET_VAULT_ID = 'secret-vault:managed-external'

function localVaultStatus(mode: SecretStorageMode): GovernanceSecretVaultStatus {
  return mode === 'encrypted' ? 'active' : 'unavailable'
}

function localVaultLimitations(mode: SecretStorageMode): string[] {
  if (mode === 'encrypted') {
    return [
      'Credentials are protected by the operating-system account on this device.',
      'No organization-wide external secret vault is configured yet.',
    ]
  }
  if (mode === 'plaintext') {
    return [
      'Development mode is using the plaintext settings fallback because OS-backed safeStorage is unavailable.',
      'Do not treat this device as an active governance secret vault for production credentials.',
    ]
  }
  return [
    'OS-backed safeStorage is unavailable, so packaged builds refuse to persist credentials.',
    'Configure the platform keychain, libsecret, or DPAPI before relying on local credential bindings.',
  ]
}

export function buildGovernanceSecretVaults(options: {
  secretStorageMode: SecretStorageMode
  generatedAt: string
}): GovernanceSecretVault[] {
  const localStatus = localVaultStatus(options.secretStorageMode)
  return [
    {
      schemaVersion: COWORK_GOVERNANCE_SCHEMA_VERSION,
      id: LOCAL_SECRET_VAULT_ID,
      kind: 'local_os',
      label: 'Local OS credential vault',
      status: localStatus,
      scope: {
        kind: 'machine',
        id: 'machine',
        label: 'This device',
        directory: null,
      },
      storageMode: options.secretStorageMode,
      storedSecretKinds: ['provider_credentials', 'integration_credentials', 'oauth_tokens'],
      limitations: localVaultLimitations(options.secretStorageMode),
      lastVerifiedAt: localStatus === 'active' ? options.generatedAt : null,
    },
    {
      schemaVersion: COWORK_GOVERNANCE_SCHEMA_VERSION,
      id: MANAGED_EXTERNAL_SECRET_VAULT_ID,
      kind: 'managed_external',
      label: 'Managed external secret vault',
      status: 'planned',
      scope: {
        kind: 'system',
        id: 'managed-secret-vault',
        label: 'Future organization vault',
        directory: null,
      },
      storageMode: 'external',
      storedSecretKinds: ['provider_credentials', 'integration_credentials', 'oauth_tokens'],
      limitations: [
        'This is a roadmap integration point; no external vault provider is connected yet.',
        'Credential bindings currently resolve to the local OS credential vault only.',
      ],
      lastVerifiedAt: null,
    },
  ]
}
