import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import {
  ControlPlaneQuotaExceededError,
  type ControlPlaneStore,
} from '../apps/desktop/src/main/cloud/control-plane-store.ts'
import { InMemoryControlPlaneStore } from '../apps/desktop/src/main/cloud/in-memory-control-plane-store.ts'
import { createPostgresControlPlaneStore } from '../apps/desktop/src/main/cloud/postgres-control-plane-store.ts'

const POSTGRES_URL = process.env.OPEN_COWORK_TEST_POSTGRES_URL
  || process.env.OPEN_COWORK_CLOUD_TEST_POSTGRES_URL
const POSTGRES_SKIP = POSTGRES_URL
  ? false
  : 'Set OPEN_COWORK_TEST_POSTGRES_URL to run real Postgres control-plane contract tests.'

runControlPlaneDomainContracts('in-memory', async () => new InMemoryControlPlaneStore())
runControlPlaneDomainContracts('postgres', async () => {
  assert.ok(POSTGRES_URL)
  return createPostgresControlPlaneStore({ connectionString: POSTGRES_URL })
}, POSTGRES_SKIP)

function runControlPlaneDomainContracts(
  name: string,
  createStore: () => Promise<ControlPlaneStore> | ControlPlaneStore,
  skip?: false | string,
) {
  test(`${name} control plane implements shared identity/session/channel/BYOK/billing contracts`, { skip }, async () => {
    const store = await createStore()
    const prefix = `${name}-${randomUUID()}`
    const tenantId = `${prefix}-tenant`
    const userId = `${prefix}-user`
    const sessionId = `${prefix}-session`
    const accountId = `${prefix}-account`
    const agentId = `${prefix}-agent`
    const channelBindingId = `${prefix}-channel-binding`

    try {
      await store.createTenant({ tenantId, name: 'Contract tenant' })
      await store.ensureUser({ tenantId, userId, email: `${userId}@example.test`, role: 'owner' })
      const org = await store.ensureOrgForTenant({ tenantId, orgId: `${prefix}-org`, name: 'Contract org' })
      const account = await store.createAccount({
        accountId,
        idpSubject: `${prefix}-subject`,
        email: `${accountId}@example.test`,
        displayName: 'Contract Account',
      })
      await store.upsertMembership({
        orgId: org.orgId,
        accountId: account.accountId,
        role: 'owner',
        status: 'active',
      })
      const principal = await store.resolvePrincipalMembership({ tenantId, accountId })
      assert.equal(principal?.org.orgId, org.orgId)
      const invitedEmail = `${prefix}-invitee@example.test`
      const invitedAccount = await store.createAccount({
        accountId: `${prefix}-invited-account`,
        email: invitedEmail,
      })
      await store.upsertMembership({
        orgId: org.orgId,
        accountId: invitedAccount.accountId,
        role: 'member',
        status: 'invited',
      })
      const invitedPrincipal = await store.resolvePrincipalMembership({
        tenantId,
        accountId: `${prefix}-oidc-subject`,
        idpSubject: `${prefix}-oidc-subject`,
        email: invitedEmail,
      })
      assert.equal(invitedPrincipal?.account.accountId, invitedAccount.accountId)
      assert.equal(invitedPrincipal?.membership.status, 'invited')

      await store.createSession({
        tenantId,
        userId,
        sessionId,
        opencodeSessionId: `${prefix}-runtime`,
        profileName: 'default',
        title: 'Contract session',
      })
      const firstSessionPage = await store.listSessionsPage({ tenantId, userId, limit: 1 })
      assert.deepEqual(firstSessionPage.items.map((session) => session.sessionId), [sessionId])
      assert.equal(firstSessionPage.nextCursor, null)

      const sameUpdatedAt = new Date('2026-01-02T00:00:00.000Z')
      for (const suffix of ['a', 'b', 'c']) {
        await store.createSession({
          tenantId,
          userId,
          sessionId: `${prefix}-page-${suffix}`,
          opencodeSessionId: `${prefix}-runtime-${suffix}`,
          profileName: suffix === 'c' ? 'data-analyst' : 'default',
          title: `cursor-contract ${suffix}`,
          createdAt: sameUpdatedAt,
        })
      }
      const cursorPageOne = await store.listSessionsPage({ tenantId, userId, limit: 2, query: 'cursor-contract' })
      assert.deepEqual(cursorPageOne.items.map((session) => session.sessionId), [`${prefix}-page-a`, `${prefix}-page-b`])
      assert.ok(cursorPageOne.nextCursor)
      const cursorPageTwo = await store.listSessionsPage({ tenantId, userId, limit: 2, query: 'cursor-contract', cursor: cursorPageOne.nextCursor })
      assert.deepEqual(cursorPageTwo.items.map((session) => session.sessionId), [`${prefix}-page-c`])
      assert.equal(new Set([...cursorPageOne.items, ...cursorPageTwo.items].map((session) => session.sessionId)).size, 3)
      await assert.rejects(
        Promise.resolve().then(() => store.listSessionsPage({ tenantId, userId, limit: 2, query: 'changed-filter', cursor: cursorPageOne.nextCursor })),
        /cursor/i,
      )
      const event = await store.appendSessionEvent({
        tenantId,
        sessionId,
        eventId: `${prefix}-event`,
        type: 'assistant.message',
        payload: { messageId: 'assistant-1', content: 'ok' },
      })
      await store.writeSessionProjection({
        tenantId,
        sessionId,
        sequence: event.sequence,
        view: {
          messages: [],
          taskRuns: [],
          pendingQuestions: [],
          pendingPermissions: [],
          artifacts: [],
          todos: [],
          errors: [],
          status: 'idle',
          usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, costUsd: 0 },
        },
      })
      assert.equal((await store.getSessionProjection(tenantId, sessionId))?.sequence, event.sequence)

      const command = await store.enqueueSessionCommand({
        commandId: `${prefix}-command`,
        tenantId,
        userId,
        sessionId,
        kind: 'prompt',
        payload: { text: 'contract prompt' },
      })
      assert.equal(command.status, 'pending')
      const runnableClaim = await store.claimRunnableSessions({
        workerId: `${prefix}-worker`,
        limit: 10,
        now: new Date('2026-01-01T00:00:00.000Z'),
        ttlMs: 30_000,
      })
      assert.equal(runnableClaim.pendingSessionCountEstimate >= 1, true)
      assert.equal(runnableClaim.leases.some((lease) => lease.sessionId === sessionId), true)

      const workerPool = await store.createManagedWorkerPool({
        poolId: `${prefix}-pool`,
        orgId: org.orgId,
        tenantId,
        name: 'Managed pool',
        mode: 'self_hosted',
        capabilities: { profiles: ['default'] },
        actor: { actorType: 'user', actorId: accountId, accountId },
      })
      assert.equal(workerPool.status, 'active')
      const managedWorker = await store.registerManagedWorker({
        workerId: `${prefix}-managed-worker`,
        orgId: org.orgId,
        poolId: workerPool.poolId,
        displayName: 'Managed worker',
        capabilities: { runtime: 'opencode' },
        actor: { actorType: 'user', actorId: accountId, accountId },
      })
      assert.equal(managedWorker.status, 'pending')
      await store.updateManagedWorkerStatus({
        orgId: org.orgId,
        workerId: managedWorker.workerId,
        status: 'active',
        actor: { actorType: 'user', actorId: accountId, accountId },
      })
      const issuedWorkerCredential = await store.issueManagedWorkerCredential({
        orgId: org.orgId,
        workerId: managedWorker.workerId,
        secret: `${prefix}-worker-secret`,
        actor: { actorType: 'user', actorId: accountId, accountId },
      })
      assert.match(issuedWorkerCredential.plaintext, /^ocw_/)
      assert.notEqual(issuedWorkerCredential.credential.tokenHash, issuedWorkerCredential.plaintext)
      const resolvedWorkerCredential = await store.findManagedWorkerCredentialByPlaintext(issuedWorkerCredential.plaintext)
      assert.equal(resolvedWorkerCredential?.worker.workerId, managedWorker.workerId)
      const heartbeat = await store.recordManagedWorkerHeartbeat({
        orgId: org.orgId,
        workerId: managedWorker.workerId,
        credentialId: issuedWorkerCredential.credential.credentialId,
        version: 'test-version',
        currentLoad: 1,
        activeWorkIds: ['work-1', 'work-1'],
      })
      assert.deepEqual(heartbeat.activeWorkIds, ['work-1'])
      assert.equal((await store.listManagedWorkerHeartbeats(org.orgId, { workerId: managedWorker.workerId })).length, 1)
      const revokedWorkerCredential = await store.revokeManagedWorkerCredential({
        orgId: org.orgId,
        workerId: managedWorker.workerId,
        credentialId: issuedWorkerCredential.credential.credentialId,
        actor: { actorType: 'user', actorId: accountId, accountId },
      })
      assert.equal(revokedWorkerCredential?.revokedAt !== null, true)
      assert.equal(await store.findManagedWorkerCredentialByPlaintext(issuedWorkerCredential.plaintext), null)
      const heartbeatRejectionAudit = await store.listAuditEvents(org.orgId, 20)
      assert.equal(heartbeatRejectionAudit.some((auditEvent) => (
        auditEvent.eventType === 'managed_worker_heartbeat.rejected'
        && auditEvent.metadata.reason === 'credential_revoked'
      )), true)
      assert.equal(JSON.stringify(heartbeatRejectionAudit).includes(issuedWorkerCredential.plaintext), false)

      await store.createHeadlessAgent({
        orgId: org.orgId,
        tenantId,
        agentId,
        profileName: 'default',
        name: 'Contract gateway agent',
        managed: false,
        createdByAccountId: accountId,
      })
      await store.createChannelBinding({
        orgId: org.orgId,
        agentId,
        bindingId: channelBindingId,
        provider: 'webhook',
        externalWorkspaceId: 'workspace-1',
        displayName: 'Webhook',
      })
      await assert.rejects(
        Promise.resolve().then(() => store.createChannelBinding({
          orgId: org.orgId,
          agentId,
          bindingId: `${prefix}-channel-binding-over-limit`,
          provider: 'slack',
          externalWorkspaceId: 'workspace-2',
          displayName: 'Slack',
          quota: {
            maxGatewayChannelBindingsPerOrg: 1,
            policyCode: 'quota.gateway_channel_bindings_exceeded',
          },
        })),
        ControlPlaneQuotaExceededError,
      )
      const identity = await store.upsertChannelIdentity({
        orgId: org.orgId,
        provider: 'webhook',
        externalWorkspaceId: 'workspace-1',
        externalUserId: 'user-1',
        accountId,
        role: 'approver',
        status: 'active',
      })
      const binding = await store.bindChannelSession({
        bindingId: `${prefix}-session-binding`,
        orgId: org.orgId,
        agentId,
        channelBindingId,
        provider: 'webhook',
        externalWorkspaceId: 'workspace-1',
        externalChatId: 'chat-1',
        externalThreadId: 'thread-1',
        sessionId,
      })
      assert.equal(binding.sessionId, sessionId)
      assert.equal((await store.getChannelIdentity(org.orgId, identity.identityId))?.role, 'approver')

      const byok = await store.createByokSecret({
        secretId: `${prefix}-secret`,
        orgId: org.orgId,
        providerId: 'anthropic',
        ciphertext: 'ciphertext',
        last4: '1234',
        keyFingerprint: `${prefix}-fingerprint`,
        createdByAccountId: accountId,
      })
      assert.equal(byok.status, 'pending_validation')
      assert.equal(await store.getActiveByokSecret(org.orgId, 'anthropic'), null)
      const validatedByok = await store.recordByokSecretValidation({
        orgId: org.orgId,
        providerId: 'anthropic',
        secretId: byok.secretId,
        status: 'active',
      })
      assert.equal(validatedByok?.status, 'active')
      assert.equal((await store.getActiveByokSecret(org.orgId, 'anthropic'))?.secretId, byok.secretId)

      const subscription = await store.upsertBillingSubscription({
        orgId: org.orgId,
        planKey: 'pro',
        providerId: 'stub',
        providerCustomerId: `${prefix}-customer`,
        providerSubscriptionId: `${prefix}-subscription`,
        status: 'active',
        seats: 1,
        entitlements: { allowNewSessions: true },
        metadata: { source: 'contract' },
      })
      assert.equal((await store.getBillingSubscription(org.orgId))?.providerSubscriptionId, subscription.providerSubscriptionId)
    } finally {
      await store.close?.()
    }
  })
}
