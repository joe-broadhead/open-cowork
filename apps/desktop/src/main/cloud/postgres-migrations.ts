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
type PgClient = PgExecutor & { release: () => void }
type PgPool = PgExecutor & { connect(): Promise<PgClient> }
export type PostgresTransactionRunner = <T>(fn: (client: PgClient) => Promise<T>) => Promise<T>

const NON_TRANSACTIONAL_MIGRATION_LOCK_RETRY_MS = 50

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
    for (const migration of CLOUD_CONTROL_PLANE_MIGRATIONS.filter((entry) => entry.transactional !== false)) {
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
      client.release()
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
