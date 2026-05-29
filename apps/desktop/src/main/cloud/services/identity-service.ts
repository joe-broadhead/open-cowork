import type {
  CloudPrincipal,
  CloudWorkspaceOverview,
  IssuedPublicApiTokenRecord,
  PublicApiTokenRecord,
} from '../session-service.ts'
import type { ApiTokenScope } from '../control-plane-store.ts'

export type CloudIdentityServiceDelegate = {
  ensurePrincipal(principal: CloudPrincipal): Promise<CloudPrincipal>
  getWorkspaceOverview(principal: CloudPrincipal): Promise<CloudWorkspaceOverview>
  listApiTokens(principal: CloudPrincipal): Promise<PublicApiTokenRecord[]>
  issueApiToken(principal: CloudPrincipal, input: {
    name: string
    scopes: ApiTokenScope[]
    expiresAt?: Date | null
  }): Promise<IssuedPublicApiTokenRecord>
  revokeApiToken(principal: CloudPrincipal, tokenId: string): Promise<PublicApiTokenRecord | null>
}

export class CloudIdentityService {
  private readonly delegate: CloudIdentityServiceDelegate

  constructor(delegate: CloudIdentityServiceDelegate) {
    this.delegate = delegate
  }

  ensurePrincipal(principal: CloudPrincipal) {
    return this.delegate.ensurePrincipal(principal)
  }

  getWorkspaceOverview(principal: CloudPrincipal) {
    return this.delegate.getWorkspaceOverview(principal)
  }

  listApiTokens(principal: CloudPrincipal) {
    return this.delegate.listApiTokens(principal)
  }

  issueApiToken(principal: CloudPrincipal, input: {
    name: string
    scopes: ApiTokenScope[]
    expiresAt?: Date | null
  }) {
    return this.delegate.issueApiToken(principal, input)
  }

  revokeApiToken(principal: CloudPrincipal, tokenId: string) {
    return this.delegate.revokeApiToken(principal, tokenId)
  }
}
