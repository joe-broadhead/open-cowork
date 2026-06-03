export type {
  CloudByokSecretMetadata,
  CloudByokSecretStatus,
  CloudSetByokSecretInput,
} from '../contracts.js'

import type {
  CloudByokSecretMetadata,
  CloudSetByokSecretInput,
} from '../contracts.js'
import type { CloudDomainClientContext } from './shared.js'
import { encodePath } from './shared.js'

export type CloudByokClient = {
  listByokSecrets(): Promise<CloudByokSecretMetadata[]>
  getByokSecret(providerId: string): Promise<CloudByokSecretMetadata | null>
  setByokSecret(providerId: string, input: CloudSetByokSecretInput): Promise<CloudByokSecretMetadata>
  validateByokSecret(providerId: string): Promise<CloudByokSecretMetadata | null>
  overrideByokSecretValidation(providerId: string, input: { reason: string }): Promise<CloudByokSecretMetadata | null>
  deleteByokSecret(providerId: string): Promise<CloudByokSecretMetadata | null>
}

export function createCloudByokClient({ request }: CloudDomainClientContext): CloudByokClient {
  return {
    async listByokSecrets() {
      return (await request<{ secrets: CloudByokSecretMetadata[] }>('/api/byok')).secrets
    },
    async getByokSecret(providerId) {
      return (await request<{ secret: CloudByokSecretMetadata | null }>(`/api/byok/${encodePath(providerId)}`)).secret
    },
    async setByokSecret(providerId, input) {
      return (await request<{ secret: CloudByokSecretMetadata }>(`/api/byok/${encodePath(providerId)}`, {
        method: 'POST',
        body: input,
      })).secret
    },
    async validateByokSecret(providerId) {
      return (await request<{ secret: CloudByokSecretMetadata | null }>(
        `/api/byok/${encodePath(providerId)}/validate`,
        { method: 'POST' },
      )).secret
    },
    async overrideByokSecretValidation(providerId, input) {
      return (await request<{ secret: CloudByokSecretMetadata | null }>(
        `/api/byok/${encodePath(providerId)}/override`,
        { method: 'POST', body: input },
      )).secret
    },
    async deleteByokSecret(providerId) {
      return (await request<{ secret: CloudByokSecretMetadata | null }>(`/api/byok/${encodePath(providerId)}`, {
        method: 'DELETE',
      })).secret
    },
  }
}
