import test from 'node:test'
import assert from 'node:assert/strict'

import { runPostgresControlPlaneMigrations } from '../packages/cloud-server/src/postgres-migrations.ts'
import { CLOUD_CONTROL_PLANE_MIGRATIONS } from '../packages/cloud-server/src/postgres-schema.ts'

// A fake Postgres that models just enough for the migration runner: an in-memory
// cloud_schema_migrations ledger, advisory-lock no-ops, and "all concurrent
// indexes are valid". Every other statement is recorded so the test can assert
// which DDL actually executed on each boot.
function createFakePostgres() {
  const ledger = new Set<string>()
  const executed: string[] = []

  async function query(text: string, values: unknown[] = []) {
    const sql = text.trim()
    if (sql.includes('pg_advisory_xact_lock') || sql.includes('pg_advisory_unlock')) return { rows: [] }
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] }
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS cloud_schema_migrations')) return { rows: [] }
    if (sql.startsWith('INSERT INTO cloud_schema_migrations')) {
      ledger.add(String(values[0]))
      return { rows: [] }
    }
    if (sql.startsWith('SELECT id FROM cloud_schema_migrations WHERE id =')) {
      return { rows: ledger.has(String(values[0])) ? [{ id: String(values[0]) }] : [] }
    }
    if (sql.startsWith('SELECT id FROM cloud_schema_migrations')) {
      return { rows: [...ledger].map((id) => ({ id })) }
    }
    if (sql.includes('indisvalid = false')) return { rows: [] }
    if (sql.includes('indisvalid = true')) {
      // Report every requested concurrent index as valid so the runner treats it as applied.
      const names = (values[0] as string[]) || []
      return { rows: names.map((name) => ({ index_name: name })) }
    }
    executed.push(sql)
    return { rows: [] }
  }

  const client = { query, release() {} }
  const pool = { query, async connect() { return client } }
  const withTransaction = async <T>(fn: (c: typeof client) => Promise<T>) => fn(client)
  return { pool, withTransaction, ledger, executed }
}

test('postgres migrations run statements once, then skip already-applied migrations on reboot', async () => {
  const db = createFakePostgres()

  // First boot: every migration runs and is recorded.
  await runPostgresControlPlaneMigrations(db.pool as never, db.withTransaction as never)
  assert.ok(db.executed.length > 0, 'first boot should execute migration statements')
  assert.ok(db.executed.some((sql) => sql.includes('cloud_tenants')), 'first boot should create base tables')
  for (const migration of CLOUD_CONTROL_PLANE_MIGRATIONS) {
    assert.ok(db.ledger.has(migration.id), `migration ${migration.id} should be recorded`)
  }

  // Second boot with the ledger persisted: no migration statement re-executes.
  db.executed.length = 0
  await runPostgresControlPlaneMigrations(db.pool as never, db.withTransaction as never)
  assert.deepEqual(db.executed, [], 'reboot must not re-run any applied migration statement')
})
