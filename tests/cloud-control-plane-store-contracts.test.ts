import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import {
  ControlPlaneQuotaExceededError,
  type ControlPlaneStore,
} from '@open-cowork/cloud-server/control-plane-store'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { createPostgresControlPlaneStore } from '@open-cowork/cloud-server/postgres-control-plane-store'
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

// The concurrency gauge (P2-7) is a Postgres-only mechanism (in-memory counts live), so it gets a
// dedicated pglite contract that inspects the raw counter row the parametrized contract can't reach.
test('pglite concurrency gauge keeps a true running sum, clamps reads, and reconciles drift', async () => {
  const pool = createPglitePool()
  const store = await createPostgresControlPlaneStore({ connectionString: 'pglite://memory', pool })
  try {
    const prefix = `conc-${randomUUID()}`
    const tenantId = `${prefix}-tenant`
    const userId = `${prefix}-user`
    await store.createTenant({ tenantId, name: 'Concurrency' })
    const org = await store.ensureOrgForTenant({ tenantId, orgId: `${prefix}-org`, name: 'Concurrency org', status: 'active' })
    await store.ensureUser({ tenantId, userId, email: 'conc@example.test', role: 'owner' })

    const rawValue = async () => {
      const result = await pool.query(
        `SELECT value FROM cloud_concurrency_counters WHERE scope_id = $1 AND counter_key = 'concurrent_sessions'`,
        [org.orgId],
      )
      return Number((result.rows[0] as { value?: number } | undefined)?.value ?? 0)
    }

    await store.createSession({ tenantId, userId, sessionId: `${prefix}-s1`, opencodeSessionId: `${prefix}-r1`, profileName: 'default', title: 'one' })
    await store.createSession({ tenantId, userId, sessionId: `${prefix}-s2`, opencodeSessionId: `${prefix}-r2`, profileName: 'default', title: 'two' })
    assert.equal(await rawValue(), 2)

    // Closing one session decrements the gauge — the decrement is NOT lost (no write-side clamp).
    await store.updateSessionStatus({ tenantId, sessionId: `${prefix}-s1`, status: 'closed' })
    assert.equal(await rawValue(), 1)

    // Simulate drift accumulated under the old clamp by forcing the raw value negative. The admission
    // read floors it at 0 (GREATEST), and reconcile restores the true active count (1 open session).
    await pool.query(`UPDATE cloud_concurrency_counters SET value = -7 WHERE scope_id = $1 AND counter_key = 'concurrent_sessions'`, [org.orgId])
    const clampedRead = await pool.query(
      `SELECT GREATEST(0, value)::int AS v FROM cloud_concurrency_counters WHERE scope_id = $1 AND counter_key = 'concurrent_sessions'`,
      [org.orgId],
    )
    assert.equal(Number((clampedRead.rows[0] as { v: number }).v), 0)
    assert.ok(await store.reconcileConcurrencyCounters() >= 1, 'reconcile should touch the drifted counter row')
    assert.equal(await rawValue(), 1)
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
      // Aggregate stats (used by projection-status) match the event log without loading it.
      assert.deepEqual(await store.getSessionEventStats(tenantId, sessionId), { count: 3, latestSequence: 3 })

      const command = await store.enqueueSessionCommand({
        commandId: `${prefix}-command`,
        tenantId,
        userId,
        sessionId,
        kind: 'prompt',
        payload: { text: 'contract prompt' },
      })
      assert.equal(command.status, 'pending')
      // command_id is globally unique (PK): reusing it in a DIFFERENT session must be
      // rejected identically by both stores. Regression guard for the prior in-memory
      // bug where the lookup was scoped to the session and silently created a new command.
      // async wrapper so the in-memory store's synchronous throw and the postgres
      // store's rejected promise both normalize to a rejection for assert.rejects.
      await assert.rejects(
        async () => { await store.enqueueSessionCommand({
          commandId: `${prefix}-command`,
          tenantId,
          userId,
          sessionId: `${prefix}-page-a`,
          kind: 'prompt',
          payload: { text: 'contract prompt' },
        }) },
        /was reused with different content/,
      )
      const runnableClaim = await store.claimRunnableSessions({
        workerId: `${prefix}-worker`,
        limit: 10,
        now: new Date('2026-01-01T00:00:00.000Z'),
        ttlMs: 30_000,
      })
      assert.equal(runnableClaim.pendingSessionCountEstimate >= 1, true)
      assert.equal(runnableClaim.leases.some((lease) => lease.sessionId === sessionId), true)

      // Claim/fencing parity (audit P1-O6): these are exactly the lease-fenced/atomic-claim methods
      // where a subtle SQL difference causes prod double-claims, yet they were exercised by neither the
      // always-on contract nor (un-skipped) the postgres concurrency proofs. Run them on both stores.
      const commandLease = runnableClaim.leases.find((lease) => lease.sessionId === sessionId)
      assert.ok(commandLease)
      // The lease-fenced command claim hands the pending command to exactly one holder, once.
      const claimedCommand = await store.claimNextSessionCommand(commandLease!, new Date('2026-01-01T00:00:05.000Z'))
      assert.equal(claimedCommand?.commandId, `${prefix}-command`)
      assert.equal(claimedCommand?.claimedLeaseToken, commandLease!.leaseToken)
      assert.equal(await store.claimNextSessionCommand(commandLease!, new Date('2026-01-01T00:00:05.000Z')), null)

      // listRunnableSessions (previously untested anywhere) returns the same well-formed shape on both.
      const runnableList = await store.listRunnableSessions({ limit: 10, now: new Date('2026-01-01T00:00:05.000Z') })
      assert.equal(Array.isArray(runnableList.sessions), true)
      assert.equal(Number.isFinite(runnableList.pendingSessionCountEstimate), true)

      // The provider-event claim is atomic: the first claim wins, a re-claim of the same event id is a
      // no-op duplicate (the prod cross-gateway dedup guarantee).
      const providerEventClaim = await store.claimChannelProviderEvent({
        orgId: org.orgId,
        provider: 'telegram',
        providerInstanceId: 'telegram-prod',
        externalWorkspaceId: 'bot-1',
        providerEventId: `${prefix}-provider-event`,
        eventType: 'message',
        claimedBy: 'gateway-a',
        ttlMs: 30_000,
        now: new Date('2026-01-01T00:00:00.000Z'),
      })
      assert.equal(providerEventClaim.claimed, true)
      assert.equal(providerEventClaim.duplicate, false)
      assert.equal(providerEventClaim.event.status, 'processing')
      const providerEventDuplicate = await store.claimChannelProviderEvent({
        orgId: org.orgId,
        provider: 'telegram',
        providerInstanceId: 'telegram-prod',
        externalWorkspaceId: 'bot-1',
        providerEventId: `${prefix}-provider-event`,
        eventType: 'message',
        claimedBy: 'gateway-b',
        ttlMs: 30_000,
        now: new Date('2026-01-01T00:00:01.000Z'),
      })
      assert.equal(providerEventDuplicate.claimed, false)
      assert.equal(providerEventDuplicate.duplicate, true)

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

      // Channel-delivery claim parity (audit P1-O6): a delivery is claimable only at its nextAttemptAt,
      // then exactly one claimer wins (the prod cross-gateway delivery guarantee) — identically on both.
      await store.createChannelDelivery({
        deliveryId: `${prefix}-delivery`,
        orgId: org.orgId,
        agentId,
        channelBindingId,
        sessionBindingId: binding.bindingId,
        provider: 'webhook',
        target: { externalChatId: 'chat-1' },
        eventType: 'workflow.completed',
        payload: { runId: 'run-1' },
        nextAttemptAt: new Date('2026-01-01T00:00:10.000Z'),
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      assert.equal(await store.claimNextChannelDelivery({ orgId: org.orgId, claimedBy: 'gw-early', now: new Date('2026-01-01T00:00:01.000Z'), ttlMs: 30_000 }), null)
      const claimedDelivery = await store.claimNextChannelDelivery({ orgId: org.orgId, claimedBy: 'gw-1', now: new Date('2026-01-01T00:00:10.000Z'), ttlMs: 30_000 })
      assert.equal(claimedDelivery?.deliveryId, `${prefix}-delivery`)
      assert.equal(await store.claimNextChannelDelivery({ orgId: org.orgId, claimedBy: 'gw-2', now: new Date('2026-01-01T00:00:11.000Z'), ttlMs: 30_000 }), null)

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

      // Retention: a future cutoff prunes both the rate-limit window and the auth-backoff
      // rows just created (their timestamps are < the cutoff).
      const prunedThrottle = await store.pruneStaleThrottleState({ olderThan: new Date(Date.now() + 3_600_000), limit: 100 })
      assert.ok(prunedThrottle >= 2, `expected stale throttle rows pruned, got ${prunedThrottle}`)

      // Event-log retention (P1-C3) — opt-in, age-based, oldest-first, bounded, identical in both
      // stores. Seed one old row in each of the three logs next to the recent rows already created;
      // a cutoff between "old" and "now" must remove only the old, leaving the recent rows intact.
      const oldStamp = new Date('2000-01-01T00:00:00.000Z')
      await store.appendSessionEvent({ tenantId, sessionId, eventId: `${prefix}-old-event`, type: 'assistant.message', payload: { messageId: 'old', content: 'old' }, createdAt: oldStamp })
      await store.recordAuditEvent({ orgId: org.orgId, actorType: 'system', eventType: 'contract.retention', metadata: {}, createdAt: oldStamp })
      await store.recordUsageEvent({ orgId: org.orgId, eventType: 'contract.retention', quantity: 1, unit: 'count', metadata: {}, createdAt: oldStamp })
      const sessionEventsBeforePrune = (await store.listSessionEvents(tenantId, sessionId, 0)).length
      const retentionCutoff = { olderThan: new Date('2001-01-01T00:00:00.000Z'), limit: 100 }
      assert.ok(await store.pruneExpiredSessionEvents(retentionCutoff) >= 1, 'expected an old session event pruned')
      assert.ok(await store.pruneExpiredAuditEvents(retentionCutoff) >= 1, 'expected an old audit event pruned')
      assert.ok(await store.pruneExpiredUsageEvents(retentionCutoff) >= 1, 'expected an old usage event pruned')
      // The recent rows survive (only the pre-2001 ones were removed) and a no-op cutoff removes none.
      assert.equal((await store.listSessionEvents(tenantId, sessionId, 0)).length, sessionEventsBeforePrune - 1)
      const noopCutoff = { olderThan: new Date('1999-01-01T00:00:00.000Z'), limit: 100 }
      assert.equal(await store.pruneExpiredSessionEvents(noopCutoff), 0)
      assert.equal(await store.pruneExpiredAuditEvents(noopCutoff), 0)
      assert.equal(await store.pruneExpiredUsageEvents(noopCutoff), 0)

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

test('cloud_workflow_runs concurrency gauge trigger stays consistent with the COUNT', async () => {
  const pool = createPglitePool()
  const store = await createPostgresControlPlaneStore({ connectionString: 'pglite://memory', pool })
  try {
    await store.createTenant({ tenantId: 't1', name: 'T1', orgId: 'org-1' })
    await store.ensureOrgForTenant({ tenantId: 't1', name: 'T1', orgId: 'org-1' })
    await store.ensureUser({ tenantId: 't1', userId: 'u1', email: 'u1@example.test', role: 'member' })
    await pool.query(
      `INSERT INTO cloud_workflows (tenant_id, workflow_id, user_id, title, instructions, agent_name, skill_names, tool_ids, status, triggers, created_at, updated_at)
       VALUES ('t1', 'wf', 'u1', 'WF', 'do', 'build', '[]'::jsonb, '[]'::jsonb, 'active', '[]'::jsonb, now(), now())`,
    )

    const insertRun = (runId: string, status: string) => pool.query(
      `INSERT INTO cloud_workflow_runs (tenant_id, run_id, workflow_id, user_id, trigger_type, status, title, created_at)
       VALUES ('t1', $1, 'wf', 'u1', 'manual', $2, 'Run', now())`,
      [runId, status],
    )
    const gauge = async () => Number((await pool.query(
      `SELECT value FROM cloud_concurrency_counters WHERE scope_id = 'org-1' AND counter_key = 'concurrent_workflow_runs'`,
    )).rows[0]?.value ?? 0)
    const counted = async () => Number((await pool.query(
      `SELECT count(*) AS c FROM cloud_workflow_runs WHERE status IN ('queued', 'running')`,
    )).rows[0]?.c ?? 0)

    await insertRun('r1', 'queued')
    await insertRun('r2', 'running')
    assert.equal(await gauge(), 2)
    assert.equal(await gauge(), await counted())

    // queued -> running stays active (no delta); running -> completed exits the gauge
    await pool.query(`UPDATE cloud_workflow_runs SET status = 'running' WHERE run_id = 'r1'`)
    assert.equal(await gauge(), 2)
    await pool.query(`UPDATE cloud_workflow_runs SET status = 'completed' WHERE run_id = 'r1'`)
    assert.equal(await gauge(), 1)
    assert.equal(await gauge(), await counted())

    // a DELETE of an active row also decrements
    await pool.query(`DELETE FROM cloud_workflow_runs WHERE run_id = 'r2'`)
    assert.equal(await gauge(), 0)
    assert.equal(await gauge(), await counted())

    // concurrent-sessions gauge (active = status <> 'closed')
    const insertSession = (sessionId: string, status: string) => pool.query(
      `INSERT INTO cloud_sessions (tenant_id, session_id, user_id, opencode_session_id, profile_name, status, created_at, updated_at)
       VALUES ('t1', $1, 'u1', $1, 'default', $2, now(), now())`,
      [sessionId, status],
    )
    const sessionGauge = async () => Number((await pool.query(
      `SELECT value FROM cloud_concurrency_counters WHERE scope_id = 'org-1' AND counter_key = 'concurrent_sessions'`,
    )).rows[0]?.value ?? 0)
    const sessionCounted = async () => Number((await pool.query(
      `SELECT count(*) AS c FROM cloud_sessions WHERE status <> 'closed'`,
    )).rows[0]?.c ?? 0)

    await insertSession('s1', 'running')
    await insertSession('s2', 'idle')
    assert.equal(await sessionGauge(), 2)
    assert.equal(await sessionGauge(), await sessionCounted())
    await pool.query(`UPDATE cloud_sessions SET status = 'closed' WHERE session_id = 's1'`)
    assert.equal(await sessionGauge(), 1)
    assert.equal(await sessionGauge(), await sessionCounted())

    // queued-commands gauge (active = status IN ('pending','running')); s2 is active
    const insertCommand = (commandId: string, sequence: number, status: string) => pool.query(
      `INSERT INTO cloud_session_commands (command_id, tenant_id, user_id, session_id, kind, payload, created_sequence, created_at, status)
       VALUES ($1, 't1', 'u1', 's2', 'prompt', '{}'::jsonb, $2, now(), $3)`,
      [commandId, sequence, status],
    )
    const commandGauge = async () => Number((await pool.query(
      `SELECT value FROM cloud_concurrency_counters WHERE scope_id = 'org-1' AND counter_key = 'queued_commands'`,
    )).rows[0]?.value ?? 0)
    const commandCounted = async () => Number((await pool.query(
      `SELECT count(*) AS c FROM cloud_session_commands WHERE status IN ('pending', 'running')`,
    )).rows[0]?.c ?? 0)

    await insertCommand('c1', 1, 'pending')
    await insertCommand('c2', 2, 'running')
    assert.equal(await commandGauge(), 2)
    assert.equal(await commandGauge(), await commandCounted())
    await pool.query(`UPDATE cloud_session_commands SET status = 'completed' WHERE command_id = 'c1'`)
    assert.equal(await commandGauge(), 1)
    assert.equal(await commandGauge(), await commandCounted())
  } finally {
    await store.close?.()
  }
})
