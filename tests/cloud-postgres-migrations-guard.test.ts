import test from 'node:test'
import assert from 'node:assert/strict'

import { runPostgresControlPlaneMigrations } from '../packages/cloud-server/src/postgres-migrations.ts'
import {
  CLOUD_CONTROL_PLANE_BASELINE_MIGRATION_ID,
  CLOUD_CONTROL_PLANE_ARTIFACT_UPLOAD_LIFECYCLE_MIGRATION_ID,
  CLOUD_CONTROL_PLANE_CHANNEL_INTERACTION_SCOPE_MIGRATION_ID,
  CLOUD_CONTROL_PLANE_CHANNEL_IDEMPOTENCY_SCOPE_MIGRATION_ID,
  CLOUD_CONTROL_PLANE_CONCURRENT_INDEX_NAMES,
  CLOUD_CONTROL_PLANE_CONCURRENT_INDEXES_MIGRATION_ID,
  CLOUD_CONTROL_PLANE_MIGRATIONS,
  CLOUD_CONTROL_PLANE_REQUIRED_TABLE_NAMES,
  CLOUD_CONTROL_PLANE_SCHEMA_MANIFEST,
  CLOUD_CONTROL_PLANE_WORKFLOW_SECRET_MIGRATION_ID,
} from '../packages/cloud-server/src/postgres-schema.ts'
import { createPglitePool } from './helpers/pglite-pool.ts'

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

