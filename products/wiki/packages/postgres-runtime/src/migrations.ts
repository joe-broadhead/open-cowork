import { POSTGRES_RUNTIME_MIGRATIONS, type PostgresMigration } from "./schema.ts";
import { openPostgresSql } from "./connection.ts";
import { databaseUrlSource, resolvePostgresDatabaseUrl } from "./config.ts";
import type { PostgresMigrationDiagnostics, PostgresMigrationResult, PostgresRuntimeOptions, PostgresSql } from "./types.ts";

const OPENWIKI_MIGRATION_LOCK_CLASS_ID = 708650494;
const OPENWIKI_MIGRATION_LOCK_OBJECT_ID = 1985202519;
const postgresMigrationCache = new Map<string, Promise<PostgresMigrationResult>>();

export async function migratePostgresRuntime(options: PostgresRuntimeOptions = {}): Promise<PostgresMigrationResult> {
  const databaseUrl = resolvePostgresDatabaseUrl(options);
  if (process.env.OPENWIKI_POSTGRES_MIGRATION_CACHE !== "0") {
    const cached = postgresMigrationCache.get(databaseUrl);
    if (cached !== undefined) {
      await cached;
      return cachedPostgresMigrationResult(options);
    }
    const migrating = migratePostgresRuntimeUncached(databaseUrl, options).catch((error: unknown) => {
      postgresMigrationCache.delete(databaseUrl);
      throw error;
    });
    postgresMigrationCache.set(databaseUrl, migrating);
    return migrating;
  }
  return migratePostgresRuntimeUncached(databaseUrl, options);
}

function cachedPostgresMigrationResult(options: PostgresRuntimeOptions): PostgresMigrationResult {
  return {
    database_url_env: options.databaseUrl === undefined ? databaseUrlSource(options.databaseUrlEnv ?? process.env) : "explicit",
    applied: [],
    skipped: POSTGRES_RUNTIME_MIGRATIONS.map((migration) => migration.id),
  };
}

async function migratePostgresRuntimeUncached(databaseUrl: string, options: PostgresRuntimeOptions): Promise<PostgresMigrationResult> {
  const openedSql = openPostgresSql({ databaseUrl });
  const { sql } = openedSql;
  try {
    await ensureMigrationTable(sql);
    const applied: string[] = [];
    const skipped: string[] = [];
    await sql`SELECT pg_advisory_lock(${OPENWIKI_MIGRATION_LOCK_CLASS_ID}, ${OPENWIKI_MIGRATION_LOCK_OBJECT_ID})`;
    try {
      for (const migration of POSTGRES_RUNTIME_MIGRATIONS) {
        const result = migration.transactional === false
          ? await applyPostgresMigration(sql, migration)
          : await sql.begin((tx) => applyPostgresMigration(tx as unknown as PostgresSql, migration));
        if (result === "applied") {
          applied.push(migration.id);
        } else {
          skipped.push(migration.id);
        }
      }
    } finally {
      await sql`SELECT pg_advisory_unlock(${OPENWIKI_MIGRATION_LOCK_CLASS_ID}, ${OPENWIKI_MIGRATION_LOCK_OBJECT_ID})`;
    }
    return {
      database_url_env: options.databaseUrl === undefined ? databaseUrlSource(options.databaseUrlEnv ?? process.env) : "explicit",
      applied,
      skipped,
    };
  } finally {
    await openedSql.close();
  }
}

async function applyPostgresMigration(sql: PostgresSql, migration: PostgresMigration): Promise<"applied" | "skipped"> {
  const exists = await migrationApplied(sql, migration.id);
  if (exists) {
    return "skipped";
  }
  assertStaticPostgresMigration(migration);
  await applyStaticPostgresMigrationSql(sql, migration);
  const inserted = await sql<Array<{ migration_id: string }>>`
    INSERT INTO openwiki_migrations (migration_id, name, applied_at)
    VALUES (${migration.id}, ${migration.name}, now())
    ON CONFLICT (migration_id) DO NOTHING
    RETURNING migration_id
  `;
  return inserted.length > 0 ? "applied" : "skipped";
}

async function applyStaticPostgresMigrationSql(sql: PostgresSql, migration: PostgresMigration): Promise<void> {
  if (migration.transactional !== false) {
    await sql.unsafe(migration.sql);
    return;
  }
  for (const statement of staticPostgresMigrationStatements(migration.sql)) {
    await sql.unsafe(statement);
  }
}

function staticPostgresMigrationStatements(migrationSql: string): string[] {
  return migrationSql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function ensureMigrationTable(sql: PostgresSql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS openwiki_migrations (
      migration_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `;
}

async function migrationApplied(sql: PostgresSql, migrationId: string): Promise<boolean> {
  const rows = await sql`SELECT migration_id FROM openwiki_migrations WHERE migration_id = ${migrationId} LIMIT 1`;
  return rows.length > 0;
}

export async function readPostgresMigrationDiagnostics(options: PostgresRuntimeOptions = {}): Promise<PostgresMigrationDiagnostics> {
  const openedSql = openPostgresSql(options);
  const { sql } = openedSql;
  try {
    const rows = await sql<Array<{ migration_id: string }>>`
      SELECT migration_id
      FROM openwiki_migrations
      ORDER BY applied_at ASC, migration_id ASC
    `;
    const expected = POSTGRES_RUNTIME_MIGRATIONS.map((migration) => migration.id);
    const applied = rows.map((row) => row.migration_id);
    const expectedSet = new Set(expected);
    return {
      expected,
      applied,
      missing: expected.filter((migration) => !applied.includes(migration)),
      extra: applied.filter((migration) => !expectedSet.has(migration)),
    };
  } finally {
    await openedSql.close();
  }
}

export function assertStaticPostgresMigration(migration: PostgresMigration): void {
  if (!/^\d{4}_[a-z0-9_]+$/u.test(migration.id)) {
    throw new Error(`Invalid Postgres migration id: ${migration.id}`);
  }
  if (!migration.sql.trim()) {
    throw new Error(`Postgres migration ${migration.id} has empty SQL`);
  }
  if (/\$\{|\$\d+\b|--\s*@dynamic\b/iu.test(migration.sql)) {
    throw new Error(`Postgres migration ${migration.id} must be static schema SQL`);
  }
  if (!/\b(CREATE\s+(TABLE|INDEX)|ALTER\s+TABLE)\b/iu.test(migration.sql)) {
    throw new Error(`Postgres migration ${migration.id} must contain schema DDL`);
  }
}
