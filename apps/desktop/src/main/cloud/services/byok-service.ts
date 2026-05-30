import type { ByokSecretMetadata } from '../byok-secret-store.ts'
import type { CloudPrincipal } from '../session-service.ts'

export type CloudByokServiceDelegate = {
  listByokSecrets(principal: CloudPrincipal): Promise<ByokSecretMetadata[]>
  getByokSecret(principal: CloudPrincipal, providerId: string): Promise<ByokSecretMetadata | null>
  setByokSecret(principal: CloudPrincipal, input: {
    providerId: string
    plaintext?: string | null
    kmsRef?: string | null
  }): Promise<ByokSecretMetadata>
  validateByokSecret(principal: CloudPrincipal, providerId: string): Promise<ByokSecretMetadata | null>
  overrideByokSecretValidation(principal: CloudPrincipal, providerId: string, reason: string): Promise<ByokSecretMetadata | null>
  disableByokSecret(principal: CloudPrincipal, providerId: string): Promise<ByokSecretMetadata | null>
}

export class CloudByokService {
  private readonly delegate: CloudByokServiceDelegate

  constructor(delegate: CloudByokServiceDelegate) {
    this.delegate = delegate
  }

  listSecrets(principal: CloudPrincipal) {
    return this.delegate.listByokSecrets(principal)
  }

  getSecret(principal: CloudPrincipal, providerId: string) {
    return this.delegate.getByokSecret(principal, providerId)
  }

  setSecret(principal: CloudPrincipal, input: {
    providerId: string
    plaintext?: string | null
    kmsRef?: string | null
  }) {
    return this.delegate.setByokSecret(principal, input)
  }

  validateSecret(principal: CloudPrincipal, providerId: string) {
    return this.delegate.validateByokSecret(principal, providerId)
  }

  overrideValidation(principal: CloudPrincipal, providerId: string, reason: string) {
    return this.delegate.overrideByokSecretValidation(principal, providerId, reason)
  }

  disableSecret(principal: CloudPrincipal, providerId: string) {
    return this.delegate.disableByokSecret(principal, providerId)
  }
}
