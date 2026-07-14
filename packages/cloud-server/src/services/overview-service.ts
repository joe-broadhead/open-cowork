import type { ControlPlaneStore } from '../control-plane-store.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import { type CloudRuntimePolicy } from '../cloud-config.ts'
import {
  resolvedSignupMode,
  type CloudIdentityPolicy,
} from './api-token-policy.ts'
import type { ByokPolicyOverview } from './byok-service.ts'
import type { CloudPrincipal } from '../session-service.ts'

export type CloudWorkspaceOverview = {
  tenantId: string
  tenantName: string | null
  orgId: string
  orgName: string
  userId: string
  accountId: string
  email: string
  role: 'owner' | 'admin' | 'member'
  profileName: string
  policy: {
    features: Record<string, boolean>
    allowedAgents: string[] | null
    allowedTools: string[] | null
    allowedMcps: string[] | null
    localFiles: 'disabled'
    localStdioMcps: 'disabled'
    machineRuntimeConfig: 'disabled'
  }
}

export type CloudAdminPolicyOverview = {
  org: {
    orgId: string
    tenantId: string
    name: string
    planKey: string | null
    status: string
  }
  signup: {
    mode: 'disabled' | 'invite' | 'domain' | 'open'
    allowSelfServiceSignup: boolean
    allowedEmailDomains: string[]
    invitesEnabled: boolean
  }
  profile: {
    name: string
    label: string | null
    description: string | null
  }
  features: Record<string, boolean>
  allowedAgents: string[] | null
  allowedTools: string[] | null
  allowedMcps: string[] | null
  runtime: {
    configSource: 'app'
    machineRuntimeConfig: 'disabled' | 'allowlisted'
    localStdioMcps: 'disabled' | 'allowlisted'
    hostProjectDirectories: 'disabled' | 'allowlisted'
    remoteApprovalResponses: 'disabled' | 'allowlisted'
  }
  projectSources: CloudRuntimePolicy['projectSources']
  gateway: {
    channelsEnabled: boolean
    webhooksEnabled: boolean
  }
  providerKeys: {
    allowedProviderIds: string[] | null
    kmsRefsEnabled: boolean
    kmsRefPrefixesConfigured: boolean
    envRefsEnabled: boolean
  }
}

export type CloudOverviewServiceOptions = {
  store: ControlPlaneStore
  policy: CloudRuntimePolicy
  identityPolicy: CloudIdentityPolicy
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
  assertOrgAdmin: (principal: CloudPrincipal) => void
  principalOrgId: (principal: CloudPrincipal) => string
  byokPolicyOverview: () => ByokPolicyOverview
}

export class CloudOverviewService {
  private readonly store: ControlPlaneStore
  private readonly policy: CloudRuntimePolicy
  private readonly identityPolicy: CloudIdentityPolicy
  private readonly ensurePrincipal: CloudOverviewServiceOptions['ensurePrincipal']
  private readonly assertOrgAdmin: CloudOverviewServiceOptions['assertOrgAdmin']
  private readonly principalOrgId: CloudOverviewServiceOptions['principalOrgId']
  private readonly byokPolicyOverview: CloudOverviewServiceOptions['byokPolicyOverview']

  constructor(options: CloudOverviewServiceOptions) {
    this.store = options.store
    this.policy = options.policy
    this.identityPolicy = options.identityPolicy
    this.ensurePrincipal = options.ensurePrincipal
    this.assertOrgAdmin = options.assertOrgAdmin
    this.principalOrgId = options.principalOrgId
    this.byokPolicyOverview = options.byokPolicyOverview
  }

  async getWorkspaceOverview(principal: CloudPrincipal): Promise<CloudWorkspaceOverview> {
    await this.ensurePrincipal(principal)
    const membership = await this.store.resolvePrincipalMembership({
      tenantId: principal.tenantId,
      accountId: principal.accountId || principal.userId,
      email: principal.email,
    })
    if (!membership) throw new CloudServiceError(403, 'Cloud membership is not active.')
    return {
      tenantId: principal.tenantId,
      tenantName: principal.tenantName || null,
      orgId: membership.org.orgId,
      orgName: membership.org.name,
      userId: principal.userId,
      accountId: membership.account.accountId,
      email: membership.account.email,
      role: membership.membership.role,
      profileName: this.policy.profileName,
      policy: {
        features: this.policy.features,
        allowedAgents: this.policy.allowedAgents,
        allowedTools: this.policy.allowedTools,
        allowedMcps: this.policy.allowedMcps,
        localFiles: 'disabled',
        localStdioMcps: 'disabled',
        machineRuntimeConfig: 'disabled',
      },
    }
  }

  async getAdminPolicyOverview(principal: CloudPrincipal): Promise<CloudAdminPolicyOverview> {
    await this.ensurePrincipal(principal)
    // NOTE: deliberately NOT admin-gated. The policy overview (allowed agents/tools/
    // features, signup mode, plan) is read-only-visible to any active member so the app
    // can show them what's permitted; member management + audit are the admin-only
    // surfaces. This member-read contract is asserted in cloud-http-server.test.ts
    // ("...preserving read-only policy"). Mutations elsewhere use assertOrgAdmin.
    const membership = await this.store.resolvePrincipalMembership({
      tenantId: principal.tenantId,
      accountId: principal.accountId || principal.userId,
      email: principal.email,
    })
    if (!membership) throw new CloudServiceError(403, 'Cloud membership is not active.')
    const signupMode = resolvedSignupMode(this.identityPolicy)
    return {
      org: {
        orgId: membership.org.orgId,
        tenantId: membership.org.tenantId,
        name: membership.org.name,
        planKey: membership.org.planKey,
        status: membership.org.status,
      },
      signup: {
        mode: signupMode,
        allowSelfServiceSignup: this.identityPolicy.allowSelfServiceSignup,
        allowedEmailDomains: [...(this.identityPolicy.allowedEmailDomains || [])],
        invitesEnabled: signupMode === 'invite',
      },
      profile: {
        name: this.policy.profileName,
        label: this.policy.profile.label || null,
        description: this.policy.profile.description || null,
      },
      features: this.policy.features,
      allowedAgents: this.policy.allowedAgents,
      allowedTools: this.policy.allowedTools,
      allowedMcps: this.policy.allowedMcps,
      runtime: {
        configSource: 'app',
        machineRuntimeConfig: this.policy.allowMachineRuntimeConfig ? 'allowlisted' : 'disabled',
        localStdioMcps: this.policy.allowLocalStdioMcps || this.policy.allowedLocalMcpNames.length ? 'allowlisted' : 'disabled',
        hostProjectDirectories: this.policy.allowHostProjectDirectories || this.policy.allowedHostProjectDirectories.length ? 'allowlisted' : 'disabled',
        remoteApprovalResponses: this.policy.allowRemoteApprovalResponses ? 'allowlisted' : 'disabled',
      },
      projectSources: this.policy.projectSources,
      gateway: {
        channelsEnabled: this.policy.features.agents !== false,
        webhooksEnabled: this.policy.features.webhooks !== false,
      },
      providerKeys: this.byokPolicyOverview(),
    }
  }

  async listAuditEvents(
    principal: CloudPrincipal,
    input: { limit?: number | null } = {},
  ) {
    await this.ensurePrincipal(principal)
    this.assertOrgAdmin(principal)
    return this.store.listAuditEvents(this.principalOrgId(principal), input.limit || 100)
  }
}
