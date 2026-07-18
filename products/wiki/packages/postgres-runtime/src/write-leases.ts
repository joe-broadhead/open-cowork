import { parseJsonObject } from "./records.ts";
import { assertOpenWikiId, writeOpenWikiLog } from "@openwiki/core";
import { loadRepository } from "@openwiki/repo";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { openPostgresSql } from "./connection.ts";
import { postgresRuntimeConfigured, resolvePostgresDatabaseUrl } from "./config.ts";
import { migratePostgresRuntime } from "./migrations.ts";
import { dateStringField, jsonb, stringField } from "./rows.ts";
import { PostgresWriteLeaseBusyError, type AcquirePostgresWriteLeaseInput, type PostgresSql, type PostgresWriteLeaseDiagnostic, type PostgresWriteLeaseInput, type PostgresWriteLeaseRecoveryOptions, type PostgresWriteLeaseRecoveryResult } from "./types.ts";

export async function withPostgresWriteLease<T>(input: PostgresWriteLeaseInput, callback: (signal: AbortSignal) => Promise<T>): Promise<T> {
  assertOpenWikiId(input.actorId, "actor");
  const databaseUrl = resolvePostgresDatabaseUrl(input);
  if (process.env.OPENWIKI_POSTGRES_MIGRATE !== "0") {
    await migratePostgresRuntime({ databaseUrl });
  }
  const repo = await loadRepository(input.root);
  const sql = postgres(databaseUrl, { max: 1 });
  const workspaceId = repo.config.workspace_id;
  const lockName = input.lockName ?? "git-writes";
  const token = randomUUID();
  const leaseMs = boundedLeaseMs(input.leaseMs);
  const heartbeatMs = boundedHeartbeatMs(input.heartbeatMs, leaseMs);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatError: Error | undefined;
  const leaseAbort = new AbortController();
  let advisoryLockHeld = false;

  try {
    await acquirePostgresAdvisoryWriteLock(sql, workspaceId, lockName);
    advisoryLockHeld = true;
    await acquirePostgresWriteLease(sql, {
      workspaceId,
      lockName,
      token,
      actorId: input.actorId,
      operation: input.operation,
      leaseMs,
      metadata: input.metadata ?? {},
    });
    heartbeat = setInterval(() => {
      void heartbeatPostgresWriteLease(sql, workspaceId, lockName, token, leaseMs).catch((error) => {
        heartbeatError = error instanceof Error ? error : new Error(String(error));
        leaseAbort.abort(heartbeatError);
      });
    }, heartbeatMs);
    heartbeat.unref();
    const result = await callback(leaseAbort.signal);
    if (heartbeatError !== undefined) {
      throw heartbeatError;
    }
    return result;
  } finally {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
    }
    try {
      await releasePostgresWriteLease(sql, workspaceId, lockName, token);
    } catch (error) {
      logPostgresWriteLeaseReleaseFailure(workspaceId, lockName, error);
    } finally {
      if (advisoryLockHeld) {
        await releasePostgresAdvisoryWriteLock(sql, workspaceId, lockName).catch((error) => {
          logPostgresWriteLeaseReleaseFailure(workspaceId, `${lockName}:advisory`, error);
        });
      }
      await sql.end({ timeout: 5 });
    }
  }
}

function logPostgresWriteLeaseReleaseFailure(workspaceId: string, lockName: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`openwiki: failed to release Postgres write lease ${workspaceId}/${lockName}: ${message}`);
  writeOpenWikiLog(
    {
      event: "postgres_write_lease_release_failed",
      workspace_id: workspaceId,
      lock_name: lockName,
      error: message,
    },
    { enabled: process.env.OPENWIKI_STRUCTURED_LOGS === "1" },
  );
}

