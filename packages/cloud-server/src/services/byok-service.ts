import type { BillingAction } from '../billing-adapter.ts'
import type {
  ByokSecretMetadata,
  ByokSecretStore,
} from '../byok-secret-store.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import { principalHasPrivilegedTokenScope } from '../principal-access.ts'
import type { ControlPlanePermission } from '../control-plane-permissions.ts'
import type { CloudPrincipal } from '../session-service.ts'

export type ByokEntitlementVerdict = {
  allowed: boolean
  status?: number
  reason?: string | null
}

export type ByokEntitlementChecker = (input: {
  principal: CloudPrincipal
  orgId: string
  providerId: string
}) => Promise<ByokEntitlementVerdict> | ByokEntitlementVerdict

export type ByokRuntimeEntitlementChecker = (input: {
  orgId: string
  providerId: string
}) => Promise<ByokEntitlementVerdict> | ByokEntitlementVerdict

export type ByokKmsRefPolicy = {
  enabled?: boolean
  allowedPrefixes?: readonly string[] | null
  allowEnvRefs?: boolean
}

export type ByokManagementPolicy = {
  allowedProviderIds?: readonly string[] | null
  checkEntitlement?: ByokEntitlementChecker | null
  checkRuntimeEntitlement?: ByokRuntimeEntitlementChecker | null
  kmsRefs?: ByokKmsRefPolicy | null
}

export type ByokPolicyOverview = {
  allowedProviderIds: string[] | null
  kmsRefsEnabled: boolean
  kmsRefPrefixesConfigured: boolean
  envRefsEnabled: boolean
}

export type CloudByokServiceOptions = {
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
  principalOrgId: (principal: CloudPrincipal) => string
  assertPermission: (principal: CloudPrincipal, permission: ControlPlanePermission) => void
  byokSecrets: ByokSecretStore | null
  byokPolicy?: ByokManagementPolicy
  assertBillingAllowed: (input: {
    orgId: string
    action: BillingAction
    profileName?: string | null
    providerId?: string | null
  }) => Promise<void> | void
}

function normalizeByokProviderIdForPolicy(value: string) {
  const providerId = value.trim().toLowerCase()
  if (!providerId || providerId.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) {
    throw new CloudServiceError(400, `Unsupported BYOK provider id ${providerId || '<empty>'}.`)
  }
  return providerId
}

function byokAuditActor(principal: CloudPrincipal) {
  return {
    actorType: principal.authSource === 'api_token' ? 'api_token' as const : 'user' as const,
    actorId: principal.tokenId || principal.userId,
    accountId: principal.accountId || principal.userId,
  }
}

export class CloudByokService {
  private readonly ensurePrincipal: CloudByokServiceOptions['ensurePrincipal']
  private readonly principalOrgId: CloudByokServiceOptions['principalOrgId']
  private readonly assertPermission: CloudByokServiceOptions['assertPermission']
  private readonly byokSecrets: ByokSecretStore | null
  private readonly byokPolicy: ByokManagementPolicy
  private readonly assertBillingAllowed: CloudByokServiceOptions['assertBillingAllowed']

  constructor(options: CloudByokServiceOptions) {
    this.ensurePrincipal = options.ensurePrincipal
    this.principalOrgId = options.principalOrgId
    this.assertPermission = options.assertPermission
    this.byokSecrets = options.byokSecrets
    this.byokPolicy = options.byokPolicy || {}
    this.assertBillingAllowed = options.assertBillingAllowed
  }

  getPolicyOverview(): ByokPolicyOverview {
    return {
      allowedProviderIds: this.byokPolicy.allowedProviderIds
        ? [...this.byokPolicy.allowedProviderIds].map((id) => id.trim().toLowerCase()).filter(Boolean)
        : null,
      kmsRefsEnabled: this.byokPolicy.kmsRefs?.enabled === true,
      kmsRefPrefixesConfigured: Boolean(this.byokPolicy.kmsRefs?.allowedPrefixes?.length),
      envRefsEnabled: this.byokPolicy.kmsRefs?.allowEnvRefs === true,
    }
  }

  async listSecretMetadataForOrg(orgId: string): Promise<ByokSecretMetadata[]> {
    return this.byokSecrets ? this.byokSecrets.listMetadata(orgId) : []
  }

  async listSecrets(principal: CloudPrincipal): Promise<ByokSecretMetadata[]> {
    await this.ensurePrincipal(principal)
    this.assertByokAllowed(principal)
    return this.requireByokSecrets().listMetadata(this.principalOrgId(principal))
  }

  async getSecret(principal: CloudPrincipal, providerId: string): Promise<ByokSecretMetadata | null> {
    await this.ensurePrincipal(principal)
    this.assertByokAllowed(principal)
    // Reads are never billing-gated (#906): reading key metadata must work even when
    // the subscription is past_due — config-only provider check, no entitlement gate.
    const normalizedProviderId = this.assertByokProviderConfigured(providerId)
    return this.requireByokSecrets().getMetadata(this.principalOrgId(principal), normalizedProviderId)
  }

