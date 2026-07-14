import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  assertPostgresSchemaManifest,
  createPostgresSchemaManifest,
  type PostgresSchemaExecutor,
} from '@open-cowork/shared/node'

import {
  assertPostgresControlPlaneSchemaIntegrity,
  runPostgresControlPlaneMigrations,
} from '../packages/cloud-server/src/postgres-migrations.ts'
import {
  assertStandaloneGatewaySchemaIntegrity,
  PostgresStandaloneGatewayRepository,
} from '../apps/standalone-gateway/dist/postgres-repository.js'
import { createPglitePool } from './helpers/pglite-pool.ts'

const POSTGRES_URL = process.env.OPEN_COWORK_TEST_POSTGRES_URL
  || process.env.OPEN_COWORK_CLOUD_TEST_POSTGRES_URL
const POSTGRES_SKIP = POSTGRES_URL
  ? false
  : 'Set OPEN_COWORK_TEST_POSTGRES_URL to run real PostgreSQL physical-integrity regressions.'

function transactionRunner(pool: ReturnType<typeof createPglitePool>) {
  return async <T>(run: (client: Awaited<ReturnType<typeof pool.connect>>) => Promise<T>) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await run(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

async function withRolledBackDrift(
  pool: ReturnType<typeof createPglitePool>,
  run: (client: Awaited<ReturnType<typeof pool.connect>>) => Promise<void>,
) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await run(client)
  } finally {
    await client.query('ROLLBACK')
    client.release()
  }
}

test('cloud physical integrity rejects column, constraint, index, and owned-table drift', async () => {
  const pool = createPglitePool()
  try {
    await runPostgresControlPlaneMigrations(pool, transactionRunner(pool))

    await withRolledBackDrift(pool, async (client) => {
      await client.query('ALTER TABLE cloud_worker_heartbeats DROP COLUMN last_seen_at')
      await assert.rejects(
        () => assertPostgresControlPlaneSchemaIntegrity(client),
        /table columns do not match the clean baseline/,
      )
    })

    await withRolledBackDrift(pool, async (client) => {
      await client.query('ALTER TABLE cloud_users DROP CONSTRAINT cloud_users_tenant_id_fkey')
      await assert.rejects(
        () => assertPostgresControlPlaneSchemaIntegrity(client),
        /table constraints do not match the clean baseline/,
      )
    })

    await withRolledBackDrift(pool, async (client) => {
      await client.query('DROP INDEX cloud_sessions_user_idx')
      await client.query(`CREATE INDEX cloud_sessions_user_idx
        ON cloud_sessions (tenant_id, created_at)`)
      await assert.rejects(
        () => assertPostgresControlPlaneSchemaIntegrity(client),
        /explicit indexes do not match the clean baseline/,
      )
    })

    await pool.query('CREATE TABLE cloud_legacy_sessions (session_id text PRIMARY KEY)')
    await assert.rejects(
      () => assertPostgresControlPlaneSchemaIntegrity(pool),
      /product tables do not match the clean baseline/,
    )
    const legacyTable = await pool.query<{ table_name: string }>(
      `SELECT tablename AS table_name FROM pg_catalog.pg_tables
       WHERE schemaname = current_schema() AND tablename = 'cloud_legacy_sessions'`,
    )
    assert.equal(legacyTable.rows[0]?.table_name, 'cloud_legacy_sessions', 'validation must remain read-only')
  } finally {
    await pool.end()
  }
})

