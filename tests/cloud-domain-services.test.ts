import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CloudBillingService,
  CloudByokService,
  CloudChannelService,
  CloudIdentityService,
  CloudQuotaService,
  CloudWorkflowService,
} from '../apps/desktop/src/main/cloud/services/index.ts'
import { CloudServiceError } from '../apps/desktop/src/main/cloud/cloud-service-error.ts'
import type { ByokSecretMetadata, ByokSecretStore } from '../apps/desktop/src/main/cloud/byok-secret-store.ts'
import type { CloudPrincipal } from '../apps/desktop/src/main/cloud/session-service.ts'

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
    async updateChannelCursor() { return null },
    async enqueueChannelPrompt() { throw new Error('not needed') },
    async createChannelInteraction() { throw new Error('not needed') },
    async resolveChannelInteraction() { throw new Error('not needed') },
    async createChannelDelivery() { throw new Error('not needed') },
    async listChannelDeliveries() { calls.push('channel.deliveries'); return [] },
    async retryChannelDelivery() { return null },
    async deadLetterChannelDelivery() { return null },
    async claimNextChannelDelivery() { return null },
    async ackChannelDelivery() { return null },
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

test('cloud BYOK service rejects non-admin principals before billing or mutation', async () => {
  const calls: string[] = []
  const service = new CloudByokService({
    ensurePrincipal: async (input) => input,
    principalOrgId: (input) => input.orgId || input.tenantId,
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
