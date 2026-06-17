import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import {
  ControlPlaneQuotaExceededError,
  type ControlPlaneStore,
} from '../apps/desktop/src/main/cloud/control-plane-store.ts'
import { InMemoryControlPlaneStore } from '../apps/desktop/src/main/cloud/in-memory-control-plane-store.ts'
import { createPostgresControlPlaneStore } from '../apps/desktop/src/main/cloud/postgres-control-plane-store.ts'
import { createPglitePool } from './helpers/pglite-pool.ts'

const POSTGRES_URL = process.env.OPEN_COWORK_TEST_POSTGRES_URL
  || process.env.OPEN_COWORK_CLOUD_TEST_POSTGRES_URL
const POSTGRES_SKIP = POSTGRES_URL
  ? false
  : 'Set OPEN_COWORK_TEST_POSTGRES_URL to run real Postgres control-plane contract tests.'

runControlPlaneDomainContracts('in-memory', async () => new InMemoryControlPlaneStore())
// Runs the *real* Postgres store SQL against an in-process PostgreSQL (pglite),
// so the Postgres control plane is verified everywhere — no DB daemon required.
runControlPlaneDomainContracts('pglite', async () => (
  createPostgresControlPlaneStore({ connectionString: 'pglite://memory', pool: createPglitePool() })
))
// Runs against a real external Postgres when OPEN_COWORK_TEST_POSTGRES_URL is set.
runControlPlaneDomainContracts('postgres', async () => {
  assert.ok(POSTGRES_URL)
  return createPostgresControlPlaneStore({ connectionString: POSTGRES_URL })
}, POSTGRES_SKIP)

