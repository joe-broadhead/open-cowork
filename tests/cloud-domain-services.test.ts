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
    async listByokSecrets() {
      calls.push('byok.list')
      return []
    },
    async getByokSecret() {
      calls.push('byok.get')
      return null
    },
    async setByokSecret() {
      calls.push('byok.set')
      return {
        secretId: 'sec_1',
        orgId: 'org-1',
        providerId: 'anthropic',
        status: 'active',
        last4: '1234',
        keyFingerprint: 'fp',
        kmsRef: null,
        lastValidatedAt: null,
        validationError: null,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }
    },
    async validateByokSecret() {
      calls.push('byok.validate')
      return null
    },
    async overrideByokSecretValidation() {
      calls.push('byok.override')
      return null
    },
    async disableByokSecret() {
      calls.push('byok.disable')
      return null
    },
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
