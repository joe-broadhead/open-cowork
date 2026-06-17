import test from 'node:test'
import assert from 'node:assert/strict'

// Imported from the built dist (not src) because the standalone-gateway sources use NodeNext
// `.js` import specifiers that Node's type-stripping can't resolve to `.ts` from here. The
// `import type` below is erased at runtime; the runtime values are imported dynamically so a
// missing dist (when `pnpm build:standalone-gateway` hasn't run) self-skips with a clear
// message instead of hard-failing the suite.
import type { StandaloneGatewayRepository } from '../apps/standalone-gateway/dist/repository.js'
import { createPglitePool } from './helpers/pglite-pool.ts'

let InMemoryStandaloneGatewayRepository:
  (new () => StandaloneGatewayRepository) | null = null
let createStandaloneGatewayPostgresRepository:
  ((database: string, options?: { createPool?: () => unknown }) => Promise<StandaloneGatewayRepository>) | null = null
let DIST_SKIP: boolean | string = false
try {
  const [repositoryModule, postgresModule] = await Promise.all([
    import('../apps/standalone-gateway/dist/repository.js'),
    import('../apps/standalone-gateway/dist/postgres-repository.js'),
  ])
  InMemoryStandaloneGatewayRepository = repositoryModule.InMemoryStandaloneGatewayRepository
  createStandaloneGatewayPostgresRepository = postgresModule.createStandaloneGatewayPostgresRepository
} catch (error) {
  DIST_SKIP = `Standalone Gateway dist not built — run "pnpm build:standalone-gateway" (${error instanceof Error ? error.message : String(error)}).`
}

// Mirrors tests/cloud-control-plane-store-contracts.test.ts: the SAME contract body runs
// against the in-memory peer AND the real Postgres repository SQL executed by pglite (an
// in-process PostgreSQL/WASM). The pglite run is what exercises the SQL the existing
// string-mock unit tests can't — conflict targets, FOR-UPDATE sequence allocation, the
// claim CTE, jsonb round-tripping, bigint-as-string columns, and the lease-gated retention
// subqueries. An external Postgres run is added when OPEN_COWORK_TEST_POSTGRES_URL is set.
const POSTGRES_URL = process.env.OPEN_COWORK_TEST_POSTGRES_URL
  || process.env.OPEN_COWORK_STANDALONE_GATEWAY_TEST_POSTGRES_URL
const POSTGRES_SKIP = POSTGRES_URL
  ? false
  : 'Set OPEN_COWORK_TEST_POSTGRES_URL to run real Postgres standalone-gateway contract tests.'

