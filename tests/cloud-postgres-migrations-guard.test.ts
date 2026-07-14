import test from 'node:test'
import assert from 'node:assert/strict'

import { runPostgresControlPlaneMigrations } from '../packages/cloud-server/src/postgres-migrations.ts'
import {
  CLOUD_CONTROL_PLANE_BASELINE_MIGRATION_ID,
  CLOUD_CONTROL_PLANE_CONCURRENT_INDEX_NAMES,
  CLOUD_CONTROL_PLANE_CONCURRENT_INDEXES_MIGRATION_ID,
  CLOUD_CONTROL_PLANE_MIGRATIONS,
  CLOUD_CONTROL_PLANE_REQUIRED_TABLE_NAMES,
  CLOUD_CONTROL_PLANE_SCHEMA_MANIFEST,
} from '../packages/cloud-server/src/postgres-schema.ts'

// A fake Postgres that models the migration ledger, physical product tables,
// advisory-lock no-ops, and valid/invalid concurrent indexes. Every migration
// statement is recorded so the tests can assert exactly which DDL executes.
function createFakePostgres() {
  const ledger = new Set<string>()
  const tables = new Set<string>()
  const validIndexes = new Set<string>()
  const invalidIndexes = new Set<string>()
  const executed: string[] = []

  async function query(text: string, values: unknown[] = []) {
    const sql = text.trim()
    // Runner infrastructure (advisory locks, statement_timeout exemption) — not a
    // migration statement; treat as a no-op so `executed` reflects DDL only.
    if (sql.startsWith('SET ') || sql.startsWith('RESET ')) return { rows: [] }
    if (sql.includes('pg_advisory_xact_lock') || sql.includes('pg_advisory_unlock')) return { rows: [] }
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] }
    if (sql.includes('FROM pg_catalog.pg_tables')) {
      const requested = (values[0] as string[]) || []
      return { rows: requested.filter((name) => tables.has(name)).map((name) => ({ table_name: name })) }
    }
    if (sql.includes('JOIN pg_catalog.pg_attribute attribute ON')) {
      return {
        rows: CLOUD_CONTROL_PLANE_SCHEMA_MANIFEST.columns.map((column) => ({
          table_name: column.tableName,
          column_name: column.columnName,
          ordinal: column.ordinal,
          data_type: column.dataType,
          not_null: column.notNull,
          default_expression: column.defaultExpression,
        })),
      }
    }
    if (sql.includes('FROM pg_catalog.pg_constraint constraint_row')) {
      return {
        rows: CLOUD_CONTROL_PLANE_SCHEMA_MANIFEST.constraints.map((constraint) => ({
          table_name: constraint.tableName,
          kind: constraint.kind,
          columns: constraint.columns,
          referenced_schema: constraint.referencedSchema === '@current-schema' ? 'public' : constraint.referencedSchema,
          referenced_is_current_schema: constraint.referencedSchema === '@current-schema',
          referenced_table: constraint.referencedTable,
          referenced_columns: constraint.referencedColumns,
          update_action: constraint.updateAction,
          delete_action: constraint.deleteAction,
          match_type: constraint.matchType,
          is_deferrable: constraint.deferrable,
          is_initially_deferred: constraint.initiallyDeferred,
          is_validated: constraint.validated,
          is_local: constraint.locallyDefined,
          inheritance_count: constraint.inheritanceCount,
          no_inherit: constraint.noInherit,
          check_expression: constraint.checkExpression,
        })),
      }
    }
    if (sql.includes('FROM pg_catalog.pg_index index_row')) {
      return {
        rows: CLOUD_CONTROL_PLANE_SCHEMA_MANIFEST.indexes.map((index) => ({
          index_name: index.indexName,
          table_name: index.tableName,
          access_method: index.accessMethod,
          is_unique: index.unique,
          nulls_not_distinct: index.nullsNotDistinct,
          is_valid: !invalidIndexes.has(index.indexName),
          key_expressions: index.keyExpressions,
          predicate: index.predicate,
        })),
      }
    }
    if (sql.includes('FROM pg_catalog.pg_proc procedure')) {
      return {
        rows: CLOUD_CONTROL_PLANE_SCHEMA_MANIFEST.functions.map((fn, index) => ({
          function_oid: index + 1,
          function_schema: 'public',
          function_name: fn.functionName,
          identity_arguments: fn.identityArguments,
          language: fn.language,
          result_type: fn.resultType,
          body: fn.body,
          security_definer: fn.securityDefiner,
          volatility: fn.volatility === 'immutable' ? 'i' : fn.volatility === 'stable' ? 's' : 'v',
          leakproof: fn.leakproof,
          is_strict: fn.strict,
          parallel_safety: fn.parallelSafety === 'safe' ? 's' : fn.parallelSafety === 'restricted' ? 'r' : 'u',
          configuration: fn.configuration,
        })),
      }
    }
    if (sql.includes('FROM pg_catalog.pg_trigger trigger_row')) {
      return {
        rows: CLOUD_CONTROL_PLANE_SCHEMA_MANIFEST.triggers.map((trigger) => ({
          trigger_name: trigger.triggerName,
          table_name: trigger.tableName,
          function_oid: CLOUD_CONTROL_PLANE_SCHEMA_MANIFEST.functions.findIndex((fn) => (
            fn.functionName === trigger.functionName
            && fn.identityArguments === trigger.functionIdentityArguments
          )) + 1,
          function_schema: 'public',
          function_is_current_schema: true,
          function_name: trigger.functionName,
          function_identity_arguments: trigger.functionIdentityArguments,
          function_arguments_hex: Buffer
            .from([...trigger.functionArguments, ''].join('\0'), 'utf8')
            .toString('hex'),
          trigger_definition: trigger.whenExpression
            ? `CREATE TRIGGER ${trigger.triggerName} WHEN (${trigger.whenExpression}) EXECUTE FUNCTION ${trigger.functionName}()`
            : `CREATE TRIGGER ${trigger.triggerName} EXECUTE FUNCTION ${trigger.functionName}()`,
          old_transition_table: trigger.oldTransitionTable,
          new_transition_table: trigger.newTransitionTable,
          type_mask: trigger.typeMask,
          enabled: trigger.enabled,
        })),
      }
    }
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS cloud_schema_migrations')) {
      tables.add('cloud_schema_migrations')
      return { rows: [] }
    }
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
    if (sql.includes('indisvalid = false')) {
      const names = (values[0] as string[]) || []
      return { rows: names.filter((name) => invalidIndexes.has(name)).map((name) => ({ index_name: name })) }
    }
    if (sql.includes('indisvalid = true')) {
      const names = (values[0] as string[]) || []
      return { rows: names.filter((name) => validIndexes.has(name)).map((name) => ({ index_name: name })) }
    }
    if (sql.startsWith('DROP INDEX CONCURRENTLY IF EXISTS')) {
      const indexName = sql.match(/"([^"]+)"/)?.[1]
      if (indexName) {
        validIndexes.delete(indexName)
        invalidIndexes.delete(indexName)
      }
      executed.push(sql)
      return { rows: [] }
    }
    for (const match of sql.matchAll(/\bCREATE TABLE IF NOT EXISTS\s+([a-z][a-z0-9_]*)\b/g)) tables.add(match[1]!)
    const indexName = sql.match(/\bCREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS\s+([a-z][a-z0-9_]*)\b/)?.[1]
    if (indexName) {
      validIndexes.add(indexName)
      invalidIndexes.delete(indexName)
    }
    executed.push(sql)
    return { rows: [] }
  }

  const client = { query, release() {} }
  const pool = { query, async connect() { return client } }
  const withTransaction = async <T>(fn: (c: typeof client) => Promise<T>) => fn(client)
  return { pool, withTransaction, ledger, tables, validIndexes, invalidIndexes, executed }
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