export async function readPostgresWriteLease(
  root: string,
  options: PostgresWriteLeaseRecoveryOptions = {},
): Promise<PostgresWriteLeaseDiagnostic | undefined> {
  if (!postgresRuntimeConfigured(options.databaseUrlEnv ?? process.env) && options.databaseUrl === undefined) {
    return undefined;
  }
  const repo = await loadRepository(root);
  return readPostgresWriteLeaseForWorkspace(repo.config.workspace_id, options);
}

export async function readPostgresWriteLeaseForWorkspace(
  workspaceId: string,
  options: PostgresWriteLeaseRecoveryOptions = {},
): Promise<PostgresWriteLeaseDiagnostic | undefined> {
  if (!postgresRuntimeConfigured(options.databaseUrlEnv ?? process.env) && options.databaseUrl === undefined) {
    return undefined;
  }
  const openedSql = openPostgresSql(options);
  const { sql } = openedSql;
  try {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT workspace_id, lock_name, actor_id, operation, started_at, heartbeat_at, expires_at, metadata
      FROM write_leases
      WHERE workspace_id = ${workspaceId} AND lock_name = ${options.lockName ?? "git-writes"}
      LIMIT 1
    `;
    return rows[0] === undefined ? undefined : postgresWriteLeaseFromRow(rows[0]);
  } finally {
    await openedSql.close();
  }
}

export async function recoverExpiredPostgresWriteLease(
  root: string,
  options: PostgresWriteLeaseRecoveryOptions = {},
): Promise<PostgresWriteLeaseRecoveryResult> {
  const databaseUrl = resolvePostgresDatabaseUrl(options);
  const repo = await loadRepository(root);
  const sql = postgres(databaseUrl, { max: 1 });
  const lockName = options.lockName ?? "git-writes";
  try {
    const active = await readPostgresWriteLease(root, { ...options, databaseUrl, lockName });
    if (active === undefined) {
      return { source: "postgres-runtime", workspace_id: repo.config.workspace_id, lock_name: lockName, recovered: false };
    }
    const recoveredRows = await sql<Array<{ lock_name: string }>>`
      DELETE FROM write_leases
      WHERE workspace_id = ${repo.config.workspace_id}
        AND lock_name = ${lockName}
        AND expires_at <= now()
      RETURNING lock_name
    `;
    return {
      source: "postgres-runtime",
      workspace_id: repo.config.workspace_id,
      lock_name: lockName,
      recovered: recoveredRows.length > 0,
      active,
    };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function acquirePostgresWriteLease(sql: PostgresSql, input: AcquirePostgresWriteLeaseInput): Promise<void> {
  await sql.begin(async (tx) => {
    const startedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + input.leaseMs).toISOString();
    const rows = await tx<Array<Record<string, unknown>>>`
      INSERT INTO write_leases (
        workspace_id, lock_name, token, actor_id, operation, started_at, heartbeat_at, expires_at, metadata
      )
      VALUES (
        ${input.workspaceId}, ${input.lockName}, ${input.token}, ${input.actorId}, ${input.operation}, ${startedAt}, ${startedAt}, ${expiresAt}, ${jsonb(input.metadata)}::jsonb
      )
      ON CONFLICT (workspace_id, lock_name) DO UPDATE SET
        token = EXCLUDED.token,
        actor_id = EXCLUDED.actor_id,
        operation = EXCLUDED.operation,
        started_at = EXCLUDED.started_at,
        heartbeat_at = EXCLUDED.heartbeat_at,
        expires_at = EXCLUDED.expires_at,
        metadata = EXCLUDED.metadata
      WHERE write_leases.expires_at <= ${startedAt}
      RETURNING workspace_id, lock_name, actor_id, operation, started_at, heartbeat_at, expires_at, metadata
    `;
    if (rows[0] !== undefined) {
      return;
    }
    const activeRows = await tx<Array<Record<string, unknown>>>`
      SELECT workspace_id, lock_name, actor_id, operation, started_at, heartbeat_at, expires_at, metadata
      FROM write_leases
      WHERE workspace_id = ${input.workspaceId} AND lock_name = ${input.lockName}
      LIMIT 1
    `;
    const active = activeRows[0];
    if (active !== undefined) {
      throw new PostgresWriteLeaseBusyError(postgresWriteLeaseFromRow(active));
    }
    throw new Error(`Could not acquire OpenWiki write lease: ${input.lockName}`);
  });
}

async function acquirePostgresAdvisoryWriteLock(sql: PostgresSql, workspaceId: string, lockName: string): Promise<void> {
  const rows = await sql<Array<{ acquired: boolean }>>`
    SELECT pg_try_advisory_lock(hashtext(${workspaceId}), hashtext(${lockName})) AS acquired
  `;
  if (rows[0]?.acquired === true) {
    return;
  }
  const activeRows = await sql<Array<Record<string, unknown>>>`
    SELECT workspace_id, lock_name, actor_id, operation, started_at, heartbeat_at, expires_at, metadata
    FROM write_leases
    WHERE workspace_id = ${workspaceId} AND lock_name = ${lockName}
    LIMIT 1
  `;
  const active = activeRows[0];
  if (active !== undefined) {
    throw new PostgresWriteLeaseBusyError(postgresWriteLeaseFromRow(active));
  }
  throw new Error(`Could not acquire OpenWiki advisory write lease: ${lockName}`);
}

async function releasePostgresAdvisoryWriteLock(sql: PostgresSql, workspaceId: string, lockName: string): Promise<void> {
  await sql`
    SELECT pg_advisory_unlock(hashtext(${workspaceId}), hashtext(${lockName}))
  `;
}

async function heartbeatPostgresWriteLease(
  sql: PostgresSql,
  workspaceId: string,
  lockName: string,
  token: string,
  leaseMs: number,
): Promise<void> {
  const heartbeatAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + leaseMs).toISOString();
  const rows = await sql<Array<{ lock_name: string }>>`
    UPDATE write_leases
    SET heartbeat_at = ${heartbeatAt}, expires_at = ${expiresAt}
    WHERE workspace_id = ${workspaceId} AND lock_name = ${lockName} AND token = ${token}
    RETURNING lock_name
  `;
  if (rows[0] === undefined) {
    throw new Error(`Postgres write lease heartbeat lost ownership: ${workspaceId}/${lockName}`);
  }
}

async function releasePostgresWriteLease(sql: PostgresSql, workspaceId: string, lockName: string, token: string): Promise<void> {
  await sql`
    DELETE FROM write_leases
    WHERE workspace_id = ${workspaceId} AND lock_name = ${lockName} AND token = ${token}
  `;
}

function postgresWriteLeaseFromRow(row: Record<string, unknown>): PostgresWriteLeaseDiagnostic {
  return {
    workspace_id: stringField(row, "workspace_id") ?? "",
    lock_name: stringField(row, "lock_name") ?? "",
    actor_id: stringField(row, "actor_id") ?? "",
    operation: stringField(row, "operation") ?? "",
    started_at: dateStringField(row, "started_at") ?? "",
    heartbeat_at: dateStringField(row, "heartbeat_at") ?? "",
    expires_at: dateStringField(row, "expires_at") ?? "",
    metadata: parseJsonObject(row.metadata),
  };
}

function boundedLeaseMs(value: number | undefined): number {
  if (value === undefined) {
    return 30000;
  }
  if (!Number.isFinite(value) || value < 1000 || value > 15 * 60 * 1000) {
    throw new Error("Postgres write lease duration must be between 1000 and 900000 milliseconds");
  }
  return Math.trunc(value);
}

function boundedHeartbeatMs(value: number | undefined, leaseMs: number): number {
  if (value === undefined) {
    return Math.max(250, Math.min(5000, Math.floor(leaseMs / 3)));
  }
  if (!Number.isFinite(value) || value < 100 || value >= leaseMs) {
    throw new Error("Postgres write lease heartbeat must be at least 100 ms and less than the lease duration");
  }
  return Math.trunc(value);
}