// The WorkflowWebhookSecurityStore surface is implemented only by the Postgres store
// (no in-memory peer), so it gets its own pglite-backed contract. `nowMs` is a real
// epoch-ms (> int32) to guard the bigint blocked-until regression.
test('pglite webhook security store enforces fail-closed rate limit / auth backoff / replay claims', async () => {
  const store = await createPostgresControlPlaneStore({ connectionString: 'pglite://memory', pool: createPglitePool() })
  try {
    const prefix = `webhook-${randomUUID()}`
    const nowMs = 1_781_000_000_000

    assert.equal(await store.claimRequest({ source: `${prefix}-src`, nowMs, windowMs: 60_000, limit: 2 }), true)
    assert.equal(await store.claimRequest({ source: `${prefix}-src`, nowMs, windowMs: 60_000, limit: 2 }), true)
    assert.equal(await store.claimRequest({ source: `${prefix}-src`, nowMs, windowMs: 60_000, limit: 2 }), false)

    assert.equal(await store.checkAuthBackoff({ scope: `${prefix}-scope`, nowMs }), true)
    await store.recordAuthFailure({ scope: `${prefix}-scope`, source: `${prefix}-src`, nowMs, windowMs: 60_000, limit: 1, backoffMs: 60_000 })
    assert.equal(await store.checkAuthBackoff({ scope: `${prefix}-scope`, nowMs }), false)

    const claim = await store.claimSignature({ key: `${prefix}-sig`, nowMs, windowMs: 60_000, cacheLimit: 100 })
    assert.ok(claim)
    assert.equal(await store.claimSignature({ key: `${prefix}-sig`, nowMs, windowMs: 60_000, cacheLimit: 100 }), null)
    await claim?.release()
    const reclaim = await store.claimSignature({ key: `${prefix}-sig`, nowMs, windowMs: 60_000, cacheLimit: 100 })
    assert.ok(reclaim)
    await reclaim?.accept()
  } finally {
    await store.close?.()
  }
})

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

      // Event reads are bounded by an optional limit (the SSE replay hot path uses it;
      // omitting it returns the full stream). Append two more, then assert the bound.
      await store.appendSessionEvent({ tenantId, sessionId, eventId: `${prefix}-event-2`, type: 'assistant.message', payload: { messageId: 'assistant-2', content: 'ok' } })
      await store.appendSessionEvent({ tenantId, sessionId, eventId: `${prefix}-event-3`, type: 'assistant.message', payload: { messageId: 'assistant-3', content: 'ok' } })
      assert.equal((await store.listSessionEvents(tenantId, sessionId, 0, 2)).length, 2)
      assert.equal((await store.listSessionEvents(tenantId, sessionId, 0)).length, 3)

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
        tenantId: `${prefix}-spoofed-pool-tenant`,
        name: 'Managed pool',
        mode: 'self_hosted',
        capabilities: { profiles: ['default'] },
        actor: { actorType: 'user', actorId: accountId, accountId },
      } as Parameters<typeof store.createManagedWorkerPool>[0] & { tenantId: string })
      assert.equal(workerPool.status, 'active')
      assert.equal(workerPool.tenantId, tenantId)
      const managedWorker = await store.registerManagedWorker({
        workerId: `${prefix}-managed-worker`,
        orgId: org.orgId,
        poolId: workerPool.poolId,
        tenantId: `${prefix}-spoofed-worker-tenant`,
        displayName: 'Managed worker',
        capabilities: { runtime: 'opencode' },
        actor: { actorType: 'user', actorId: accountId, accountId },
      } as Parameters<typeof store.registerManagedWorker>[0] & { tenantId: string })
      assert.equal(managedWorker.status, 'pending')
      assert.equal(managedWorker.tenantId, tenantId)
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

      // API tokens — issue (hashed, not stored plaintext, deduped scopes), resolve by
      // plaintext, list, grant a channel binding, then revoke (resolution fails closed).
      const issuedToken = await store.issueApiToken({
        orgId: org.orgId,
        accountId: account.accountId,
        name: 'Contract token',
        scopes: ['sessions:read', 'sessions:read'],
      })
      assert.deepEqual(issuedToken.token.scopes, ['sessions:read'])
      assert.notEqual(issuedToken.token.tokenHash, issuedToken.plaintext)
      assert.equal(issuedToken.token.last4, issuedToken.plaintext.slice(-4))
      const resolvedToken = await store.findApiTokenByPlaintext(issuedToken.plaintext)
      assert.equal(resolvedToken?.tokenId, issuedToken.token.tokenId)
      // A correct token-id prefix with a tampered secret must still fail the hash check
      // (guards the O(1) by-id fast path against forged ids).
      assert.equal(await store.findApiTokenByPlaintext(`${issuedToken.plaintext}-tampered`), null)
      assert.equal((await store.listApiTokens(org.orgId)).some((apiToken) => apiToken.tokenId === issuedToken.token.tokenId), true)
      const grant = await store.grantApiTokenChannelBinding({
        orgId: org.orgId,
        tokenId: issuedToken.token.tokenId,
        channelBindingId,
      })
      assert.equal(grant.channelBindingId, channelBindingId)
      assert.deepEqual(
        (await store.listApiTokenChannelBindingGrants({ orgId: org.orgId, tokenId: issuedToken.token.tokenId })).map((entry) => entry.channelBindingId),
        [channelBindingId],
      )
      const revokedToken = await store.revokeApiToken({ orgId: org.orgId, tokenId: issuedToken.token.tokenId })
      assert.ok(revokedToken?.revokedAt)
      assert.equal(await store.findApiTokenByPlaintext(issuedToken.plaintext), null)

      // Setting metadata — tenant-scoped vs user-scoped upsert/get/list stay isolated.
      await store.setSettingMetadata({ tenantId, key: 'appearance', value: { theme: 'dark' } })
      assert.deepEqual((await store.getSettingMetadata(tenantId, 'appearance'))?.value, { theme: 'dark' })
      await store.setSettingMetadata({ tenantId, key: 'appearance', value: { theme: 'light' } })
      assert.deepEqual((await store.getSettingMetadata(tenantId, 'appearance'))?.value, { theme: 'light' })
      await store.setSettingMetadata({ tenantId, userId, key: 'editor', value: { fontSize: 14 } })
      assert.equal(await store.getSettingMetadata(tenantId, 'editor'), null)
      assert.deepEqual((await store.getSettingMetadata(tenantId, 'editor', userId))?.value, { fontSize: 14 })
      assert.deepEqual((await store.listSettingMetadata(tenantId)).map((entry) => entry.key), ['appearance'])
      assert.deepEqual((await store.listSettingMetadata(tenantId, userId)).map((entry) => entry.key), ['editor'])

      // Rate limiting — allowed up to the limit within a window, then denied with a retry hint.
      const rateLimitScope = `${prefix}-rate-limit`
      const rateLimitArgs = { scope: rateLimitScope, source: 'contract', limit: 2, windowMs: 60_000, now: new Date('2026-03-01T00:00:00.000Z') }
      assert.equal((await store.claimRateLimit(rateLimitArgs)).allowed, true)
      assert.equal((await store.claimRateLimit(rateLimitArgs)).count, 2)
      const rateLimitDenied = await store.claimRateLimit(rateLimitArgs)
      assert.equal(rateLimitDenied.allowed, false)
      assert.ok(rateLimitDenied.retryAfterMs > 0)

      // Auth backoff — a clean scope is allowed; once the failure limit is hit it blocks (fail-closed).
      const authBackoffScope = `${prefix}-auth-backoff`
      assert.equal((await store.checkCloudAuthBackoff({ scope: authBackoffScope })).allowed, true)
      await store.recordCloudAuthFailure({ scope: authBackoffScope, source: 'contract', limit: 1, windowMs: 60_000, backoffMs: 60_000 })
      const authBlocked = await store.checkCloudAuthBackoff({ scope: authBackoffScope })
      assert.equal(authBlocked.allowed, false)
      assert.ok(authBlocked.retryAfterMs > 0)

      // Worker heartbeats — upsert by worker id (active session ids deduped), then list.
      await store.recordWorkerHeartbeat({ workerId: `${prefix}-hb-worker`, role: 'worker', activeSessionIds: [sessionId, sessionId] })
      const workerHeartbeat = (await store.listWorkerHeartbeats()).find((entry) => entry.workerId === `${prefix}-hb-worker`)
      assert.equal(workerHeartbeat?.role, 'worker')
      assert.deepEqual(workerHeartbeat?.activeSessionIds, [sessionId])

      // Thread tags + smart filters — create/list, apply to a session (metadata reflects
      // it), remove (metadata clears), update, and smart-filter CRUD.
      const threadTag = await store.createThreadTag({ tenantId, tagId: `${prefix}-tag`, name: 'Priority', color: '#2f6bf0' })
      assert.equal(threadTag.name, 'Priority')
      assert.deepEqual((await store.listThreadTags(tenantId)).map((entry) => entry.tagId), [`${prefix}-tag`])
      await store.applyThreadTags({ tenantId, sessionIds: [sessionId], tagIds: [`${prefix}-tag`] })
      const taggedMetadata = (await store.listThreadMetadata({ tenantId, userId })).find((entry) => entry.sessionId === sessionId)
      assert.deepEqual(taggedMetadata?.tags.map((entry) => entry.tagId), [`${prefix}-tag`])
      await store.removeThreadTags({ tenantId, sessionIds: [sessionId], tagIds: [`${prefix}-tag`] })
      const clearedMetadata = (await store.listThreadMetadata({ tenantId, userId })).find((entry) => entry.sessionId === sessionId)
      assert.deepEqual(clearedMetadata?.tags, [])
      assert.equal((await store.updateThreadTag({ tenantId, tagId: `${prefix}-tag`, name: 'Urgent' }))?.name, 'Urgent')
      const smartFilter = await store.createThreadSmartFilter({ tenantId, filterId: `${prefix}-filter`, name: 'Open', query: { status: ['active'] } })
      assert.deepEqual(smartFilter.query, { status: ['active'] })
      assert.deepEqual((await store.listThreadSmartFilters(tenantId)).map((entry) => entry.filterId), [`${prefix}-filter`])
      assert.equal((await store.updateThreadSmartFilter({ tenantId, filterId: `${prefix}-filter`, name: 'Active' }))?.name, 'Active')
      assert.equal(await store.deleteThreadSmartFilter(tenantId, `${prefix}-filter`), true)
      assert.equal(await store.deleteThreadTag(tenantId, `${prefix}-tag`), true)

      // Workflows — create a draft, list/get it, create a run, claim it (claim token +
      // lease), then complete it (lease-token gated); the run reads back as completed.
      const workflowId = `${prefix}-workflow`
      await store.createWorkflow({
        tenantId,
        userId,
        workflowId,
        draft: { title: 'Contract workflow', instructions: 'Do the thing', agentName: 'default', triggers: [] },
      })
      assert.equal((await store.getWorkflow(tenantId, userId, workflowId))?.id, workflowId)
      assert.deepEqual((await store.listWorkflows(tenantId, userId)).map((entry) => entry.id), [workflowId])
      const workflowRun = await store.createWorkflowRun({
        tenantId,
        userId,
        workflowId,
        runId: `${prefix}-run`,
        triggerType: 'manual',
      })
      assert.equal(workflowRun.status, 'queued')
      const claimedRun = await store.claimDueWorkflowRun({ runId: `${prefix}-run`, claimedBy: `${prefix}-wf-worker`, leaseTtlMs: 30_000 })
      assert.equal(claimedRun?.run.id, `${prefix}-run`)
      assert.ok(claimedRun?.run.claimToken)
      await store.attachWorkflowRunSession({
        tenantId,
        workflowId,
        runId: `${prefix}-run`,
        sessionId,
        claimToken: claimedRun?.run.claimToken,
      })
      const completedRun = await store.completeWorkflowRun({
        tenantId,
        workflowId,
        runId: `${prefix}-run`,
        summary: 'done',
        nextStatus: 'active',
        nextRunAt: null,
      })
      assert.equal(completedRun?.status, 'completed')
      assert.equal((await store.getWorkflowRun(tenantId, `${prefix}-run`))?.status, 'completed')

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
