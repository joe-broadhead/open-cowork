import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CloudBillingService,
  CloudByokService,
  CloudChannelService,
  CloudIdentityService,
  CloudQuotaService,
  CloudWorkflowService,
} from '@open-cowork/cloud-server/services/index'
import { CloudChannelDomainService } from '@open-cowork/cloud-server/services/channel-domain-service'
import { CloudServiceError } from '@open-cowork/cloud-server/cloud-service-error'
import type { ByokSecretMetadata, ByokSecretStore } from '@open-cowork/cloud-server/byok-secret-store'
import type { CloudPrincipal } from '@open-cowork/cloud-server/session-service'
import type { HeadlessAgentRecord } from '@open-cowork/cloud-server/control-plane-store'
import type { ChannelControlPlaneStore } from '@open-cowork/cloud-server/control-plane-domains/channels'
import type { CloudUsageGovernanceService } from '@open-cowork/cloud-server/services/usage-governance-service'

const principal: CloudPrincipal = {
  tenantId: 'tenant-1',
  tenantName: 'Tenant 1',
  userId: 'user-1',
  email: 'user@example.test',
  orgId: 'org-1',
  accountId: 'account-1',
  role: 'owner',
  authSource: 'local',
}

function metadata(providerId = 'anthropic'): ByokSecretMetadata {
  return {
    secretId: `sec_${providerId}`,
    providerId,
    status: 'active',
    credentialKind: 'plaintext',
    last4: '1234',
    keyFingerprint: 'fp',
    lastValidatedAt: null,
    validationError: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
}

function byokStore(overrides: Partial<ByokSecretStore> = {}): ByokSecretStore {
  return {
    async listMetadata() { return [] },
    async getMetadata() { return null },
    async setSecret(input) { return metadata(input.providerId) },
    async disableSecret(_input) { return metadata(_input.providerId) },
    async recordValidation() { return null },
    async activateWithoutValidation(input) { return metadata(input.providerId) },
    async validateActiveSecret(input) { return metadata(input.providerId) },
    async revealActiveSecret() { return 'plaintext-key' },
    ...overrides,
  }
}

function assertPolicyManage(input: CloudPrincipal) {
  if (input.role !== 'owner' && input.role !== 'admin') {
    throw new CloudServiceError(403, 'BYOK credential administration requires policy:manage permission.')
  }
}

function unusedStoreAction(): Promise<never> {
  throw new Error('not used')
}

function channelStore(overrides: Partial<ChannelControlPlaneStore> = {}): ChannelControlPlaneStore {
  return {
    createHeadlessAgent: unusedStoreAction,
    updateHeadlessAgent: unusedStoreAction,
    getHeadlessAgent: unusedStoreAction,
    listHeadlessAgents: unusedStoreAction,
    createChannelBinding: unusedStoreAction,
    updateChannelBinding: unusedStoreAction,
    getChannelBinding: unusedStoreAction,
    listChannelBindings: unusedStoreAction,
    upsertChannelIdentity: unusedStoreAction,
    getChannelIdentity: unusedStoreAction,
    findChannelIdentity: unusedStoreAction,
    bindChannelSession: unusedStoreAction,
    getChannelSessionBinding: unusedStoreAction,
    findChannelSessionBindingByThread: unusedStoreAction,
    listChannelSessionBindingsForSession: unusedStoreAction,
    updateChannelCursor: unusedStoreAction,
    createChannelInteraction: unusedStoreAction,
    findChannelInteraction: unusedStoreAction,
    resolveChannelInteraction: unusedStoreAction,
    resolveChannelInteractionWithCommand: unusedStoreAction,
    createChannelDelivery: unusedStoreAction,
    listChannelDeliveries: unusedStoreAction,
    claimNextChannelDelivery: unusedStoreAction,
    ackChannelDelivery: unusedStoreAction,
    claimChannelProviderEvent: unusedStoreAction,
    completeChannelProviderEvent: unusedStoreAction,
    getSession: unusedStoreAction,
    getSessionProjection: unusedStoreAction,
    enqueueSessionCommand: unusedStoreAction,
    recordAuditEvent: unusedStoreAction,
    ...overrides,
  }
}

test('cloud domain services expose testable seams without an HTTP server', async () => {
  const calls: string[] = []

  const identity = new CloudIdentityService({
    async ensurePrincipal(input) {
      calls.push('identity.ensurePrincipal')
      return input
    },
    async getWorkspaceOverview(input) {
      calls.push('identity.getWorkspaceOverview')
      return {
        tenantId: input.tenantId,
        tenantName: input.tenantName || null,
        orgId: input.orgId || input.tenantId,
        orgName: input.tenantName || input.tenantId,
        userId: input.userId,
        accountId: input.accountId || input.userId,
        email: input.email,
        role: input.role || 'owner',
        profileName: 'default',
        policy: {
          features: {},
          allowedAgents: null,
          allowedTools: null,
          allowedMcps: null,
          localFiles: 'disabled',
          localStdioMcps: 'disabled',
          machineRuntimeConfig: 'disabled',
        },
      }
    },
    async listApiTokens() {
      calls.push('identity.listApiTokens')
      return []
    },
    async issueApiToken(input, tokenInput) {
      calls.push(`identity.issueApiToken:${tokenInput.name}`)
      return {
        token: {
          tokenId: 'tok_1',
          orgId: input.orgId || input.tenantId,
          accountId: input.accountId || null,
          name: tokenInput.name,
          scopes: tokenInput.scopes,
          last4: '1234',
          expiresAt: tokenInput.expiresAt?.toISOString() || null,
          revokedAt: null,
          lastUsedAt: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
        plaintext: 'token-plain',
      }
    },
    async revokeApiToken(_input, tokenId) {
      calls.push(`identity.revokeApiToken:${tokenId}`)
      return null
    },
  })

  const byok = new CloudByokService({
    ensurePrincipal: async (input) => input,
    principalOrgId: (input) => input.orgId || input.tenantId,
    assertPermission: assertPolicyManage,
    byokSecrets: byokStore({
      async listMetadata() {
        calls.push('byok.list')
        return []
      },
    }),
    assertBillingAllowed: async () => {},
  })

  const billing = new CloudBillingService({
    async getBillingSubscription() {
      calls.push('billing.subscription')
      return null
    },
    async createBillingCheckout() {
      calls.push('billing.checkout')
      return { providerId: 'stub', providerSessionId: 'sess_1', url: 'https://billing.example.test' }
    },
    async createBillingPortal() {
      calls.push('billing.portal')
      return { providerId: 'stub', url: 'https://billing.example.test/portal' }
    },
    async handleBillingWebhook() {
      calls.push('billing.webhook')
      return { providerId: 'stub', eventId: 'evt_1', status: 'ignored' }
    },
  })

  const quota = new CloudQuotaService({
    async assertArtifactUploadAllowed() { calls.push('quota.artifactAllowed') },
    async recordArtifactUploaded() { calls.push('quota.artifactUploaded') },
    async recordWorkerMinutes() { calls.push('quota.workerMinutes') },
    async listUsageEvents() {
      calls.push('quota.usage')
      return []
    },
    async claimHttpRateLimit() { calls.push('quota.rate') },
    async checkCloudAuthBackoff() { calls.push('quota.backoffCheck') },
    async recordCloudAuthFailure() { calls.push('quota.backoffRecord') },
  })

  const channel = new CloudChannelService({
    async listHeadlessAgents() { calls.push('channel.agents'); return [] },
    async createHeadlessAgent() { throw new Error('not needed') },
    async updateHeadlessAgent() { throw new Error('not needed') },
    async listChannelBindings() { calls.push('channel.bindings'); return [] },
    async createChannelBinding() { throw new Error('not needed') },
    async updateChannelBinding() { throw new Error('not needed') },
    async resolveChannelIdentity() { throw new Error('not needed') },
    async bindChannelSession() { throw new Error('not needed') },
    async getChannelSessionByThread() { return null },
    async updateChannelCursor() { return { ok: false, reason: 'not_found' } },
    async enqueueChannelPrompt() { throw new Error('not needed') },
    async createChannelInteraction() { throw new Error('not needed') },
    async resolveChannelInteraction() { throw new Error('not needed') },
    async createChannelDelivery() { throw new Error('not needed') },
    async listChannelDeliveries() { calls.push('channel.deliveries'); return [] },
    async retryChannelDelivery() { return null },
    async deadLetterChannelDelivery() { return null },
    async claimNextChannelDelivery() { return null },
    async ackChannelDelivery() { return null },
    async claimChannelProviderEvent() { throw new Error('not needed') },
    async completeChannelProviderEvent() { return null },
  })

  const workflow = new CloudWorkflowService({
    async listWorkflows() {
      calls.push('workflow.list')
      return { workflows: [] }
    },
    async getWorkflow() { return null },
    async createWorkflow() { throw new Error('not needed') },
    async updateWorkflowStatus() { return null },
    async runWorkflow() { throw new Error('not needed') },
    async claimAndStartDueWorkflow() { return null },
    async runWorkflowWebhook() { throw new Error('not needed') },
  })

  await identity.ensurePrincipal(principal)
  await identity.issueApiToken(principal, { name: 'Desktop', scopes: ['desktop'] })
  await byok.listSecrets(principal)
  await billing.getSubscription(principal)
  await quota.listUsageEvents(principal)
  await channel.listAgents(principal)
  await channel.listDeliveries(principal)
  await workflow.list(principal)

  assert.deepEqual(calls, [
    'identity.ensurePrincipal',
    'identity.issueApiToken:Desktop',
    'byok.list',
    'billing.subscription',
    'quota.usage',
    'channel.agents',
    'channel.deliveries',
    'workflow.list',
  ])
})

test('cloud BYOK service enforces storage, provider, KMS, billing, and audit boundaries', async () => {
  const calls: unknown[] = []
  const apiTokenPrincipal: CloudPrincipal = {
    ...principal,
    authSource: 'api_token',
    tokenId: 'tok_admin',
    tokenScopes: ['admin'],
  }
  const service = new CloudByokService({
    ensurePrincipal: async (input) => {
      calls.push('ensure')
      return input
    },
    principalOrgId: (input) => input.orgId || input.tenantId,
    assertPermission: assertPolicyManage,
    byokSecrets: byokStore({
      async setSecret(input) {
        calls.push({
          kind: 'setSecret',
          orgId: input.orgId,
          providerId: input.providerId,
          kmsRef: input.kmsRef,
          actor: input.actor,
          createdByAccountId: input.createdByAccountId,
        })
        return metadata(input.providerId)
      },
    }),
    byokPolicy: {
      allowedProviderIds: ['anthropic'],
      kmsRefs: {
        enabled: true,
        allowEnvRefs: false,
        allowedPrefixes: ['gcp-sm://projects/test/secrets/'],
      },
      checkEntitlement: async (input) => {
        calls.push({ kind: 'entitlement', orgId: input.orgId, providerId: input.providerId })
        return { allowed: true }
      },
    },
    assertBillingAllowed: async (input) => {
      calls.push({ kind: 'billing', orgId: input.orgId, action: input.action, providerId: input.providerId })
    },
  })

  await assert.rejects(
    () => new CloudByokService({
      ensurePrincipal: async (input) => input,
      principalOrgId: (input) => input.orgId || input.tenantId,
      assertPermission: assertPolicyManage,
      byokSecrets: null,
      assertBillingAllowed: async () => {},
    }).listSecrets(principal),
    /BYOK secret storage is not configured/,
  )
  await assert.rejects(
    () => service.setSecret(apiTokenPrincipal, { providerId: 'openai', plaintext: 'sk-test' }),
    /not enabled for BYOK/,
  )
  await assert.rejects(
    () => service.setSecret(apiTokenPrincipal, { providerId: 'anthropic', kmsRef: 'env:ANTHROPIC_API_KEY' }),
    /Environment-backed BYOK references are not enabled/,
  )
  await assert.rejects(
    () => service.setSecret(apiTokenPrincipal, { providerId: 'anthropic', kmsRef: 'aws-sm://secret' }),
    /KMS-backed BYOK reference is not allowed/,
  )

  const result = await service.setSecret(apiTokenPrincipal, {
    providerId: 'Anthropic',
    kmsRef: 'gcp-sm://projects/test/secrets/anthropic-key',
  })

  assert.equal(result.providerId, 'anthropic')
  assert.deepEqual(calls, [
    'ensure',
    'ensure',
    'ensure',
    'ensure',
    { kind: 'billing', orgId: 'org-1', action: 'byok.provider', providerId: 'anthropic' },
    { kind: 'entitlement', orgId: 'org-1', providerId: 'anthropic' },
    {
      kind: 'setSecret',
      orgId: 'org-1',
      providerId: 'anthropic',
      kmsRef: 'gcp-sm://projects/test/secrets/anthropic-key',
      actor: {
        actorType: 'api_token',
        actorId: 'tok_admin',
        accountId: 'account-1',
      },
      createdByAccountId: 'account-1',
    },
  ])
})

test('cloud BYOK service never billing-gates reads or revocation (#906)', async () => {
  const store: string[] = []
  const admin: CloudPrincipal = { ...principal, authSource: 'api_token', tokenId: 'tok_admin', tokenScopes: ['admin'] }
  const service = new CloudByokService({
    ensurePrincipal: async (input) => input,
    principalOrgId: (input) => input.orgId || input.tenantId,
    assertPermission: assertPolicyManage,
    byokSecrets: byokStore({
      async getMetadata() { store.push('getMetadata'); return metadata('anthropic') },
      async disableSecret(input) { store.push('disableSecret'); return metadata(input.providerId) },
      async setSecret(input) { store.push('setSecret'); return metadata(input.providerId) },
    }),
    byokPolicy: { allowedProviderIds: ['anthropic'] },
    // Simulate a past_due subscription: the billing gate always denies. Reads and
    // revocation must still succeed; only writes may be blocked.
    assertBillingAllowed: async () => { throw new CloudServiceError(402, 'subscription past_due') },
  })

  assert.equal((await service.getSecret(admin, 'anthropic'))?.providerId, 'anthropic')
  assert.equal((await service.disableSecret(admin, 'anthropic'))?.providerId, 'anthropic')
  await assert.rejects(
    () => service.setSecret(admin, { providerId: 'anthropic', plaintext: 'sk-test' }),
    /past_due/,
  )
  // The write never reached the store; the read + revoke did.
  assert.deepEqual(store, ['getMetadata', 'disableSecret'])
})

test('cloud channel domain service owns channel agent listing behind explicit dependencies', async () => {
  const calls: unknown[] = []
  const agents: HeadlessAgentRecord[] = [
    {
      agentId: 'agent-1',
      orgId: 'org-1',
      tenantId: 'tenant-1',
      profileName: 'default',
      name: 'Agent 1',
      status: 'active',
      managed: true,
      createdByAccountId: 'account-1',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
    {
      agentId: 'agent-2',
      orgId: 'org-1',
      tenantId: 'tenant-1',
      profileName: 'default',
      name: 'Agent 2',
      status: 'disabled',
      managed: false,
      createdByAccountId: 'account-1',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  ]
  const service = new CloudChannelDomainService({
    store: channelStore({
      async listHeadlessAgents(orgId: string) {
        calls.push({ kind: 'listHeadlessAgents', orgId })
        return agents
      },
    }),
    policy: { profileName: 'default', profile: {}, features: {} } as never,
    ids: { randomUUID: () => 'id-1' },
    abuse: {} as never,
    usageGovernance: {} as CloudUsageGovernanceService,
    async ensurePrincipal(input) {
      calls.push({ kind: 'ensurePrincipal', tenantId: input.tenantId })
      input.orgId = 'org-1'
      input.accountId = 'account-1'
    },
    principalOrgId: (input) => input.orgId || input.tenantId,
    assertBillingAllowed: async () => { throw new Error('not used') },
    normalizeAndValidateProjectSource: () => { throw new Error('not used') },
    createCloudSessionRecord: async () => { throw new Error('not used') },
    bindSessionProjectSource: async () => { throw new Error('not used') },
    getTenantSessionView: async () => { throw new Error('not used') },
    assertRemoteInteractionAllowed: async () => { throw new Error('not used') },
    auditActor: (input) => ({
      actorType: 'user',
      actorId: input.userId,
      accountId: input.accountId || null,
    }),
    stableCloudId: (prefix) => `${prefix}_stable`,
  })

  const listed = await service.listHeadlessAgents({ ...principal }, { limit: 1 })

  assert.deepEqual(listed.map((agent) => agent.agentId), ['agent-1'])
  assert.deepEqual(calls, [
    { kind: 'ensurePrincipal', tenantId: 'tenant-1' },
    { kind: 'listHeadlessAgents', orgId: 'org-1' },
  ])
})

function channelDomainServiceForResolve(storeOverrides: Partial<ChannelControlPlaneStore>) {
  return new CloudChannelDomainService({
    store: channelStore(storeOverrides),
    policy: { profileName: 'default', profile: {}, features: {} } as never,
    ids: { randomUUID: () => 'cmd-1' },
    abuse: {} as never,
    usageGovernance: {} as CloudUsageGovernanceService,
    async ensurePrincipal(input) { input.orgId = 'org-1'; input.accountId = 'account-1' },
    principalOrgId: (input) => input.orgId || input.tenantId,
    assertBillingAllowed: async () => { throw new Error('not used') },
    normalizeAndValidateProjectSource: () => { throw new Error('not used') },
    createCloudSessionRecord: async () => { throw new Error('not used') },
    bindSessionProjectSource: async () => { throw new Error('not used') },
    getTenantSessionView: async () => { throw new Error('not used') },
    assertRemoteInteractionAllowed: async () => ({ allowed: true }) as never,
    auditActor: (input) => ({ actorType: 'user', actorId: input.userId, accountId: input.accountId || null }),
    stableCloudId: (prefix) => `${prefix}_stable`,
  })
}

// A pending permission interaction bound to session ses-1, and an approve-capable Telegram identity
// (no workspace scoping, so the workspace match alone is null===null).
const scopingInteraction = { interactionId: 'int-1', orgId: 'org-1', agentId: 'agent-1', sessionId: 'ses-1', provider: 'telegram', externalInteractionId: null, tokenHash: 'hash', kind: 'permission', targetId: 'perm-1', status: 'pending', createdByIdentityId: null, expiresAt: new Date(Date.now() + 60_000).toISOString(), usedAt: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as never
const scopingIdentity = { identityId: 'id-bob', orgId: 'org-1', provider: 'telegram', externalWorkspaceId: null, externalUserId: 'bob', role: 'member', status: 'active', accountId: 'account-1', displayName: null, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as never
const scopingBinding = { bindingId: 'b1', orgId: 'org-1', agentId: 'agent-1', channelBindingId: 'cb1', provider: 'telegram', externalWorkspaceId: null, externalThreadId: 'thr-A', externalChatId: 'chat-A', sessionId: 'ses-1', lastEventSequence: 0, lastWorkspaceSequence: 0, lastChatMessageId: null, status: 'active', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as never
const scopingChannelBinding = { channelBindingId: 'cb1', externalWorkspaceId: null } as never

test('channel approval is rejected for a responder acting from a different chat (#922)', async () => {
  const service = channelDomainServiceForResolve({
    async findChannelInteraction() { return scopingInteraction },
    async findChannelIdentity() { return scopingIdentity },
    async listChannelSessionBindingsForSession() { return [scopingBinding] },
    async getChannelBinding() { return scopingChannelBinding },
  })
  // Bob approves from chat-B, but the interaction's session is bound to chat-A.
  await assert.rejects(
    service.resolveChannelInteraction({ ...principal }, {
      provider: 'telegram',
      externalUserId: 'bob',
      externalChatId: 'chat-B',
      token: 'occi_int-1_secret',
      response: { allowed: true },
    }),
    (error: unknown) => error instanceof CloudServiceError && error.status === 403 && /not authorized for this channel session/.test(error.message),
  )
})

test('channel approval clears the actor check for a responder in the same chat (#922)', async () => {
  const service = channelDomainServiceForResolve({
    async findChannelInteraction() { return scopingInteraction },
    async findChannelIdentity() { return scopingIdentity },
    async listChannelSessionBindingsForSession() { return [scopingBinding] },
    async getChannelBinding() { return scopingChannelBinding },
    // Reached only after the actor/chat check passes; returning null makes resolve fail at the next
    // step with a distinct error, proving same-chat responders are not blocked by the scoping.
    async getSession() { return null },
  })
  await assert.rejects(
    service.resolveChannelInteraction({ ...principal }, {
      provider: 'telegram',
      externalUserId: 'bob',
      externalChatId: 'chat-A',
      token: 'occi_int-1_secret',
      response: { allowed: true },
    }),
    (error: unknown) => error instanceof CloudServiceError && error.status === 403 && /requires a session owned by the gateway principal/.test(error.message),
  )
})

test('cloud BYOK service rejects non-admin principals before billing or mutation', async () => {
  const calls: string[] = []
  const service = new CloudByokService({
    ensurePrincipal: async (input) => input,
    principalOrgId: (input) => input.orgId || input.tenantId,
    assertPermission: assertPolicyManage,
    byokSecrets: byokStore({
      async setSecret(input) {
        calls.push(`set:${input.providerId}`)
        return metadata(input.providerId)
      },
    }),
    assertBillingAllowed: async () => {
      calls.push('billing')
    },
  })
  const member: CloudPrincipal = { ...principal, authSource: 'user', role: 'member' }

  await assert.rejects(
    () => service.setSecret(member, { providerId: 'anthropic', plaintext: 'sk-test' }),
    (error) => error instanceof CloudServiceError
      && error.status === 403
      && /BYOK credential administration/.test(error.message),
  )
  assert.deepEqual(calls, [])
})
