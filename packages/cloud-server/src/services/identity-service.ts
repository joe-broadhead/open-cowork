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
    channelBindingIds?: readonly string[] | null
  }): Promise<IssuedPublicApiTokenRecord>
  revokeApiToken(principal: CloudPrincipal, tokenId: string): Promise<PublicApiTokenRecord | null>
  grantApiTokenChannelBinding(principal: CloudPrincipal, tokenId: string, input: {
    channelBindingId: string
  }): Promise<{ grant: { orgId: string, tokenId: string, channelBindingId: string, createdAt: string }, token: PublicApiTokenRecord }>
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
    channelBindingIds?: readonly string[] | null
  }) {
    return this.delegate.issueApiToken(principal, input)
  }

  revokeApiToken(principal: CloudPrincipal, tokenId: string) {
    return this.delegate.revokeApiToken(principal, tokenId)
  }

  grantApiTokenChannelBinding(principal: CloudPrincipal, tokenId: string, input: { channelBindingId: string }) {
    return this.delegate.grantApiTokenChannelBinding(principal, tokenId, input)
  }
}