test('standalone readiness rejects column, constraint, same-name index, and owned-table drift', async () => {
  const pool = createPglitePool()
  const repository = new PostgresStandaloneGatewayRepository(pool)
  try {
    await repository.migrate()

    await withRolledBackDrift(pool, async (client) => {
      await client.query('ALTER TABLE standalone_gateway_audit_events DROP COLUMN created_at')
      await assert.rejects(
        () => assertStandaloneGatewaySchemaIntegrity(client),
        /table columns do not match the clean baseline/,
      )
    })

    await withRolledBackDrift(pool, async (client) => {
      await client.query(`ALTER TABLE standalone_gateway_channel_identities
        DROP CONSTRAINT standalone_gateway_channel_identities_role_check`)
      await assert.rejects(
        () => assertStandaloneGatewaySchemaIntegrity(client),
        /table constraints do not match the clean baseline/,
      )
    })

    await withRolledBackDrift(pool, async (client) => {
      await client.query(`CREATE FUNCTION standalone_gateway_unexpected_trigger() RETURNS trigger AS $fn$
        BEGIN
          RETURN NEW;
        END;
      $fn$ LANGUAGE plpgsql`)
      await client.query(`CREATE TRIGGER standalone_gateway_unexpected_trigger
        BEFORE UPDATE ON standalone_gateway_sessions
        FOR EACH ROW EXECUTE FUNCTION standalone_gateway_unexpected_trigger()`)
      await assert.rejects(
        () => assertStandaloneGatewaySchemaIntegrity(client),
        /not bound to the exact verified function schema, OID, and signature/,
      )
    })

    await withRolledBackDrift(pool, async (client) => {
      await client.query('DROP INDEX standalone_gateway_events_session_sequence_idx')
      await client.query(`CREATE INDEX standalone_gateway_events_session_sequence_idx
        ON standalone_gateway_events (sequence, session_id)`)
      await assert.rejects(
        () => assertStandaloneGatewaySchemaIntegrity(client),
        /explicit indexes do not match the clean baseline/,
      )
    })

    await pool.query('CREATE TABLE standalone_gateway_legacy_jobs (job_id text PRIMARY KEY)')
    assert.match((await repository.readiness()).detail, /product tables do not match the clean baseline/)
    const legacyTable = await pool.query<{ table_name: string }>(
      `SELECT tablename AS table_name FROM pg_catalog.pg_tables
       WHERE schemaname = current_schema() AND tablename = 'standalone_gateway_legacy_jobs'`,
    )
    assert.equal(legacyTable.rows[0]?.table_name, 'standalone_gateway_legacy_jobs', 'readiness must remain read-only')
  } finally {
    await repository.close?.()
  }
})

test('Postgres literal normalization preserves case and escaped quotes in defaults, CHECKs, and predicates', async () => {
  const baseline = [
    `CREATE TABLE IF NOT EXISTS literal_fixture (
      id text PRIMARY KEY,
      state text NOT NULL DEFAULT 'Owner''s Queue'
        CHECK (state IN ('Owner''s Queue', 'Done'))
    )`,
    `CREATE INDEX IF NOT EXISTS literal_fixture_state_idx
      ON literal_fixture (state)
      WHERE state = 'Owner''s Queue'`,
  ]
  const manifest = createPostgresSchemaManifest(baseline)
  const pool = createPglitePool()
  try {
    for (const statement of baseline) await pool.query(statement)
    await assertPostgresSchemaManifest(pool, manifest, new Set(['literal_fixture']))

    await withRolledBackDrift(pool, async (client) => {
      await client.query(`ALTER TABLE literal_fixture
        ALTER COLUMN state SET DEFAULT 'owner''s Queue'`)
      await assert.rejects(
        () => assertPostgresSchemaManifest(client, manifest, new Set(['literal_fixture'])),
        /table columns do not match the clean baseline/,
      )
    })

    await withRolledBackDrift(pool, async (client) => {
      await client.query('ALTER TABLE literal_fixture DROP CONSTRAINT literal_fixture_state_check')
      await client.query(`ALTER TABLE literal_fixture
        ADD CONSTRAINT literal_fixture_state_check
        CHECK (state IN ('owner''s Queue', 'Done'))`)
      await assert.rejects(
        () => assertPostgresSchemaManifest(client, manifest, new Set(['literal_fixture'])),
        /table constraints do not match the clean baseline/,
      )
    })

    await withRolledBackDrift(pool, async (client) => {
      await client.query('DROP INDEX literal_fixture_state_idx')
      await client.query(`CREATE INDEX literal_fixture_state_idx
        ON literal_fixture (state)
        WHERE state = 'owner''s Queue'`)
      await assert.rejects(
        () => assertPostgresSchemaManifest(client, manifest, new Set(['literal_fixture'])),
        /explicit indexes do not match the clean baseline/,
      )
    })

    await withRolledBackDrift(pool, async (client) => {
      await client.query('DROP INDEX literal_fixture_state_idx')
      await client.query(`CREATE INDEX literal_fixture_state_idx
        ON literal_fixture USING hash (state)
        WHERE state = 'Owner''s Queue'`)
      await assert.rejects(
        () => assertPostgresSchemaManifest(client, manifest, new Set(['literal_fixture'])),
        /explicit indexes do not match the clean baseline/,
      )
    })
  } finally {
    await pool.end()
  }
})