function runStandaloneRepositoryContracts(
  label: string,
  makeRepository: () => Promise<StandaloneGatewayRepository>,
  skip: boolean | string = false,
) {
  test(
    `standalone gateway repository contract (${label}): leases, sessions, events, jobs, identities, retention`,
    { skip: DIST_SKIP || skip },
    async () => {
      const repository = await makeRepository()
      try {
        assert.equal((await repository.readiness()).ok, true)

        // Daemon lease — single-holder, token-gated renew.
        const lease = await repository.acquireDaemonLease({ leaseId: 'daemon', ownerId: 'node-1', ttlMs: 30_000 })
        assert.ok(lease?.leaseToken)
        assert.equal(await repository.acquireDaemonLease({ leaseId: 'daemon', ownerId: 'node-2', ttlMs: 30_000 }), null)
        const renewed = await repository.renewDaemonLease({
          leaseId: 'daemon', ownerId: 'node-1', leaseToken: lease!.leaseToken, ttlMs: 30_000,
        })
        assert.ok(renewed?.leaseToken)
        assert.equal(await repository.renewDaemonLease({
          leaseId: 'daemon', ownerId: 'node-1', leaseToken: 'wrong-token', ttlMs: 30_000,
        }), null)

        // Channel identity — upsert (insert + conflict update), workspace-scoped lookup, summary.
        const identity = await repository.upsertChannelIdentity({ provider: 'webhook-ci', externalUserId: 'user-1', role: 'member' })
        assert.equal(identity.status, 'active')
        assert.equal(
          (await repository.findChannelIdentity({ provider: 'webhook-ci', externalUserId: 'user-1' }))?.identityId,
          identity.identityId,
        )
        assert.equal(
          await repository.findChannelIdentity({ provider: 'webhook-ci', externalUserId: 'user-1', providerWorkspaceId: 'workspace-1' }),
          null,
        )
        await repository.upsertChannelIdentity({
          provider: 'webhook-ci', externalUserId: 'user-1', providerWorkspaceId: 'workspace-1', role: 'viewer', status: 'disabled',
        })
        await repository.upsertChannelIdentity({ provider: 'webhook-other', externalUserId: 'user-1', role: 'admin' })
        assert.equal(
          (await repository.findChannelIdentity({ provider: 'webhook-ci', externalUserId: 'user-1', providerWorkspaceId: 'workspace-1' }))?.role,
          'viewer',
        )
        assert.deepEqual(
          await repository.identityAuthorizationSummary({ providers: ['webhook-ci'] }),
          { total: 2, active: 1, promptCapable: 1 },
        )

        // Session — idempotent conflict target, FOR-UPDATE sequence allocation, set-once runtime binding.
        const target = { provider: 'webhook-ci', providerKind: 'webhook' as const, chatId: 'chat-1', threadId: 'thread-1' }
        const promptInput = {
          provider: 'webhook-ci', providerKind: 'webhook' as const, channelBindingId: 'webhook',
          target, externalUserId: 'user-1', text: 'hello',
        }
        const session = await repository.findOrCreateSession(promptInput)
        const sameSession = await repository.findOrCreateSession({ ...promptInput, text: 'hello again' })
        assert.equal(sameSession.sessionId, session.sessionId)
        assert.equal(sameSession.lastEventSequence, 1)

        const firstBinding = await repository.updateSessionRuntime({ sessionId: session.sessionId, opencodeSessionId: 'oc-1', status: 'running' })
        const secondBinding = await repository.updateSessionRuntime({ sessionId: session.sessionId, opencodeSessionId: 'oc-2', status: 'idle' })
        assert.equal(firstBinding.opencodeSessionId, 'oc-1')
        assert.equal(secondBinding.opencodeSessionId, 'oc-1')

        await repository.appendEvent({ sessionId: session.sessionId, type: 'user.message', payload: { text: 'hello' } })

        // Jobs — enqueue → claim (SKIP LOCKED) → finish; empty queue claims null.
        const job = await repository.enqueueJob({ kind: 'prompt', sessionId: session.sessionId, payload: { note: 'work' } })
        const claimed = await repository.claimNextJob({ claimedBy: 'worker-1', ttlMs: 30_000 })
        assert.equal(claimed?.jobId, job.jobId)
        assert.ok(claimed?.claimToken)
        assert.equal(await repository.claimNextJob({ claimedBy: 'worker-1', ttlMs: 30_000 }), null)
        const finished = await repository.finishJob({ jobId: job.jobId, claimToken: claimed!.claimToken!, status: 'completed' })
        assert.equal(finished.status, 'completed')

        // Audit — secret redaction survives the jsonb round-trip.
        await repository.recordAudit('test.audit', 'user-1', { token: 'secret-token', note: 'ok' })

        // Dashboard / listing — aggregate reads across all tables.
        const snapshot = await repository.dashboardSnapshot()
        assert.equal(snapshot.sessions.length, 1)
        assert.equal(snapshot.identities.length, 3)
        assert.equal(snapshot.jobs.find((entry) => entry.jobId === job.jobId)?.status, 'completed')
        assert.equal(snapshot.audits[0]?.metadata.token, '[redacted]')
        assert.equal((await repository.listSessions()).length, 1)

        // Retention — lease-gated; a wrong token is a no-op, a valid token returns a result.
        assert.equal(
          await repository.pruneRetention({
            retention: { sessionDays: 90, artifactDays: 30, auditDays: 365, jobDays: 30 },
            leaseId: 'daemon', ownerId: 'node-1', leaseToken: 'wrong-token',
          }),
          null,
        )
        const pruned = await repository.pruneRetention({
          retention: { sessionDays: 90, artifactDays: 30, auditDays: 365, jobDays: 30 },
          leaseId: 'daemon', ownerId: 'node-1', leaseToken: renewed!.leaseToken,
        })
        assert.ok(pruned)
      } finally {
        await repository.close?.()
      }
    },
  )
}

runStandaloneRepositoryContracts('in-memory', async () => {
  assert.ok(InMemoryStandaloneGatewayRepository)
  return new InMemoryStandaloneGatewayRepository()
})

// The real Postgres repository SQL, executed by an in-process PostgreSQL (pglite) — no DB
// daemon required. Reuses the generic cloud pglite pool; the standalone migrations have no
// CONCURRENTLY, so they run unmodified.
runStandaloneRepositoryContracts('pglite', async () => {
  assert.ok(createStandaloneGatewayPostgresRepository)
  const repository = await createStandaloneGatewayPostgresRepository('pglite://memory', {
    createPool: () => createPglitePool() as never,
  })
  await repository.migrate()
  return repository
})

runStandaloneRepositoryContracts('postgres', async () => {
  assert.ok(POSTGRES_URL)
  assert.ok(createStandaloneGatewayPostgresRepository)
  const repository = await createStandaloneGatewayPostgresRepository(POSTGRES_URL)
  await repository.migrate()
  return repository
}, POSTGRES_SKIP)