test('cloud schema integrity rejects ledger-only drift before pending additive migrations', async () => {
  const db = createFakePostgres()
  db.tables.add('cloud_schema_migrations')
  db.ledger.add(CLOUD_CONTROL_PLANE_BASELINE_MIGRATION_ID)
  db.ledger.add(CLOUD_CONTROL_PLANE_WORKFLOW_SECRET_MIGRATION_ID)
  db.ledger.add(CLOUD_CONTROL_PLANE_CONCURRENT_INDEXES_MIGRATION_ID)

  await assert.rejects(
    () => runPostgresControlPlaneMigrations(db.pool as never, db.withTransaction as never),
    /required production tables are missing/,
  )
  assert.deepEqual(db.executed, [], 'drift guard must run before pending ALTER/UPDATE statements')
  assert.equal(db.ledger.has(CLOUD_CONTROL_PLANE_CHANNEL_INTERACTION_SCOPE_MIGRATION_ID), false)
  assert.equal(db.ledger.has(CLOUD_CONTROL_PLANE_CHANNEL_IDEMPOTENCY_SCOPE_MIGRATION_ID), false)
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

test('cloud older baseline applies a pending migration that creates its missing required table', async () => {
  const db = createFakePostgres()
  db.tables.add('cloud_schema_migrations')
  for (const tableName of CLOUD_CONTROL_PLANE_REQUIRED_TABLE_NAMES) {
    if (tableName !== 'cloud_workflow_webhook_secrets') db.tables.add(tableName)
  }
  for (const migration of CLOUD_CONTROL_PLANE_MIGRATIONS) {
    if (migration.id !== CLOUD_CONTROL_PLANE_WORKFLOW_SECRET_MIGRATION_ID) db.ledger.add(migration.id)
  }
  for (const indexName of CLOUD_CONTROL_PLANE_CONCURRENT_INDEX_NAMES) db.validIndexes.add(indexName)

  await runPostgresControlPlaneMigrations(db.pool as never, db.withTransaction as never)

  assert.equal(db.tables.has('cloud_workflow_webhook_secrets'), true)
  assert.equal(db.ledger.has(CLOUD_CONTROL_PLANE_WORKFLOW_SECRET_MIGRATION_ID), true)
  assert.equal(db.executed.length, 1)
  assert.match(db.executed[0]!, /^CREATE TABLE IF NOT EXISTS cloud_workflow_webhook_secrets/)
})

test('cloud schema keeps its clean baseline and explicit additive upgrade migrations', () => {
  assert.equal(CLOUD_CONTROL_PLANE_SCHEMA_MANIFEST.tableNames.includes('cloud_schema_migrations'), true)
  assert.deepEqual(
    CLOUD_CONTROL_PLANE_MIGRATIONS.map((migration) => migration.id),
    [
      CLOUD_CONTROL_PLANE_BASELINE_MIGRATION_ID,
      CLOUD_CONTROL_PLANE_WORKFLOW_SECRET_MIGRATION_ID,
      CLOUD_CONTROL_PLANE_CHANNEL_INTERACTION_SCOPE_MIGRATION_ID,
      CLOUD_CONTROL_PLANE_CHANNEL_IDEMPOTENCY_SCOPE_MIGRATION_ID,
      CLOUD_CONTROL_PLANE_ARTIFACT_UPLOAD_LIFECYCLE_MIGRATION_ID,
      CLOUD_CONTROL_PLANE_CONCURRENT_INDEXES_MIGRATION_ID,
    ],
  )

  const baseline = CLOUD_CONTROL_PLANE_MIGRATIONS[0]!
  const workflowSecrets = CLOUD_CONTROL_PLANE_MIGRATIONS[1]!
  const interactionScope = CLOUD_CONTROL_PLANE_MIGRATIONS[2]!
  const idempotencyScope = CLOUD_CONTROL_PLANE_MIGRATIONS[3]!
  const artifactUploadLifecycle = CLOUD_CONTROL_PLANE_MIGRATIONS[4]!
  const concurrent = CLOUD_CONTROL_PLANE_MIGRATIONS[5]!
  const baselineSql = baseline.statements.join('\n')

  assert.equal(baseline.transactional, undefined)
  assert.equal(workflowSecrets.transactional, undefined)
  assert.equal(interactionScope.transactional, undefined)
  assert.equal(idempotencyScope.transactional, undefined)
  assert.equal(artifactUploadLifecycle.transactional, undefined)
  assert.equal(concurrent.transactional, false)
  assert.match(baselineSql, /CREATE TABLE IF NOT EXISTS cloud_workflow_webhook_secrets/)
  assert.equal(CLOUD_CONTROL_PLANE_REQUIRED_TABLE_NAMES.includes('cloud_workflow_webhook_secrets'), true)
  assert.equal(CLOUD_CONTROL_PLANE_SCHEMA_MANIFEST.tableNames.includes('cloud_workflow_webhook_secrets'), true)
  assert.match(workflowSecrets.statements.join('\n'), /CREATE TABLE IF NOT EXISTS cloud_workflow_webhook_secrets/)
  assert.match(interactionScope.statements.join('\n'), /ADD COLUMN IF NOT EXISTS session_binding_id/)
  assert.doesNotMatch(baselineSql, /\bALTER TABLE\b/)
  assert.doesNotMatch(baselineSql, /\bDELETE FROM\b/)
  assert.doesNotMatch(baselineSql, /INSERT INTO cloud_(?:orgs|accounts|memberships)\b/)
  assert.doesNotMatch(baselineSql, /GREATEST\(0, cloud_concurrency_counters\.value/)
  assert.match(idempotencyScope.statements.join('\n'), /DROP INDEX IF EXISTS cloud_channel_provider_events_dedupe_idx/)
  assert.match(artifactUploadLifecycle.statements.join('\n'), /ADD COLUMN IF NOT EXISTS staging_object_key/)
  assert.match(artifactUploadLifecycle.statements.join('\n'), /ADD COLUMN IF NOT EXISTS publication_metadata jsonb NOT NULL/)
  assert.match(artifactUploadLifecycle.statements.join('\n'), /ADD COLUMN IF NOT EXISTS cleanup_requested_at/)
  assert.match(artifactUploadLifecycle.statements.join('\n'), /ADD COLUMN IF NOT EXISTS cleanup_passes integer NOT NULL DEFAULT 0/)
  assert.match(artifactUploadLifecycle.statements.join('\n'), /ADD COLUMN IF NOT EXISTS finalization_attempts integer NOT NULL DEFAULT 0/)
  assert.match(artifactUploadLifecycle.statements.join('\n'), /cloud_artifact_upload_reservations_terminal_retention_idx/)
  assert.doesNotMatch(artifactUploadLifecycle.statements.join('\n'), /WHEN status = 'settled' THEN 'finalized'/)
  assert.match(artifactUploadLifecycle.statements.join('\n'), /reserved_bytes = COALESCE\(settled_bytes, reserved_bytes\)/)
  assert.match(artifactUploadLifecycle.statements.join('\n'), /INSERT INTO cloud_artifact_index/)
  assert.match(artifactUploadLifecycle.statements.join('\n'), /INSERT INTO cloud_usage_events/)
  assert.match(
    artifactUploadLifecycle.statements.join('\n'),
    /status = 'cleanup_pending'[\s\S]*WHERE status IN \('settled', 'expired', 'failed'\)/,
  )
  assert.match(artifactUploadLifecycle.statements.join('\n'), /DROP COLUMN IF EXISTS settled_bytes/)
  assert.doesNotMatch(
    CLOUD_CONTROL_PLANE_MIGRATIONS
      .filter((migration) => (
        migration.id !== CLOUD_CONTROL_PLANE_CHANNEL_IDEMPOTENCY_SCOPE_MIGRATION_ID
        && migration.id !== CLOUD_CONTROL_PLANE_ARTIFACT_UPLOAD_LIFECYCLE_MIGRATION_ID
      ))
      .flatMap((migration) => migration.statements)
      .join('\n'),
    /\bDROP INDEX\b/,
  )
  for (const statement of concurrent.statements) {
    assert.match(statement, /^CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS /)
  }
})

test('artifact lifecycle migration repairs published settlements and quarantines unpublished bytes', async () => {
  const pool = createPglitePool()
  try {
    await pool.query(`CREATE TABLE cloud_artifact_upload_reservations (
      org_id text NOT NULL,
      tenant_id text NOT NULL,
      user_id text NOT NULL,
      session_id text NOT NULL,
      artifact_id text NOT NULL,
      object_key text NOT NULL,
      filename text NOT NULL,
      content_type text,
      quota_key text,
      quota_window_ms bigint,
      quota_window_started_at_ms bigint,
      reserved_bytes bigint NOT NULL,
      settled_bytes bigint,
      status text NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (org_id, tenant_id, session_id, artifact_id)
    )`)
    await pool.query(`CREATE TABLE cloud_session_events (
      tenant_id text NOT NULL,
      session_id text NOT NULL,
      event_id text NOT NULL,
      sequence integer NOT NULL,
      type text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, session_id, event_id)
    )`)
    await pool.query(`CREATE TABLE cloud_artifact_index (
      tenant_id text NOT NULL,
      user_id text NOT NULL,
      session_id text NOT NULL,
      artifact_id text NOT NULL,
      filename text NOT NULL,
      content_type text,
      size_bytes bigint NOT NULL,
      object_key text NOT NULL,
      kind text NOT NULL,
      status text NOT NULL,
      author_agent_id text,
      project_id text,
      task_id text,
      status_updated_by text,
      status_updated_at timestamptz,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (tenant_id, session_id, artifact_id)
    )`)
    await pool.query(`CREATE TABLE cloud_usage_events (
      event_id text PRIMARY KEY,
      org_id text NOT NULL,
      account_id text,
      event_type text NOT NULL,
      quantity bigint NOT NULL,
      unit text NOT NULL,
      metadata jsonb NOT NULL,
      created_at timestamptz NOT NULL
    )`)
    await pool.query(`CREATE TABLE cloud_memberships (
      org_id text NOT NULL,
      account_id text NOT NULL,
      PRIMARY KEY (org_id, account_id)
    )`)
    await pool.query(`INSERT INTO cloud_memberships (org_id, account_id)
      VALUES ('org-1', 'account-1'), ('org-other', 'account-other')`)

    const settledSizes = new Map([
      ['crash-before-event', 7],
      ['crash-after-event', 8],
      ['crash-after-index', 9],
      ['crash-after-usage', 6],
      ['index-only-published', 5],
      ['malformed-event', 4],
      ['mismatched-index', 3],
      ['mismatched-content-type', 2],
      ['omitted-content-type', 1],
      ['wrong-usage-account', 10],
      ['wrong-usage-metadata', 11],
      ['legacy-usage-shape', 12],
    ])
    const insertReservation = async (artifactId: string, status: string) => pool.query(
      `INSERT INTO cloud_artifact_upload_reservations (
        org_id, tenant_id, user_id, session_id, artifact_id, object_key,
        filename, content_type, quota_key, quota_window_ms, quota_window_started_at_ms,
        reserved_bytes, settled_bytes, status, expires_at, created_at, updated_at
      ) VALUES (
        'org-1', 'tenant-1', 'user-1', 'session-1', $1, $2,
        $5, $6, 'artifact-bytes', 86400000, 1767225600000,
        10, $3, $4, '2026-01-02T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'
      )`,
      [
        artifactId,
        `legacy/${artifactId}`,
        settledSizes.get(artifactId) ?? null,
        status,
        `${artifactId}.txt`,
        artifactId === 'omitted-content-type' ? null : 'text/plain',
      ],
    )
    await insertReservation('expired-upload', 'expired')
    await insertReservation('failed-upload', 'failed')
    for (const artifactId of settledSizes.keys()) await insertReservation(artifactId, 'settled')

    const artifactRecord = (artifactId: string) => ({
      artifactId,
      sessionId: 'session-1',
      filename: `${artifactId}.txt`,
      contentType: artifactId === 'omitted-content-type' ? 'application/octet-stream' : 'text/plain',
      size: settledSizes.get(artifactId),
      key: `legacy/${artifactId}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      kind: 'document',
      status: 'in-review',
      authorAgentId: 'agent-writer',
      projectId: 'project-1',
      taskId: 'task-1',
      statusUpdatedBy: 'user-1',
      statusUpdatedAt: '2026-01-01T00:30:00.000Z',
    })
    const insertEvent = async (
      artifactId: string,
      sequence: number,
      payload: Record<string, unknown> = artifactRecord(artifactId),
    ) => pool.query(
      `INSERT INTO cloud_session_events (
        tenant_id, session_id, event_id, sequence, type, payload, created_at
      ) VALUES (
        'tenant-1', 'session-1', $1, $2, 'artifact.created', $3::jsonb,
        '2026-01-01T01:00:00.000Z'
      )`,
      [`session-1:artifact.created:${artifactId}`, sequence, JSON.stringify(payload)],
    )
    await insertEvent('crash-after-event', 1)
    await insertEvent('crash-after-index', 2)
    await insertEvent('crash-after-usage', 3)
    await insertEvent('malformed-event', 4, {
      ...artifactRecord('malformed-event'),
      size: 1e100,
      createdAt: '2026-99-99T00:00:00.000Z',
      authorAgentId: 'x'.repeat(513),
    })

    const insertIndex = async (artifactId: string) => {
      const record = artifactRecord(artifactId)
      return pool.query(
        `INSERT INTO cloud_artifact_index (
          tenant_id, user_id, session_id, artifact_id, filename, content_type,
          size_bytes, object_key, kind, status, author_agent_id, project_id, task_id,
          status_updated_by, status_updated_at, created_at, updated_at
        ) VALUES (
          'tenant-1', 'user-1', 'session-1', $1, $2, $3,
          $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14
        )`,
        [
          artifactId, record.filename, record.contentType, record.size, record.key,
          record.kind, record.status, record.authorAgentId, record.projectId, record.taskId,
          record.statusUpdatedBy, record.statusUpdatedAt, record.createdAt, record.updatedAt,
        ],
      )
    }
    await insertIndex('crash-after-index')
    await insertIndex('crash-after-usage')
    await insertIndex('index-only-published')
    await insertIndex('mismatched-index')
    await insertIndex('mismatched-content-type')
    await insertIndex('omitted-content-type')
    await insertIndex('wrong-usage-account')
    await insertIndex('wrong-usage-metadata')
    await insertIndex('legacy-usage-shape')
    await pool.query(
      `UPDATE cloud_artifact_index SET object_key = 'legacy/different-object'
       WHERE artifact_id = 'mismatched-index'`,
    )
    await pool.query(
      `UPDATE cloud_artifact_index SET content_type = 'application/json'
       WHERE artifact_id = 'mismatched-content-type'`,
    )
    await pool.query(
      `INSERT INTO cloud_usage_events (
        event_id, org_id, account_id, event_type, quantity, unit, metadata, created_at
      ) VALUES (
        'artifact.uploaded:tenant-1:session-1:crash-after-usage',
        'org-1', NULL, 'artifact.uploaded', 6, 'byte', '{}'::jsonb,
        '2026-01-01T01:00:00.000Z'
      )`,
    )
    await pool.query(
      `INSERT INTO cloud_usage_events (
        event_id, org_id, account_id, event_type, quantity, unit, metadata, created_at
      ) VALUES (
        'artifact.uploaded:tenant-1:session-1:legacy-usage-shape',
        'org-1', 'account-1', 'artifact.uploaded', 12, 'byte',
        '{"tenantId":"tenant-1","sessionId":"session-1","artifactId":"legacy-usage-shape"}'::jsonb,
        '2026-01-01T01:00:00.000Z'
      )`,
    )
    await pool.query(
      `INSERT INTO cloud_usage_events (
        event_id, org_id, account_id, event_type, quantity, unit, metadata, created_at
      ) VALUES (
        'artifact.uploaded:tenant-1:session-1:wrong-usage-account',
        'org-1', 'user-1', 'artifact.uploaded', 10, 'byte', '{}'::jsonb,
        '2026-01-01T01:00:00.000Z'
      )`,
    )
    await pool.query(
      `INSERT INTO cloud_usage_events (
        event_id, org_id, account_id, event_type, quantity, unit, metadata, created_at
      ) VALUES (
        'artifact.uploaded:tenant-1:session-1:wrong-usage-metadata',
        'org-1', NULL, 'artifact.uploaded', 11, 'byte',
        '{"tenantId":"tenant-1","sessionId":"session-1","artifactId":"wrong-usage-metadata"}'::jsonb,
        '2026-01-01T01:00:00.000Z'
      )`,
    )

    const migration = CLOUD_CONTROL_PLANE_MIGRATIONS.find(
      (entry) => entry.id === CLOUD_CONTROL_PLANE_ARTIFACT_UPLOAD_LIFECYCLE_MIGRATION_ID,
    )!
    for (const statement of migration.statements) await pool.query(statement)

    const migrationState = async () => {
      const reservations = await pool.query(`SELECT
          artifact_id, status, reserved_bytes::int, content_type, staging_object_key, final_object_key,
          staging_cleaned_at IS NOT NULL AS staging_cleaned,
          cleanup_reason, cleanup_requested_at IS NOT NULL AS cleanup_requested,
          next_cleanup_attempt_at >= expires_at AS cleanup_after_expiry,
          quota_key, quota_window_ms::bigint, quota_window_started_at_ms::bigint,
          publication_metadata
        FROM cloud_artifact_upload_reservations ORDER BY artifact_id`)
      const indexes = await pool.query(`SELECT
          artifact_id, filename, content_type, size_bytes::int, object_key, kind, status,
          author_agent_id, project_id, task_id, status_updated_by,
          status_updated_at, created_at, updated_at
        FROM cloud_artifact_index ORDER BY artifact_id`)
      const usage = await pool.query(`SELECT event_id, org_id, account_id, event_type, quantity::int, unit, metadata
        FROM cloud_usage_events ORDER BY event_id`)
      return { reservations: reservations.rows, indexes: indexes.rows, usage: usage.rows }
    }
    const firstPass = await migrationState()

    for (const statement of migration.statements) await pool.query(statement)
    assert.deepEqual(await migrationState(), firstPass)
    assert.equal((await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'cloud_artifact_upload_reservations' AND column_name = 'settled_bytes'`,
    )).rows.length, 0)

    const reservations = new Map(firstPass.reservations.map((row) => [String(row.artifact_id), row]))
    assert.deepEqual(reservations.get('crash-before-event'), {
      artifact_id: 'crash-before-event',
      status: 'cleanup_pending',
      reserved_bytes: 7,
      content_type: 'text/plain',
      staging_object_key: 'legacy/crash-before-event',
      final_object_key: 'legacy/crash-before-event',
      staging_cleaned: false,
      cleanup_reason: 'failed',
      cleanup_requested: true,
      cleanup_after_expiry: true,
      quota_key: 'artifact-bytes',
      quota_window_ms: 86400000,
      quota_window_started_at_ms: 1767225600000,
      publication_metadata: {},
    })
    for (const artifactId of [
      'crash-after-event',
      'crash-after-index',
      'crash-after-usage',
      'index-only-published',
      'legacy-usage-shape',
      'omitted-content-type',
    ]) {
      const row = reservations.get(artifactId)!
      assert.equal(row.status, 'finalized')
      assert.equal(row.reserved_bytes, settledSizes.get(artifactId))
      assert.equal(row.staging_cleaned, true)
      assert.equal(row.cleanup_reason, null)
      assert.equal(row.cleanup_after_expiry, null)
      assert.equal(
        row.content_type,
        artifactId === 'omitted-content-type' ? 'application/octet-stream' : 'text/plain',
      )
      assert.deepEqual(row.publication_metadata, {
        kind: 'document',
        artifactStatus: 'in-review',
        authorAgentId: 'agent-writer',
        projectId: 'project-1',
        taskId: 'task-1',
        statusUpdatedBy: 'user-1',
        statusUpdatedAt: '2026-01-01T00:30:00.000Z',
      })
    }
    for (const artifactId of ['expired-upload', 'failed-upload']) {
      const row = reservations.get(artifactId)!
      assert.equal(row.status, 'cleanup_pending')
      assert.equal(row.quota_key, null)
      assert.equal(row.quota_window_ms, null)
      assert.equal(row.quota_window_started_at_ms, null)
    }
    for (const artifactId of [
      'malformed-event',
      'mismatched-index',
    ]) {
      const row = reservations.get(artifactId)!
      assert.equal(row.status, 'cleanup_pending')
      assert.equal(row.reserved_bytes, settledSizes.get(artifactId))
      assert.equal(row.cleanup_reason, 'failed')
      assert.equal(row.cleanup_after_expiry, true)
      assert.deepEqual(row.publication_metadata, {})
    }
    for (const artifactId of [
      'mismatched-content-type',
      'wrong-usage-account',
      'wrong-usage-metadata',
    ]) {
      const row = reservations.get(artifactId)!
      assert.equal(row.status, 'finalizing')
      assert.equal(row.reserved_bytes, settledSizes.get(artifactId))
      assert.equal(row.cleanup_reason, null)
      assert.equal(row.cleanup_after_expiry, null)
      if (artifactId === 'mismatched-content-type') {
        assert.deepEqual(row.publication_metadata, {})
      } else {
        assert.equal(row.publication_metadata.artifactStatus, 'in-review')
      }
    }
    assert.deepEqual((await pool.query(
      `SELECT artifact_id, claim_owner, claim_token, last_error_code,
              claim_expires_at > '9999-01-01T00:00:00.000Z'::timestamptz AS fenced
       FROM cloud_artifact_upload_reservations
       WHERE artifact_id IN ('mismatched-content-type', 'wrong-usage-account', 'wrong-usage-metadata')
       ORDER BY artifact_id`,
    )).rows, [
      {
        artifact_id: 'mismatched-content-type',
        claim_owner: 'migration-006-publication-fence',
        claim_token: 'artifact-index-conflict',
        last_error_code: 'publication_index_conflict',
        fenced: true,
      },
      {
        artifact_id: 'wrong-usage-account',
        claim_owner: 'migration-006-publication-fence',
        claim_token: 'canonical-usage-collision',
        last_error_code: 'publication_usage_collision',
        fenced: true,
      },
      {
        artifact_id: 'wrong-usage-metadata',
        claim_owner: 'migration-006-publication-fence',
        claim_token: 'canonical-usage-collision',
        last_error_code: 'publication_usage_collision',
        fenced: true,
      },
    ])

    assert.deepEqual(firstPass.indexes.map((row) => row.artifact_id), [
      'crash-after-event',
      'crash-after-index',
      'crash-after-usage',
      'index-only-published',
      'legacy-usage-shape',
      'mismatched-content-type',
      'mismatched-index',
      'omitted-content-type',
      'wrong-usage-account',
      'wrong-usage-metadata',
    ])
    assert.deepEqual(firstPass.usage.map((row) => [row.event_id, row.quantity]), [
      ['artifact.uploaded:tenant-1:session-1:crash-after-event', 8],
      ['artifact.uploaded:tenant-1:session-1:crash-after-index', 9],
      ['artifact.uploaded:tenant-1:session-1:crash-after-usage', 6],
      ['artifact.uploaded:tenant-1:session-1:index-only-published', 5],
      ['artifact.uploaded:tenant-1:session-1:legacy-usage-shape', 12],
      ['artifact.uploaded:tenant-1:session-1:omitted-content-type', 1],
      ['artifact.uploaded:tenant-1:session-1:wrong-usage-account', 10],
      ['artifact.uploaded:tenant-1:session-1:wrong-usage-metadata', 11],
    ])
    assert.deepEqual(firstPass.usage.map((row) => [row.event_id, row.account_id]), [
      ['artifact.uploaded:tenant-1:session-1:crash-after-event', null],
      ['artifact.uploaded:tenant-1:session-1:crash-after-index', null],
      ['artifact.uploaded:tenant-1:session-1:crash-after-usage', null],
      ['artifact.uploaded:tenant-1:session-1:index-only-published', null],
      ['artifact.uploaded:tenant-1:session-1:legacy-usage-shape', 'account-1'],
      ['artifact.uploaded:tenant-1:session-1:omitted-content-type', null],
      ['artifact.uploaded:tenant-1:session-1:wrong-usage-account', 'user-1'],
      ['artifact.uploaded:tenant-1:session-1:wrong-usage-metadata', null],
    ])
    assert.deepEqual(
      firstPass.usage
        .filter((row) => row.org_id === 'org-1' && row.metadata.tenantId === undefined)
        .map((row) => row.metadata),
      [
        {},
        {},
        {},
        {},
        {},
        {},
      ],
    )
  } finally {
    await pool.end()
  }
})