const BEHAVIOR_SECURITY_BASELINE = [
  `CREATE TABLE IF NOT EXISTS integrity_parent (
    id text PRIMARY KEY
  )`,
  `CREATE TABLE IF NOT EXISTS integrity_child (
    id text PRIMARY KEY,
    parent_id text,
    state text NOT NULL,
    CONSTRAINT integrity_child_parent_fkey
      FOREIGN KEY (parent_id) REFERENCES integrity_parent (id)
      MATCH SIMPLE ON UPDATE NO ACTION ON DELETE NO ACTION
      NOT DEFERRABLE INITIALLY IMMEDIATE,
    CONSTRAINT integrity_child_state_check
      CHECK (state IN ('active', 'disabled')),
    CONSTRAINT integrity_child_id_state_uq
      UNIQUE (id, state) DEFERRABLE INITIALLY DEFERRED
  )`,
  `CREATE OR REPLACE FUNCTION integrity_default_function() RETURNS text AS $fn$
    SELECT 'ok'::text
  $fn$ LANGUAGE sql`,
  `CREATE OR REPLACE FUNCTION integrity_hardened_function() RETURNS text
    LANGUAGE sql STABLE LEAKPROOF STRICT SECURITY DEFINER PARALLEL SAFE
    SET search_path TO pg_catalog, public
    SET statement_timeout TO '5s'
    AS $fn$
      SELECT 'ok'::text
    $fn$`,
  `CREATE OR REPLACE FUNCTION integrity_trigger_function() RETURNS trigger AS $fn$
    BEGIN
      RETURN NULL;
    END;
  $fn$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE TRIGGER integrity_child_row_guard
    BEFORE UPDATE ON integrity_child
    FOR EACH ROW
    WHEN (OLD.state IS DISTINCT FROM NEW.state)
    EXECUTE FUNCTION integrity_trigger_function('row-audit')`,
  `CREATE OR REPLACE TRIGGER integrity_child_transition_audit
    AFTER UPDATE ON integrity_child
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
    FOR EACH STATEMENT
    EXECUTE FUNCTION integrity_trigger_function('transition-audit')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS integrity_child_parent_unique_idx
    ON integrity_child (parent_id)`,
] as const

const BEHAVIOR_SECURITY_TABLES = new Set(['integrity_child', 'integrity_parent'])
const BEHAVIOR_SECURITY_MANIFEST = createPostgresSchemaManifest(BEHAVIOR_SECURITY_BASELINE)

async function applyStatements(executor: PostgresSchemaExecutor, statements: readonly string[]) {
  for (const statement of statements) await executor.query(statement)
}

async function assertRolledBackManifestDrift(
  executor: PostgresSchemaExecutor,
  statements: readonly string[],
  expected: RegExp,
) {
  await executor.query('BEGIN')
  try {
    await applyStatements(executor, statements)
    await assert.rejects(
      () => assertPostgresSchemaManifest(executor, BEHAVIOR_SECURITY_MANIFEST, BEHAVIOR_SECURITY_TABLES),
      expected,
    )
  } finally {
    await executor.query('ROLLBACK')
  }
}