test('cloud clean baseline refuses pre-existing product tables before creating or stamping the ledger', async () => {
  const db = createFakePostgres()
  db.tables.add('cloud_tenants')

  await assert.rejects(
    () => runPostgresControlPlaneMigrations(db.pool as never, db.withTransaction as never),
    /Refusing to apply the clean Cloud control-plane baseline[\s\S]*Recreate an empty Cloud schema/,
  )

  assert.equal(db.tables.has('cloud_schema_migrations'), false)
  assert.equal(db.ledger.size, 0)
  assert.deepEqual(db.executed, [])
})

test('cloud schema integrity rejects ledger-only readiness', async () => {
  const db = createFakePostgres()
  db.tables.add('cloud_schema_migrations')
  for (const migration of CLOUD_CONTROL_PLANE_MIGRATIONS) db.ledger.add(migration.id)

  await assert.rejects(
    () => runPostgresControlPlaneMigrations(db.pool as never, db.withTransaction as never),
    /required production tables are missing/,
  )
  assert.equal(db.executed.length, 0)
})

test('cloud current baseline repairs an interrupted invalid concurrent index phase', async () => {
  const db = createFakePostgres()
  await runPostgresControlPlaneMigrations(db.pool as never, db.withTransaction as never)
  assert.deepEqual(
    CLOUD_CONTROL_PLANE_REQUIRED_TABLE_NAMES.filter((tableName) => !db.tables.has(tableName)),
    [],
  )

  const damagedIndex = CLOUD_CONTROL_PLANE_CONCURRENT_INDEX_NAMES[0]!
  db.validIndexes.delete(damagedIndex)
  db.invalidIndexes.add(damagedIndex)
  db.executed.length = 0

  await runPostgresControlPlaneMigrations(db.pool as never, db.withTransaction as never)

  assert.equal(db.invalidIndexes.has(damagedIndex), false)
  assert.equal(db.validIndexes.has(damagedIndex), true)
  assert.equal(db.executed.some((sql) => sql === `DROP INDEX CONCURRENTLY IF EXISTS "${damagedIndex}"`), true)
  assert.equal(db.executed.some((sql) => sql.includes('cloud_tenants')), false)
})

