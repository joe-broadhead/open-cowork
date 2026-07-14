import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

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
let PostgresStandaloneGatewayRepository:
  (new (pool: unknown) => StandaloneGatewayRepository) | null = null
let standaloneGatewayBaselineMigrationId = '0001_standalone_gateway_baseline'
let DIST_SKIP: boolean | string = false
try {
  const [repositoryModule, postgresModule, schemaModule] = await Promise.all([
    import('../apps/standalone-gateway/dist/repository.js'),
    import('../apps/standalone-gateway/dist/postgres-repository.js'),
    import('../apps/standalone-gateway/dist/schema.js'),
  ])
  InMemoryStandaloneGatewayRepository = repositoryModule.InMemoryStandaloneGatewayRepository
  createStandaloneGatewayPostgresRepository = postgresModule.createStandaloneGatewayPostgresRepository
  PostgresStandaloneGatewayRepository = postgresModule.PostgresStandaloneGatewayRepository
  standaloneGatewayBaselineMigrationId = schemaModule.STANDALONE_GATEWAY_BASELINE_MIGRATION_ID
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
const require = createRequire(import.meta.url)

type PgPool = {
  query(text: string, values?: unknown[]): Promise<unknown>
  end(): Promise<void>
}

function pgPool(connectionString: string): PgPool {
  const pg = require('pg') as { Pool: new (options: { connectionString: string }) => PgPool }
  return new pg.Pool({ connectionString })
}

function withSearchPath(connectionString: string, schema: string) {
  const url = new URL(connectionString)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

async function withIsolatedPostgresSchema<T>(fn: (connectionString: string) => Promise<T>) {
  assert.ok(POSTGRES_URL)
  const schema = `ocw_gateway_${randomUUID().replaceAll('-', '_')}`
  assert.match(schema, /^ocw_gateway_[a-z0-9_]+$/)
  const pool = pgPool(POSTGRES_URL)
  try {
    await pool.query(`CREATE SCHEMA ${schema}`)
    return await fn(withSearchPath(POSTGRES_URL, schema))
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await pool.end()
  }
}

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

        // Lease-aware claim (P1-G4): a stale/absent lease cannot claim a job (split-brain guard);
        // only the live lease token can, verified atomically with the claim in both stores.
        const leasedJob = await repository.enqueueJob({ kind: 'prompt', sessionId: session.sessionId, payload: { note: 'leased' } })
        assert.equal(
          await repository.claimNextJob({ claimedBy: 'worker-1', ttlMs: 30_000, lease: { leaseId: 'daemon', ownerId: 'node-1', leaseToken: 'stale-token' } }),
          null,
        )
        const leasedClaim = await repository.claimNextJob({ claimedBy: 'worker-1', ttlMs: 30_000, lease: { leaseId: 'daemon', ownerId: 'node-1', leaseToken: renewed!.leaseToken } })
        assert.equal(leasedClaim?.jobId, leasedJob.jobId)
        await repository.finishJob({ jobId: leasedJob.jobId, claimToken: leasedClaim!.claimToken!, status: 'completed' })

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

test('real Postgres standalone baseline refuses untracked product tables before ledger mutation', {
  skip: DIST_SKIP || POSTGRES_SKIP,
}, async () => {
  await withIsolatedPostgresSchema(async (connectionString) => {
    assert.ok(PostgresStandaloneGatewayRepository)
    const pool = pgPool(connectionString)
    const repository = new PostgresStandaloneGatewayRepository(pool)
    try {
      await pool.query('CREATE TABLE standalone_gateway_sessions (session_id text PRIMARY KEY)')
      await assert.rejects(
        () => repository.migrate(),
        /Refusing to apply the clean Standalone Gateway baseline[\s\S]*Recreate an empty Standalone Gateway schema/,
      )
      const result = await pool.query(
        `SELECT to_regclass('standalone_gateway_schema_migrations') AS ledger,
                to_regclass('standalone_gateway_sessions') AS domain_table`,
      ) as { rows: Array<{ ledger: string | null, domain_table: string | null }> }
      assert.equal(result.rows[0]?.ledger, null)
      assert.equal(result.rows[0]?.domain_table, 'standalone_gateway_sessions')
    } finally {
      await repository.close?.()
    }
  })
})

test('real Postgres standalone readiness rejects a ledger-only schema', {
  skip: DIST_SKIP || POSTGRES_SKIP,
}, async () => {
  await withIsolatedPostgresSchema(async (connectionString) => {
    assert.ok(PostgresStandaloneGatewayRepository)
    const pool = pgPool(connectionString)
    const repository = new PostgresStandaloneGatewayRepository(pool)
    try {
      await pool.query(`CREATE TABLE standalone_gateway_schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`)
      await pool.query('INSERT INTO standalone_gateway_schema_migrations (id) VALUES ($1)', [standaloneGatewayBaselineMigrationId])

      await assert.rejects(() => repository.migrate(), /required production tables are missing/)
      const readiness = await repository.readiness()
      assert.equal(readiness.ok, false)
      assert.match(readiness.detail, /required production tables are missing/)
    } finally {
      await repository.close?.()
    }
  })
})

test('real Postgres standalone migrations serialize a fresh baseline with one ledger row', {
  skip: DIST_SKIP || POSTGRES_SKIP,
}, async () => {
  await withIsolatedPostgresSchema(async (connectionString) => {
    assert.ok(PostgresStandaloneGatewayRepository)
    const Repository = PostgresStandaloneGatewayRepository
    const repositories = Array.from({ length: 6 }, () => (
      new Repository(pgPool(connectionString))
    ))
    try {
      await Promise.all(repositories.map((repository) => repository.migrate()))
      const readiness = await repositories[0]!.readiness()
      assert.equal(readiness.ok, true)
      const pool = pgPool(connectionString)
      try {
        const result = await pool.query(
          'SELECT count(*)::int AS count FROM standalone_gateway_schema_migrations WHERE id = $1',
          [standaloneGatewayBaselineMigrationId],
        ) as { rows: Array<{ count: number }> }
        assert.equal(result.rows[0]?.count, 1)
      } finally {
        await pool.end()
      }
    } finally {
      await Promise.all(repositories.map((repository) => repository.close?.()))
    }
  })
})