async function exerciseBehaviorAndSecurityDrift(executor: PostgresSchemaExecutor) {
  await applyStatements(executor, BEHAVIOR_SECURITY_BASELINE)
  await assertPostgresSchemaManifest(executor, BEHAVIOR_SECURITY_MANIFEST, BEHAVIOR_SECURITY_TABLES)

  const foreignKeyChanges = [
    'MATCH FULL',
    'ON UPDATE CASCADE',
    'ON DELETE SET NULL',
    'DEFERRABLE INITIALLY DEFERRED',
    'NOT VALID',
  ]
  for (const clause of foreignKeyChanges) {
    await assertRolledBackManifestDrift(executor, [
      'ALTER TABLE integrity_child DROP CONSTRAINT integrity_child_parent_fkey',
      `ALTER TABLE integrity_child ADD CONSTRAINT integrity_child_parent_fkey
        FOREIGN KEY (parent_id) REFERENCES integrity_parent (id) ${clause}`,
    ], /table constraints do not match the clean baseline/)
  }

  for (const clause of ['NO INHERIT', 'NOT VALID']) {
    await assertRolledBackManifestDrift(executor, [
      'ALTER TABLE integrity_child DROP CONSTRAINT integrity_child_state_check',
      `ALTER TABLE integrity_child ADD CONSTRAINT integrity_child_state_check
        CHECK (state IN ('active', 'disabled')) ${clause}`,
    ], /table constraints do not match the clean baseline/)
  }

  await assertRolledBackManifestDrift(executor, [
    'CREATE SCHEMA integrity_fk_shadow',
    'CREATE TABLE integrity_fk_shadow.integrity_parent (id text PRIMARY KEY)',
    'ALTER TABLE integrity_child DROP CONSTRAINT integrity_child_parent_fkey',
    `ALTER TABLE integrity_child ADD CONSTRAINT integrity_child_parent_fkey
      FOREIGN KEY (parent_id) REFERENCES integrity_fk_shadow.integrity_parent (id)`,
  ], /table constraints do not match the clean baseline/)

  await assertRolledBackManifestDrift(executor, [
    'DROP INDEX integrity_child_parent_unique_idx',
    `CREATE UNIQUE INDEX integrity_child_parent_unique_idx
      ON integrity_child (parent_id) NULLS NOT DISTINCT`,
  ], /explicit indexes do not match the clean baseline/)

  const functionChanges = [
    ['ALTER FUNCTION integrity_default_function() SECURITY DEFINER'],
    ['ALTER FUNCTION integrity_default_function() SET search_path TO pg_catalog, public'],
    ['ALTER FUNCTION integrity_default_function() STABLE'],
    ['ALTER FUNCTION integrity_default_function() LEAKPROOF'],
    ['ALTER FUNCTION integrity_default_function() STRICT'],
    ['ALTER FUNCTION integrity_default_function() PARALLEL SAFE'],
    [
      'ALTER FUNCTION integrity_default_function() SECURITY DEFINER',
      'ALTER FUNCTION integrity_default_function() SET search_path TO pg_catalog, public',
    ],
  ]
  for (const statements of functionChanges) {
    await assertRolledBackManifestDrift(
      executor,
      statements,
      /schema functions do not match the clean baseline/,
    )
  }
  await assertRolledBackManifestDrift(executor, [
    `CREATE FUNCTION integrity_trigger_function(integer) RETURNS integer
      LANGUAGE sql IMMUTABLE AS 'SELECT $1'`,
  ], /schema functions do not match the clean baseline/)

  const triggerChanges = [
    [
      `CREATE OR REPLACE TRIGGER integrity_child_row_guard
        BEFORE UPDATE ON integrity_child
        FOR EACH ROW WHEN (false)
        EXECUTE FUNCTION integrity_trigger_function('row-audit')`,
    ],
    [
      `CREATE OR REPLACE TRIGGER integrity_child_row_guard
        BEFORE UPDATE ON integrity_child
        FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
        EXECUTE FUNCTION integrity_trigger_function('forged-audit')`,
    ],
    [
      `CREATE OR REPLACE TRIGGER integrity_child_transition_audit
        AFTER UPDATE ON integrity_child
        REFERENCING OLD TABLE AS prior_rows NEW TABLE AS current_rows
        FOR EACH STATEMENT
        EXECUTE FUNCTION integrity_trigger_function('transition-audit')`,
    ],
  ]
  for (const statements of triggerChanges) {
    await assertRolledBackManifestDrift(
      executor,
      statements,
      /table triggers do not match the clean baseline/,
    )
  }

  await assertRolledBackManifestDrift(executor, [
    'CREATE SCHEMA integrity_shadow',
    `CREATE FUNCTION integrity_shadow.integrity_trigger_function() RETURNS trigger AS $fn$
      BEGIN
        RETURN NULL;
      END;
    $fn$ LANGUAGE plpgsql`,
    `CREATE OR REPLACE TRIGGER integrity_child_row_guard
      BEFORE UPDATE ON integrity_child
      FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state)
      EXECUTE FUNCTION integrity_shadow.integrity_trigger_function('row-audit')`,
  ], /not bound to the exact verified function schema, OID, and signature/)
}

test('Postgres manifest validates constraint behavior and function security attributes in PGlite', async () => {
  const pool = createPglitePool()
  try {
    await exerciseBehaviorAndSecurityDrift(pool)
  } finally {
    await pool.end()
  }
})

test('Postgres 17 manifest rejects behavioral and security drift', { skip: POSTGRES_SKIP }, async () => {
  assert.ok(POSTGRES_URL)
  const { Client } = await import('pg') as unknown as {
    Client: new (config: { connectionString: string }) => PostgresSchemaExecutor & {
      connect(): Promise<void>
      end(): Promise<void>
    }
  }
  const client = new Client({ connectionString: POSTGRES_URL })
  const schemaName = `integrity_${randomUUID().replaceAll('-', '')}`
  await client.connect()
  try {
    await client.query(`CREATE SCHEMA ${schemaName}`)
    await client.query(`SET search_path TO ${schemaName}`)
    await exerciseBehaviorAndSecurityDrift(client)
  } finally {
    await client.query('SET search_path TO public').catch(() => {})
    await client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {})
    await client.end()
  }
})