test('cloud schema starts from clean pre-release baselines without historical upgrade data paths', () => {
  assert.equal(CLOUD_CONTROL_PLANE_SCHEMA_MANIFEST.tableNames.includes('cloud_schema_migrations'), true)
  assert.deepEqual(
    CLOUD_CONTROL_PLANE_MIGRATIONS.map((migration) => migration.id),
    [CLOUD_CONTROL_PLANE_BASELINE_MIGRATION_ID, CLOUD_CONTROL_PLANE_CONCURRENT_INDEXES_MIGRATION_ID],
  )

  const transactional = CLOUD_CONTROL_PLANE_MIGRATIONS[0]!
  const concurrent = CLOUD_CONTROL_PLANE_MIGRATIONS[1]!
  const baselineSql = transactional.statements.join('\n')

  assert.equal(transactional.transactional, undefined)
  assert.equal(concurrent.transactional, false)
  assert.doesNotMatch(baselineSql, /\bALTER TABLE\b/)
  assert.doesNotMatch(baselineSql, /\bDELETE FROM\b/)
  assert.doesNotMatch(baselineSql, /INSERT INTO cloud_(?:orgs|accounts|memberships)\b/)
  assert.doesNotMatch(baselineSql, /GREATEST\(0, cloud_concurrency_counters\.value/)
  assert.doesNotMatch(CLOUD_CONTROL_PLANE_MIGRATIONS.flatMap((migration) => migration.statements).join('\n'), /\bDROP INDEX\b/)
  for (const statement of concurrent.statements) {
    assert.match(statement, /^CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS /)
  }
})
