import {
  CLOUD_CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_KEYS,
  CLOUD_CONTROL_PLANE_MIGRATIONS,
  type CloudControlPlaneMigration,
} from './postgres-schema.ts'

type QueryRow = Record<string, unknown>
type QueryResult<Row extends QueryRow = QueryRow> = { rows: Row[] }
type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}
type PgClient = PgExecutor & { release: (destroy?: boolean) => void }
type PgPool = PgExecutor & { connect(): Promise<PgClient> }
export type PostgresTransactionRunner = <T>(fn: (client: PgClient) => Promise<T>) => Promise<T>

const NON_TRANSACTIONAL_MIGRATION_LOCK_RETRY_MS = 50

// Minimal ledger DDL so the applied-set check below is safe on a fresh database
// (the full definition also lives in migration 001's statements; IF NOT EXISTS
// makes running it twice a no-op).
const SCHEMA_MIGRATIONS_LEDGER_DDL = `CREATE TABLE IF NOT EXISTS cloud_schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL
)`

function nowIso() {
  return new Date().toISOString()
}

export async function runPostgresControlPlaneMigrations(
  pool: PgPool,
  withTransaction: PostgresTransactionRunner,
) {
  await withTransaction(async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock($1, $2)',
      [...CLOUD_CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_KEYS],
    )
    // Exempt DDL + one-shot backfills from the pool's statement_timeout — they can
    // legitimately run longer than a normal query. SET LOCAL is transaction-scoped, so
    // it auto-resets on commit and can't leak the exemption back into the pool.
    await client.query('SET LOCAL statement_timeout = 0')
    // Skip migrations already recorded — their statements (incl. one-shot
    // backfills) must not re-execute on every boot. Bootstrap the ledger first
    // so the SELECT can't fail (a failed query would poison the transaction).
    await client.query(SCHEMA_MIGRATIONS_LEDGER_DDL)
    const applied = new Set(
      (await client.query<{ id: string }>('SELECT id FROM cloud_schema_migrations')).rows.map((row) => String(row.id)),
    )
    for (const migration of CLOUD_CONTROL_PLANE_MIGRATIONS.filter((entry) => entry.transactional !== false)) {
      if (applied.has(migration.id)) continue
      for (const statement of migration.statements) await client.query(statement)
      await recordMigration(client, migration.id)
    }
  })
  for (const migration of CLOUD_CONTROL_PLANE_MIGRATIONS.filter((entry) => entry.transactional === false)) {
    await runNonTransactionalMigration(pool, migration)
  }
}

async function runNonTransactionalMigration(pool: PgPool, migration: CloudControlPlaneMigration) {
  const client = await pool.connect()
  let locked = false
  try {
    await acquireSessionMigrationLock(client)
    locked = true
    // CREATE INDEX CONCURRENTLY can run long; disable the statement_timeout for this
    // dedicated connection (it can't use SET LOCAL — CONCURRENTLY can't run in a
    // transaction). The connection is destroyed on release (below) so the session-level
    // override can never leak back into the pool.
    await client.query('SET statement_timeout = 0')
    await dropInvalidConcurrentIndexes(client, migration.concurrentIndexes || [])
    const existing = await client.query('SELECT id FROM cloud_schema_migrations WHERE id = $1', [migration.id])
    if (existing.rows[0] && await allConcurrentIndexesValid(client, migration.concurrentIndexes || [])) return
    for (const statement of migration.statements) await client.query(statement)
    if (!await allConcurrentIndexesValid(client, migration.concurrentIndexes || [])) {
      throw new Error(`Concurrent index migration ${migration.id} did not create valid indexes.`)
    }
    await recordMigration(client, migration.id)
  } finally {
    try {
      if (locked) {
        await client.query(
          'SELECT pg_advisory_unlock($1, $2)',
          [...CLOUD_CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_KEYS],
        )
      }
    } finally {
      // Destroy (don't pool) this connection — it carries the statement_timeout = 0
      // override set above, which must never serve a normal pooled query.
      client.release(true)
    }
  }
}

async function acquireSessionMigrationLock(client: PgExecutor) {
  while (true) {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [...CLOUD_CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_KEYS],
    )
    if (result.rows[0]?.locked === true) return
    await delay(NON_TRANSACTIONAL_MIGRATION_LOCK_RETRY_MS)
  }
}

async function dropInvalidConcurrentIndexes(client: PgExecutor, indexNames: readonly string[]) {
  for (const indexName of await invalidConcurrentIndexes(client, indexNames)) {
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdentifier(indexName)}`)
  }
}

async function allConcurrentIndexesValid(client: PgExecutor, indexNames: readonly string[]) {
  if (indexNames.length === 0) return true
  const result = await client.query<{ index_name: string }>(
    `SELECT c.relname AS index_name
     FROM pg_class c
     JOIN pg_index i ON i.indexrelid = c.oid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname = ANY($1::text[])
       AND i.indisvalid = true`,
    [indexNames],
  )
  return new Set(result.rows.map((row) => row.index_name)).size === indexNames.length
}

async function invalidConcurrentIndexes(client: PgExecutor, indexNames: readonly string[]) {
  if (indexNames.length === 0) return []
  const result = await client.query<{ index_name: string }>(
    `SELECT c.relname AS index_name
     FROM pg_class c
     JOIN pg_index i ON i.indexrelid = c.oid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname = ANY($1::text[])
       AND i.indisvalid = false`,
    [indexNames],
  )
  return result.rows.map((row) => row.index_name)
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function recordMigration(executor: PgExecutor, id: string) {
  await executor.query(
    `INSERT INTO cloud_schema_migrations (id, applied_at)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [id, nowIso()],
  )
}
