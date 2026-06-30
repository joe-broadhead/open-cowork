// API token administration, carved out of the CloudSessionService god class (ARCH
// god-class, P2). Issuing, listing, revoking, and channel-binding grants carry real
// body logic (scope policy enforcement, channel-binding normalization, audit-actor
// stamping) that is moved verbatim so behavior is byte-identical; CloudSessionService
// now keeps thin delegating methods. Constructed with the store + identity policy plus
// the ensurePrincipal/principalOrgId callbacks bound from CloudSessionService.
import type {
  ApiTokenRecord,
  ApiTokenScope,
  ControlPlaneStore,
} from './control-plane-store.ts'
import { CloudServiceError } from './cloud-service-error.ts'
import { normalizedCloudListLimit } from './session-input-validation.ts'
import { principalCanManageApiTokens } from './session-principal-access.ts'
import {
  enforceApiTokenScopePolicy,
  normalizeApiTokenExpiresAt,
  normalizeApiTokenScopes,
  publicApiToken,
  type CloudIdentityPolicy,
  type PublicApiTokenRecord,
} from './services/api-token-policy.ts'
import type { CloudPrincipal, IssuedPublicApiTokenRecord } from './session-service.ts'

export type CloudApiTokenOperationsServiceOptions = {
  store: ControlPlaneStore
  identityPolicy: CloudIdentityPolicy
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
  principalOrgId: (principal: CloudPrincipal) => string
}

export class CloudApiTokenOperationsService {
  private readonly store: ControlPlaneStore
  private readonly identityPolicy: CloudIdentityPolicy
  private readonly ensurePrincipal: CloudApiTokenOperationsServiceOptions['ensurePrincipal']
  private readonly principalOrgId: CloudApiTokenOperationsServiceOptions['principalOrgId']

  constructor(options: CloudApiTokenOperationsServiceOptions) {
    this.store = options.store
    this.identityPolicy = options.identityPolicy
    this.ensurePrincipal = options.ensurePrincipal
    this.principalOrgId = options.principalOrgId
  }

  async listApiTokens(principal: CloudPrincipal, input: { limit?: number | null } = {}): Promise<PublicApiTokenRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertApiTokenAdmin(principal)
    const tokens = (await this.store.listApiTokens(this.principalOrgId(principal)))
      .slice(0, normalizedCloudListLimit(input.limit))
    return Promise.all(tokens.map((token) => this.publicApiTokenWithChannelBindings(token)))
  }

  async issueApiToken(
    principal: CloudPrincipal,
    input: {
      name: string
      scopes: ApiTokenScope[]
      expiresAt?: Date | null
      channelBindingIds?: readonly string[] | null
    },
  ): Promise<IssuedPublicApiTokenRecord> {
    await this.ensurePrincipal(principal)
    this.assertApiTokenAdmin(principal)
    const scopes = enforceApiTokenScopePolicy(normalizeApiTokenScopes(input.scopes), this.identityPolicy)
    const channelBindingIds = await this.normalizeApiTokenChannelBindingIds(principal, input.channelBindingIds, scopes)
    const issued = await this.store.issueApiToken({
      orgId: this.principalOrgId(principal),
      accountId: principal.accountId || principal.userId,
      name: input.name,
      scopes,
      expiresAt: normalizeApiTokenExpiresAt(input.expiresAt, this.identityPolicy),
      actor: {
        actorType: principal.authSource === 'api_token' ? 'api_token' : 'user',
        actorId: principal.tokenId || principal.userId,
        accountId: principal.accountId || principal.userId,
      },
    })
    for (const channelBindingId of channelBindingIds) {
      await this.store.grantApiTokenChannelBinding({
        orgId: this.principalOrgId(principal),
        tokenId: issued.token.tokenId,
        channelBindingId,
        actor: {
          actorType: principal.authSource === 'api_token' ? 'api_token' : 'user',
          actorId: principal.tokenId || principal.userId,
          accountId: principal.accountId || principal.userId,
        },
      })
    }
    return {
      token: publicApiToken(issued.token, channelBindingIds),
      plaintext: issued.plaintext,
    }
  }

  async revokeApiToken(principal: CloudPrincipal, tokenId: string): Promise<PublicApiTokenRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertApiTokenAdmin(principal)
    const revoked = await this.store.revokeApiToken({
      tokenId,
      orgId: this.principalOrgId(principal),
      actor: {
        actorType: principal.authSource === 'api_token' ? 'api_token' : 'user',
        actorId: principal.tokenId || principal.userId,
        accountId: principal.accountId || principal.userId,
      },
    })
    return revoked ? this.publicApiTokenWithChannelBindings(revoked) : null
  }

  async grantApiTokenChannelBinding(
    principal: CloudPrincipal,
    tokenId: string,
    input: { channelBindingId: string },
  ): Promise<{ grant: { orgId: string, tokenId: string, channelBindingId: string, createdAt: string }, token: PublicApiTokenRecord }> {
    await this.ensurePrincipal(principal)
    this.assertApiTokenAdmin(principal)
    const orgId = this.principalOrgId(principal)
    const token = (await this.store.listApiTokens(orgId)).find((candidate) => candidate.tokenId === tokenId)
    if (!token) throw new CloudServiceError(404, 'API token was not found.')
    if (!token.scopes.includes('gateway')) {
      throw new CloudServiceError(400, 'Channel binding grants require a gateway-scoped API token.')
    }
    const channelBindingId = await this.normalizeSingleApiTokenChannelBindingId(principal, input.channelBindingId)
    const grant = await this.store.grantApiTokenChannelBinding({
      orgId,
      tokenId,
      channelBindingId,
      actor: {
        actorType: principal.authSource === 'api_token' ? 'api_token' : 'user',
        actorId: principal.tokenId || principal.userId,
        accountId: principal.accountId || principal.userId,
      },
    })
    return {
      grant,
      token: await this.publicApiTokenWithChannelBindings(token),
    }
  }

  private async publicApiTokenWithChannelBindings(token: ApiTokenRecord): Promise<PublicApiTokenRecord> {
    const grants = await this.store.listApiTokenChannelBindingGrants({
      orgId: token.orgId,
      tokenId: token.tokenId,
    })
    return publicApiToken(token, grants.map((grant) => grant.channelBindingId))
  }

  private async normalizeApiTokenChannelBindingIds(
    principal: CloudPrincipal,
    input: readonly string[] | null | undefined,
    scopes: ApiTokenScope[],
  ): Promise<string[]> {
    const ids = [...new Set((input || []).map((value) => value.trim()).filter(Boolean))]
    if (ids.length === 0) return []
    if (!scopes.includes('gateway')) {
      throw new CloudServiceError(400, 'Channel binding grants require a gateway-scoped API token.')
    }
    const normalized: string[] = []
    for (const channelBindingId of ids) {
      normalized.push(await this.normalizeSingleApiTokenChannelBindingId(principal, channelBindingId))
    }
    return normalized
  }

  private async normalizeSingleApiTokenChannelBindingId(principal: CloudPrincipal, input: string): Promise<string> {
    const channelBindingId = input.trim()
    if (!channelBindingId) throw new CloudServiceError(400, 'Channel binding id is required.')
    const binding = await this.store.getChannelBinding(this.principalOrgId(principal), channelBindingId)
    if (!binding) throw new CloudServiceError(404, 'Channel binding was not found.')
    return binding.bindingId
  }

  private assertApiTokenAdmin(principal: CloudPrincipal) {
    if (!principalCanManageApiTokens(principal)) {
      throw new CloudServiceError(403, 'API token administration requires an org admin or admin-scoped API token.')
    }
  }
}
