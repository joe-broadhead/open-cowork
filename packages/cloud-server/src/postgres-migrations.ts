import { assertPostgresSchemaManifest } from '@open-cowork/shared/node'
import {
  CLOUD_CONTROL_PLANE_BASELINE_MIGRATION_ID,
  CLOUD_CONTROL_PLANE_CONCURRENT_INDEX_NAMES,
  CLOUD_CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_KEYS,
  CLOUD_CONTROL_PLANE_MIGRATIONS,
  CLOUD_CONTROL_PLANE_REQUIRED_TABLE_NAMES,
  CLOUD_CONTROL_PLANE_SCHEMA_MANIFEST,
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
const SCHEMA_MIGRATIONS_TABLE = 'cloud_schema_migrations'

// The ledger definition is part of the clean baseline. The migration runner
// executes this only after proving the product schema has no untracked domain
// tables.
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
    // Baseline DDL can legitimately run longer than a normal query. SET LOCAL is
    // transaction-scoped, so it auto-resets on commit and cannot leak the
    // exemption back into the pool.
    await client.query('SET LOCAL statement_timeout = 0')
    const tablesBeforeMigration = await currentProductTables(client)
    const ledgerExists = tablesBeforeMigration.has(SCHEMA_MIGRATIONS_TABLE)
    const appliedBeforeMigration = ledgerExists
      ? new Set(
          (await client.query<{ id: string }>('SELECT id FROM cloud_schema_migrations')).rows
            .map((row) => String(row.id)),
        )
      : new Set<string>()
    if (!appliedBeforeMigration.has(CLOUD_CONTROL_PLANE_BASELINE_MIGRATION_ID)) {
      const existingDomainTables = [...tablesBeforeMigration]
        .filter((tableName) => tableName !== SCHEMA_MIGRATIONS_TABLE)
      if (existingDomainTables.length > 0) {
        throw new Error(
          `Refusing to apply the clean Cloud control-plane baseline because its migration ledger entry is missing while product tables already exist (${summarizeNames(existingDomainTables)}). `
          + 'This pre-release baseline has no adoption or historical upgrade path. Recreate an empty Cloud schema, or restore a database whose cloud_schema_migrations ledger matches its schema.',
        )
      }
    }
    // The guard above must run before this first durable mutation. A ledger-only
    // database is allowed to initialize only when it has no product domain tables.
    await client.query(SCHEMA_MIGRATIONS_LEDGER_DDL)
    const applied = ledgerExists
      ? appliedBeforeMigration
      : new Set(
          (await client.query<{ id: string }>('SELECT id FROM cloud_schema_migrations')).rows
            .map((row) => String(row.id)),
        )
    for (const migration of CLOUD_CONTROL_PLANE_MIGRATIONS.filter((entry) => entry.transactional !== false)) {
      if (applied.has(migration.id)) continue
      for (const statement of migration.statements) await client.query(statement)
      await recordMigration(client, migration.id)
    }
    await assertRequiredCloudTables(client)
  })
  for (const migration of CLOUD_CONTROL_PLANE_MIGRATIONS.filter((entry) => entry.transactional === false)) {
    await runNonTransactionalMigration(pool, migration)
  }
  await assertPostgresControlPlaneSchemaIntegrity(pool)
}

/**
 * Assert that the current schema is physically complete, rather than trusting
 * ledger rows alone. This is also used by production readiness probes.
 */
export async function assertPostgresControlPlaneSchemaIntegrity(executor: PgExecutor) {
  const tables = await currentProductTables(executor)
  if (!tables.has(SCHEMA_MIGRATIONS_TABLE)) {
    throw new Error('Cloud control-plane schema integrity failed: cloud_schema_migrations is missing. Recreate an empty Cloud schema or restore a complete database backup.')
  }
  const applied = new Set(
    (await executor.query<{ id: string }>('SELECT id FROM cloud_schema_migrations')).rows
      .map((row) => String(row.id)),
  )
  const missingMigrations = CLOUD_CONTROL_PLANE_MIGRATIONS
    .map((migration) => migration.id)
    .filter((id) => !applied.has(id))
  if (missingMigrations.length > 0) {
    throw new Error(`Cloud control-plane schema integrity failed: missing migration ledger entries ${missingMigrations.join(', ')}.`)
  }
  await assertRequiredCloudTables(executor, tables)
  if (!await allConcurrentIndexesValid(executor, CLOUD_CONTROL_PLANE_CONCURRENT_INDEX_NAMES)) {
    const validIndexes = await validConcurrentIndexes(executor, CLOUD_CONTROL_PLANE_CONCURRENT_INDEX_NAMES)
    const missingIndexes = CLOUD_CONTROL_PLANE_CONCURRENT_INDEX_NAMES
      .filter((indexName) => !validIndexes.has(indexName))
    throw new Error(
      `Cloud control-plane schema integrity failed: required concurrent indexes are missing or invalid (${summarizeNames(missingIndexes)}). `
      + 'Restart migration initialization to repair an interrupted current-baseline index phase, or restore a complete database backup.',
    )
  }
  try {
    await assertPostgresSchemaManifest(executor, CLOUD_CONTROL_PLANE_SCHEMA_MANIFEST, tables)
  } catch (error) {
    throw new Error(
      `Cloud control-plane schema integrity failed: ${error instanceof Error ? error.message : String(error)} `
      + 'The clean pre-release baseline does not repair or adopt drifted schemas. Recreate an empty Cloud schema or restore a complete database backup.',
      { cause: error },
    )
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
  return (await validConcurrentIndexes(client, indexNames)).size === indexNames.length
}

async function validConcurrentIndexes(client: PgExecutor, indexNames: readonly string[]) {
  if (indexNames.length === 0) return new Set<string>()
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
  return new Set(result.rows.map((row) => row.index_name))
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

async function currentProductTables(executor: PgExecutor) {
  const tableNames = [SCHEMA_MIGRATIONS_TABLE, ...CLOUD_CONTROL_PLANE_REQUIRED_TABLE_NAMES]
  const result = await executor.query<{ table_name: string }>(
    `SELECT tablename AS table_name
     FROM pg_catalog.pg_tables
     WHERE schemaname = current_schema()
       AND (
         tablename = ANY($1::text[])
         OR tablename LIKE 'cloud\\_%' ESCAPE '\\'
         OR tablename = 'headless_agents'
       )`,
    [tableNames],
  )
  return new Set(result.rows.map((row) => String(row.table_name)))
}

async function assertRequiredCloudTables(executor: PgExecutor, existing?: ReadonlySet<string>) {
  const tables = existing || await currentProductTables(executor)
  const missing = CLOUD_CONTROL_PLANE_REQUIRED_TABLE_NAMES.filter((tableName) => !tables.has(tableName))
  if (missing.length === 0) return
  throw new Error(
    `Cloud control-plane schema integrity failed: required production tables are missing (${summarizeNames(missing)}). `
    + 'The clean pre-release baseline does not repair or adopt drifted schemas. Recreate an empty Cloud schema or restore a complete database backup.',
  )
}

function summarizeNames(names: readonly string[]) {
  const shown = names.slice(0, 8)
  return names.length > shown.length
    ? `${shown.join(', ')}, and ${names.length - shown.length} more`
    : shown.join(', ')
}

async function recordMigration(executor: PgExecutor, id: string) {
  await executor.query(
    `INSERT INTO cloud_schema_migrations (id, applied_at)
     VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [id, nowIso()],
  )
}