  async setSecret(
    principal: CloudPrincipal,
    input: { providerId: string, plaintext?: string | null, kmsRef?: string | null },
  ): Promise<ByokSecretMetadata> {
    await this.ensurePrincipal(principal)
    this.assertByokAllowed(principal)
    const providerId = this.assertByokProviderConfigured(input.providerId)
    this.assertByokKmsRefAllowed(providerId, input.kmsRef)
    await this.assertByokProviderEntitled(principal, providerId)
    return this.requireByokSecrets().setSecret({
      orgId: this.principalOrgId(principal),
      providerId,
      plaintext: input.plaintext,
      kmsRef: input.kmsRef,
      createdByAccountId: principal.accountId || principal.userId,
      actor: byokAuditActor(principal),
    })
  }

  async validateSecret(principal: CloudPrincipal, providerId: string): Promise<ByokSecretMetadata | null> {
    await this.ensurePrincipal(principal)
    this.assertByokAllowed(principal)
    const normalizedProviderId = await this.assertByokProviderAllowed(principal, providerId)
    return this.requireByokSecrets().validateActiveSecret({
      orgId: this.principalOrgId(principal),
      providerId: normalizedProviderId,
      actor: byokAuditActor(principal),
    })
  }

  async overrideValidation(
    principal: CloudPrincipal,
    providerId: string,
    reason: string,
  ): Promise<ByokSecretMetadata | null> {
    await this.ensurePrincipal(principal)
    this.assertByokAllowed(principal)
    const normalizedProviderId = await this.assertByokProviderAllowed(principal, providerId)
    return this.requireByokSecrets().activateWithoutValidation({
      orgId: this.principalOrgId(principal),
      providerId: normalizedProviderId,
      reason,
      actor: byokAuditActor(principal),
    })
  }

  async disableSecret(principal: CloudPrincipal, providerId: string): Promise<ByokSecretMetadata | null> {
    await this.ensurePrincipal(principal)
    this.assertByokAllowed(principal)
    // De-escalation is never billing-gated (#906): an admin must be able to disable/revoke
    // a leaked key even while past_due — config-only provider check, no entitlement gate.
    const normalizedProviderId = this.assertByokProviderConfigured(providerId)
    return this.requireByokSecrets().disableSecret({
      orgId: this.principalOrgId(principal),
      providerId: normalizedProviderId,
      actor: byokAuditActor(principal),
    })
  }

  private assertByokAllowed(principal: CloudPrincipal) {
    this.assertPermission(principal, 'policy:manage')
    if (principal.authSource === 'api_token' && !principalHasPrivilegedTokenScope(principal, 'admin')) {
      throw new CloudServiceError(403, 'BYOK credential administration with an API token requires the admin token scope.')
    }
  }

  private async assertByokProviderAllowed(principal: CloudPrincipal, providerIdInput: string) {
    const providerId = this.assertByokProviderConfigured(providerIdInput)
    await this.assertByokProviderEntitled(principal, providerId)
    return providerId
  }

  private assertByokProviderConfigured(providerIdInput: string) {
    const providerId = normalizeByokProviderIdForPolicy(providerIdInput)
    const allowedProviderIds = this.byokPolicy.allowedProviderIds
      ? new Set(this.byokPolicy.allowedProviderIds.map((id) => id.trim().toLowerCase()).filter(Boolean))
      : null
    if (allowedProviderIds && !allowedProviderIds.has(providerId)) {
      throw new CloudServiceError(403, `Provider "${providerId}" is not enabled for BYOK in this cloud profile.`)
    }
    return providerId
  }

  private async assertByokProviderEntitled(principal: CloudPrincipal, providerId: string) {
    await this.assertBillingAllowed({
      orgId: this.principalOrgId(principal),
      action: 'byok.provider',
      providerId,
    })
    const entitlement = await this.byokPolicy.checkEntitlement?.({
      principal,
      orgId: this.principalOrgId(principal),
      providerId,
    })
    if (entitlement && !entitlement.allowed) {
      throw new CloudServiceError(
        entitlement.status || 402,
        entitlement.reason || `Provider "${providerId}" is not available for this org entitlement.`,
      )
    }
  }

  private assertByokKmsRefAllowed(providerId: string, kmsRefInput: string | null | undefined) {
    const kmsRef = typeof kmsRefInput === 'string' ? kmsRefInput.trim() : ''
    if (!kmsRef) return
    const policy = this.byokPolicy.kmsRefs
    if (!policy?.enabled) {
      throw new CloudServiceError(403, 'KMS-backed BYOK references are disabled for this cloud deployment.')
    }
    if (kmsRef.startsWith('env:') && !policy.allowEnvRefs) {
      throw new CloudServiceError(403, 'Environment-backed BYOK references are not enabled for user-managed KMS refs.')
    }
    const allowedPrefixes = (policy.allowedPrefixes || [])
      .map((prefix) => prefix.trim())
      .filter(Boolean)
    if (allowedPrefixes.length === 0) {
      throw new CloudServiceError(403, 'KMS-backed BYOK references require deployer-configured allowed prefixes.')
    }
    if (!allowedPrefixes.some((prefix) => kmsRef.startsWith(prefix))) {
      throw new CloudServiceError(403, `KMS-backed BYOK reference is not allowed for provider "${providerId}".`)
    }
  }

  private requireByokSecrets() {
    if (!this.byokSecrets) throw new CloudServiceError(503, 'BYOK secret storage is not configured.')
    return this.byokSecrets
  }
}
