import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { standaloneRetentionCutoffs } from "./retention.js";
import {
  STANDALONE_GATEWAY_BASELINE_MIGRATION_ID,
  STANDALONE_GATEWAY_REQUIRED_TABLE_NAMES,
  standaloneGatewayMigrations,
} from "./schema.js";
import {
  normalizeIdentityRole,
  normalizeIdentityStatus,
  normalizeWorkspaceId,
  redactRecord,
  retentionAuditMetadata,
  retentionResult,
} from "./repository.js";
import { redactSecretText } from "./redaction.js";
import type { StandaloneGatewayRepository, StandaloneGatewayLeaseRef } from "./repository.js";
import type {
  StandaloneGatewayAuditRecord,
  StandaloneGatewayChannelIdentityRecord,
  StandaloneGatewayDaemonLease,
  StandaloneGatewayDashboardSnapshot,
  StandaloneGatewayEventRecord,
  StandaloneGatewayEventType,
  StandaloneGatewayJobKind,
  StandaloneGatewayJobRecord,
  StandaloneGatewayIdentityAuthorizationSummary,
  StandaloneGatewayIdentityRole,
  StandaloneGatewayIdentityStatus,
  StandaloneGatewayRetentionResult,
  StandaloneGatewaySessionRecord,
  StandalonePromptInput,
  StandaloneGatewayConfig,
} from "./types.js";

export interface PgLikeClient {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  release?(): void;
}

export interface PgLikePool extends PgLikeClient {
  connect?(): Promise<PgLikeClient>;
  end?(): Promise<void>;
}

export interface StandalonePostgresPoolOptions {
  connectionString: string;
  ssl?: {
    rejectUnauthorized: boolean;
    ca?: string;
    cert?: string;
    key?: string;
  };
}

export interface CreateStandaloneGatewayPostgresRepositoryOptions {
  createPool?: (options: StandalonePostgresPoolOptions) => PgLikePool;
  readFile?: (path: string) => string;
}

type StandaloneDatabaseConfig = StandaloneGatewayConfig["database"];
const STANDALONE_GATEWAY_SCHEMA_MIGRATIONS_TABLE = "standalone_gateway_schema_migrations";
const STANDALONE_GATEWAY_MIGRATION_ADVISORY_LOCK_KEYS = [1_397_704_504, 1_731_276_783] as const;

export async function createStandaloneGatewayPostgresRepository(
  database: string | StandaloneDatabaseConfig,
  options: CreateStandaloneGatewayPostgresRepositoryOptions = {},
): Promise<StandaloneGatewayRepository> {
  const poolOptions = standalonePostgresPoolOptions(database, { readFile: options.readFile });
  if (options.createPool) {
    return new PostgresStandaloneGatewayRepository(options.createPool(poolOptions));
  }
  const pg = await import("pg") as {
    Pool: new (options: StandalonePostgresPoolOptions) => PgLikePool;
  };
  return new PostgresStandaloneGatewayRepository(new pg.Pool(poolOptions));
}

export function standalonePostgresPoolOptions(
  database: string | StandaloneDatabaseConfig,
  options: { readFile?: (path: string) => string } = {},
): StandalonePostgresPoolOptions {
  if (typeof database === "string") {
    return { connectionString: database };
  }
  const poolOptions: StandalonePostgresPoolOptions = {
    connectionString: database.ssl ? stripPostgresSslConnectionOptions(database.url) : database.url,
  };
  if (!database.ssl) {
    return poolOptions;
  }
  const readFile = options.readFile || ((path: string) => readFileSync(path, "utf8"));
  poolOptions.ssl = {
    rejectUnauthorized: database.sslRejectUnauthorized,
    ...(database.sslCaPath ? { ca: readFile(database.sslCaPath) } : {}),
    ...(database.sslCertPath ? { cert: readFile(database.sslCertPath) } : {}),
    ...(database.sslKeyPath ? { key: readFile(database.sslKeyPath) } : {}),
  };
  return poolOptions;
}

function stripPostgresSslConnectionOptions(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    let stripped = false;
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("ssl")) {
        url.searchParams.delete(key);
        stripped = true;
      }
    }
    return stripped ? url.toString() : connectionString;
  } catch {
    return connectionString;
  }
}

export class PostgresStandaloneGatewayRepository implements StandaloneGatewayRepository {
  constructor(private readonly pool: PgLikePool) {}

  async migrate(): Promise<void> {
    await this.withTransaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock($1, $2)",
        [...STANDALONE_GATEWAY_MIGRATION_ADVISORY_LOCK_KEYS],
      );
      const tablesBeforeMigration = await currentStandaloneGatewayTables(client);
      const ledgerExists = tablesBeforeMigration.has(STANDALONE_GATEWAY_SCHEMA_MIGRATIONS_TABLE);
      const applied = ledgerExists
        ? new Set((await client.query<{ id: string }>(
            "SELECT id FROM standalone_gateway_schema_migrations",
          )).rows.map((row) => String(row.id)))
        : new Set<string>();
      if (!applied.has(STANDALONE_GATEWAY_BASELINE_MIGRATION_ID)) {
        const existingDomainTables = [...tablesBeforeMigration]
          .filter((tableName) => tableName !== STANDALONE_GATEWAY_SCHEMA_MIGRATIONS_TABLE);
        if (existingDomainTables.length > 0) {
          throw new Error(
            `Refusing to apply the clean Standalone Gateway baseline because its migration ledger entry is missing while product tables already exist (${summarizeSchemaNames(existingDomainTables)}). `
            + "This pre-release baseline has no adoption or historical upgrade path. Recreate an empty Standalone Gateway schema, or restore a database whose standalone_gateway_schema_migrations ledger matches its schema.",
          );
        }
      }
      for (const migration of standaloneGatewayMigrations) {
        if (applied.has(migration.id)) continue;
        // This is the first durable mutation on a fresh schema. The fail-closed
        // domain-table guard above must always run before it.
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO standalone_gateway_schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
          [migration.id],
        );
      }
      await assertStandaloneGatewaySchemaIntegrity(client);
    });
  }

  async readiness(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.pool.query("SELECT 1");
      await assertStandaloneGatewaySchemaIntegrity(this.pool);
      return { ok: true, detail: "postgres ready; migration ledger and production tables verified" };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async acquireDaemonLease(input: { leaseId: string; ownerId: string; ttlMs: number; now?: Date }): Promise<StandaloneGatewayDaemonLease | null> {
    const now = input.now || new Date();
    const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();
    const leaseToken = randomUUID();
    const result = await this.pool.query<LeaseRow>(
      `INSERT INTO standalone_gateway_daemon_leases (lease_id, owner_id, lease_token, expires_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (lease_id) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           lease_token = EXCLUDED.lease_token,
           expires_at = EXCLUDED.expires_at,
           updated_at = EXCLUDED.updated_at
       WHERE standalone_gateway_daemon_leases.expires_at <= $5
          OR standalone_gateway_daemon_leases.owner_id = $2
       RETURNING *`,
      [input.leaseId, input.ownerId, leaseToken, expiresAt, now.toISOString()],
    );
    return result.rows[0] ? leaseFromRow(result.rows[0]) : null;
  }

  async renewDaemonLease(input: { leaseId: string; ownerId: string; leaseToken: string; ttlMs: number; now?: Date }): Promise<StandaloneGatewayDaemonLease | null> {
    const now = input.now || new Date();
    const result = await this.pool.query<LeaseRow>(
      `UPDATE standalone_gateway_daemon_leases
       SET expires_at = $4, updated_at = $5
       WHERE lease_id = $1 AND owner_id = $2 AND lease_token = $3
       RETURNING *`,
      [input.leaseId, input.ownerId, input.leaseToken, new Date(now.getTime() + input.ttlMs).toISOString(), now.toISOString()],
    );
    return result.rows[0] ? leaseFromRow(result.rows[0]) : null;
  }

  async releaseDaemonLease(input: { leaseId: string; ownerId: string; leaseToken: string }): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM standalone_gateway_daemon_leases WHERE lease_id = $1 AND owner_id = $2 AND lease_token = $3",
      [input.leaseId, input.ownerId, input.leaseToken],
    );
    return (result.rowCount || 0) > 0;
  }

  async findOrCreateSession(input: StandalonePromptInput & { title?: string; now?: Date }): Promise<StandaloneGatewaySessionRecord> {
    const now = (input.now || new Date()).toISOString();
    const externalThreadId = input.target.threadId || input.target.chatId;
    const providerWorkspaceId = normalizeWorkspaceId(input.providerWorkspaceId) || "";
    return this.withTransaction(async (client) => {
      const result = await client.query<SessionRow>(
        `INSERT INTO standalone_gateway_sessions (
           session_id, title, status, provider, provider_kind, channel_binding_id,
           provider_workspace_id, external_user_id, external_chat_id, external_thread_id, created_at, updated_at
         )
         VALUES ($1, $2, 'idle', $3, $4, $5, $6, $7, $8, $9, $10, $10)
         ON CONFLICT (provider, provider_workspace_id, external_chat_id, external_thread_id) DO UPDATE
         SET updated_at = EXCLUDED.updated_at
         RETURNING *`,
        [
          randomUUID(),
          input.title || input.text.slice(0, 80) || "Standalone Gateway session",
          input.provider,
          input.providerKind,
          input.channelBindingId,
          providerWorkspaceId,
          input.externalUserId,
          input.target.chatId,
          externalThreadId,
          now,
        ],
      );
      let session = sessionFromRow(result.rows[0]!);
      if (session.lastEventSequence !== 0) return session;
      await client.query<EventRow>(
        `INSERT INTO standalone_gateway_events (event_id, session_id, sequence, type, payload, created_at)
         VALUES ($1, $2, 1, 'session.created', $3::jsonb, $4)
         ON CONFLICT (session_id, sequence) DO NOTHING`,
        [randomUUID(), session.sessionId, JSON.stringify(redactRecord({ title: session.title })), now],
      );
      const updated = await client.query<SessionRow>(
        `UPDATE standalone_gateway_sessions
         SET last_event_sequence = 1, updated_at = $2
         WHERE session_id = $1 AND last_event_sequence = 0
         RETURNING *`,
        [session.sessionId, now],
      );
      session = updated.rows[0] ? sessionFromRow(updated.rows[0]) : session;
      return session;
    });
  }

  async updateSessionRuntime(input: { sessionId: string; opencodeSessionId: string | null; status?: StandaloneGatewaySessionRecord["status"]; now?: Date }): Promise<StandaloneGatewaySessionRecord> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE standalone_gateway_sessions
       SET opencode_session_id = COALESCE(standalone_gateway_sessions.opencode_session_id, $2),
           status = COALESCE($3, status),
           updated_at = $4
       WHERE session_id = $1
       RETURNING *`,
      [input.sessionId, input.opencodeSessionId, input.status || null, (input.now || new Date()).toISOString()],
    );
    if (!result.rows[0]) throw new Error(`Unknown standalone gateway session ${input.sessionId}.`);
    return sessionFromRow(result.rows[0]);
  }

  async appendEvent(input: { sessionId: string; type: StandaloneGatewayEventType; payload?: Record<string, unknown>; now?: Date }): Promise<StandaloneGatewayEventRecord> {
    const now = (input.now || new Date()).toISOString();
    return await this.withTransaction(async (client) => {
      const sessionResult = await client.query<SessionRow>(
        "SELECT * FROM standalone_gateway_sessions WHERE session_id = $1 FOR UPDATE",
        [input.sessionId],
      );
      const session = sessionResult.rows[0];
      if (!session) throw new Error(`Unknown standalone gateway session ${input.sessionId}.`);
      const sequence = Number(session.last_event_sequence || 0) + 1;
      const eventResult = await client.query<EventRow>(
        `INSERT INTO standalone_gateway_events (event_id, session_id, sequence, type, payload, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         RETURNING *`,
        [randomUUID(), input.sessionId, sequence, input.type, JSON.stringify(redactRecord(input.payload || {})), now],
      );
      await client.query(
        "UPDATE standalone_gateway_sessions SET last_event_sequence = $2, updated_at = $3 WHERE session_id = $1",
        [input.sessionId, sequence, now],
      );
      return eventFromRow(eventResult.rows[0]!);
    });
  }

  async enqueueJob(input: { kind: StandaloneGatewayJobKind; sessionId?: string | null; payload?: Record<string, unknown>; availableAt?: Date; now?: Date }): Promise<StandaloneGatewayJobRecord> {
    const now = input.now || new Date();
    const result = await this.pool.query<JobRow>(
      `INSERT INTO standalone_gateway_jobs (
         job_id, kind, status, session_id, payload, available_at, created_at, updated_at
       )
       VALUES ($1, $2, 'pending', $3, $4::jsonb, $5, $6, $6)
       RETURNING *`,
      [
        randomUUID(),
        input.kind,
        input.sessionId || null,
        JSON.stringify(redactRecord(input.payload || {})),
        (input.availableAt || now).toISOString(),
        now.toISOString(),
      ],
    );
    return jobFromRow(result.rows[0]!);
  }

  async claimNextJob(input: { claimedBy: string; ttlMs: number; lease?: StandaloneGatewayLeaseRef | null; now?: Date }): Promise<StandaloneGatewayJobRecord | null> {
    const now = input.now || new Date();
    // Lease-aware claim (audit P1-G4): when a daemon lease is supplied, the claim only succeeds if
    // that lease is still active, verified in the SAME statement as the FOR UPDATE SKIP LOCKED claim.
    // A daemon whose lease expired or was taken over therefore cannot claim a job — no split-brain
    // window between losing the lease and the process exiting. ($5 NULL bypasses for non-leased callers.)
    const result = await this.pool.query<JobRow>(
      `WITH candidate AS (
         SELECT job_id
         FROM standalone_gateway_jobs
         WHERE available_at <= $1
           AND (
             status = 'pending'
             OR (status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= $1)
           )
           AND (
             $5::text IS NULL
             OR EXISTS (
               SELECT 1 FROM standalone_gateway_daemon_leases
               WHERE lease_id = $5 AND owner_id = $6 AND lease_token = $7 AND expires_at > $1
             )
           )
         ORDER BY available_at ASC, created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE standalone_gateway_jobs jobs
       SET status = 'claimed',
           claimed_by = $2,
           claim_token = $3,
           claim_expires_at = $4,
           attempt_count = attempt_count + 1,
           updated_at = $1
       FROM candidate
       WHERE jobs.job_id = candidate.job_id
       RETURNING jobs.*`,
      [
        now.toISOString(),
        input.claimedBy,
        randomUUID(),
        new Date(now.getTime() + input.ttlMs).toISOString(),
        input.lease?.leaseId ?? null,
        input.lease?.ownerId ?? null,
        input.lease?.leaseToken ?? null,
      ],
    );
    return result.rows[0] ? jobFromRow(result.rows[0]) : null;
  }

  async finishJob(input: { jobId: string; claimToken: string; status: "completed" | "failed" | "dead"; lastError?: string | null; now?: Date }): Promise<StandaloneGatewayJobRecord> {
    const result = await this.pool.query<JobRow>(
      `UPDATE standalone_gateway_jobs
       SET status = $3,
           claim_expires_at = NULL,
           last_error = $4,
           updated_at = $5
       WHERE job_id = $1 AND claim_token = $2
       RETURNING *`,
      [input.jobId, input.claimToken, input.status, input.lastError ? redactSecretText(input.lastError) : null, (input.now || new Date()).toISOString()],
    );
    if (!result.rows[0]) throw new Error("Cannot finish standalone gateway job with a stale claim token.");
    return jobFromRow(result.rows[0]);
  }

  async findChannelIdentity(input: { provider: string; externalUserId: string; providerWorkspaceId?: string | null }): Promise<StandaloneGatewayChannelIdentityRecord | null> {
    const providerWorkspaceId = normalizeWorkspaceId(input.providerWorkspaceId) || "";
    const result = await this.pool.query<IdentityRow>(
      `SELECT *
       FROM standalone_gateway_channel_identities
       WHERE provider = $1
         AND external_user_id = $2
         AND provider_workspace_id = $3
       LIMIT 1`,
      [input.provider, input.externalUserId, providerWorkspaceId],
    );
    return result.rows[0] ? identityFromRow(result.rows[0]) : null;
  }

  async upsertChannelIdentity(input: {
    identityId?: string;
    provider: string;
    externalUserId: string;
    providerWorkspaceId?: string | null;
    role: StandaloneGatewayIdentityRole;
    status?: StandaloneGatewayIdentityStatus;
    now?: Date;
  }): Promise<StandaloneGatewayChannelIdentityRecord> {
    const now = (input.now || new Date()).toISOString();
    const result = await this.pool.query<IdentityRow>(
      `INSERT INTO standalone_gateway_channel_identities (
         identity_id, provider, provider_workspace_id, external_user_id, role, status, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (provider, provider_workspace_id, external_user_id) DO UPDATE
       SET role = EXCLUDED.role,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        input.identityId || randomUUID(),
        input.provider,
        normalizeWorkspaceId(input.providerWorkspaceId) || "",
        input.externalUserId,
        normalizeIdentityRole(input.role),
        normalizeIdentityStatus(input.status || "active"),
        now,
      ],
    );
    return identityFromRow(result.rows[0]!);
  }

  async identityAuthorizationSummary(input: { providers?: readonly string[] } = {}): Promise<StandaloneGatewayIdentityAuthorizationSummary> {
    const providers = input.providers?.length ? [...new Set(input.providers)] : null;
    // Aggregate in SQL (audit P1-G3): the /ready doctor calls this on every probe, so a
    // SELECT * + materialize-all-rows was an unbounded full-table scan an anonymous caller could
    // hammer. count(*) FILTER mirrors canIdentityPrompt (status='active' AND role IN owner/admin/member).
    const result = await this.pool.query<{ total: string; active: string; prompt_capable: string }>(
      `SELECT
         count(*)::bigint AS total,
         count(*) FILTER (WHERE status = 'active')::bigint AS active,
         count(*) FILTER (WHERE status = 'active' AND role IN ('owner', 'admin', 'member'))::bigint AS prompt_capable
       FROM standalone_gateway_channel_identities
       ${providers ? "WHERE provider = ANY($1::text[])" : ""}`,
      providers ? [providers] : undefined,
    );
    const row = result.rows[0];
    return {
      total: Number(row?.total ?? 0),
      active: Number(row?.active ?? 0),
      promptCapable: Number(row?.prompt_capable ?? 0),
    };
  }

  async listSessions(limit = 50): Promise<StandaloneGatewaySessionRecord[]> {
    const result = await this.pool.query<SessionRow>(
      "SELECT * FROM standalone_gateway_sessions ORDER BY updated_at DESC LIMIT $1",
      [Math.max(1, Math.min(200, limit))],
    );
    return result.rows.map(sessionFromRow);
  }

  async dashboardSnapshot(limit = 50): Promise<StandaloneGatewayDashboardSnapshot> {
    const safeLimit = Math.max(1, Math.min(200, limit));
    const [sessions, identities, jobs, audits] = await Promise.all([
      this.listSessions(safeLimit),
      this.pool.query<IdentityRow>("SELECT * FROM standalone_gateway_channel_identities ORDER BY updated_at DESC LIMIT $1", [safeLimit]),
      this.pool.query<JobRow>("SELECT * FROM standalone_gateway_jobs ORDER BY updated_at DESC LIMIT $1", [safeLimit]),
      this.pool.query<AuditRow>("SELECT * FROM standalone_gateway_audit_events ORDER BY created_at DESC LIMIT $1", [safeLimit]),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      sessions,
      identities: identities.rows.map(identityFromRow),
      jobs: jobs.rows.map(jobFromRow),
      audits: audits.rows.map(auditFromRow),
    };
  }

  async recordAudit(action: string, actor: string, metadata: Record<string, unknown> = {}, now = new Date()): Promise<StandaloneGatewayAuditRecord> {
    const result = await this.pool.query<AuditRow>(
      `INSERT INTO standalone_gateway_audit_events (audit_id, action, actor, metadata, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING *`,
      [randomUUID(), action, actor, JSON.stringify(redactRecord(metadata)), now.toISOString()],
    );
    return auditFromRow(result.rows[0]!);
  }

  async pruneRetention(input: {
    retention: { sessionDays: number; artifactDays: number; auditDays: number; jobDays: number };
    leaseId: string;
    ownerId: string;
    leaseToken: string;
    now?: Date;
  }): Promise<StandaloneGatewayRetentionResult | null> {
    const now = input.now || new Date();
    const cutoffs = standaloneRetentionCutoffs(input.retention, now);
    return this.withTransaction(async (client) => {
      const lease = await client.query(
        `SELECT lease_id
         FROM standalone_gateway_daemon_leases
         WHERE lease_id = $1
           AND owner_id = $2
           AND lease_token = $3
           AND expires_at > $4
         FOR UPDATE`,
        [input.leaseId, input.ownerId, input.leaseToken, now.toISOString()],
      );
      if (lease.rows.length === 0) {
        return null;
      }
      const artifacts = await client.query(
        "DELETE FROM standalone_gateway_artifacts WHERE created_at < $1",
        [cutoffs.artifactCutoff.toISOString()],
      );
      const sessions = await client.query(
        `DELETE FROM standalone_gateway_sessions sessions
         WHERE sessions.updated_at < $1
           AND sessions.status IN ('idle', 'failed', 'completed')
           AND NOT EXISTS (
             SELECT 1
             FROM standalone_gateway_jobs jobs
             WHERE jobs.session_id = sessions.session_id
               AND jobs.status IN ('pending', 'claimed', 'running')
           )
           AND NOT EXISTS (
             SELECT 1
             FROM standalone_gateway_artifacts artifacts
             WHERE artifacts.session_id = sessions.session_id
               AND artifacts.created_at >= $2
           )`,
        [cutoffs.sessionCutoff.toISOString(), cutoffs.artifactCutoff.toISOString()],
      );
      const jobs = await client.query(
        "DELETE FROM standalone_gateway_jobs WHERE updated_at < $1 AND status IN ('completed', 'failed', 'dead')",
        [cutoffs.jobCutoff.toISOString()],
      );
      const auditEvents = await client.query(
        "DELETE FROM standalone_gateway_audit_events WHERE created_at < $1",
        [cutoffs.auditCutoff.toISOString()],
      );
      const result = retentionResult(now, cutoffs, {
        sessionsDeleted: sessions.rowCount || 0,
        artifactsDeleted: artifacts.rowCount || 0,
        auditEventsDeleted: auditEvents.rowCount || 0,
        jobsDeleted: jobs.rowCount || 0,
      });
      await client.query(
        `INSERT INTO standalone_gateway_audit_events (audit_id, action, actor, metadata, created_at)
         VALUES ($1, 'standalone.retention.pruned', $2, $3::jsonb, $4)`,
        [randomUUID(), input.ownerId, JSON.stringify(retentionAuditMetadata(result)), now.toISOString()],
      );
      return result;
    });
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }

  private async getSession(sessionId: string): Promise<StandaloneGatewaySessionRecord | null> {
    const result = await this.pool.query<SessionRow>(
      "SELECT * FROM standalone_gateway_sessions WHERE session_id = $1",
      [sessionId],
    );
    return result.rows[0] ? sessionFromRow(result.rows[0]) : null;
  }

  private async withTransaction<T>(run: (client: PgLikeClient) => Promise<T>): Promise<T> {
    const client = this.pool.connect ? await this.pool.connect() : this.pool;
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release?.();
    }
  }
}

export async function assertStandaloneGatewaySchemaIntegrity(executor: PgLikeClient): Promise<void> {
  const tables = await currentStandaloneGatewayTables(executor);
  if (!tables.has(STANDALONE_GATEWAY_SCHEMA_MIGRATIONS_TABLE)) {
    throw new Error(
      "Standalone Gateway schema integrity failed: standalone_gateway_schema_migrations is missing. Recreate an empty Standalone Gateway schema or restore a complete database backup.",
    );
  }
  const applied = new Set((await executor.query<{ id: string }>(
    "SELECT id FROM standalone_gateway_schema_migrations",
  )).rows.map((row) => String(row.id)));
  if (!applied.has(STANDALONE_GATEWAY_BASELINE_MIGRATION_ID)) {
    throw new Error(
      `Standalone Gateway schema integrity failed: missing migration ledger entry ${STANDALONE_GATEWAY_BASELINE_MIGRATION_ID}.`,
    );
  }
  const missing = STANDALONE_GATEWAY_REQUIRED_TABLE_NAMES.filter((tableName) => !tables.has(tableName));
  if (missing.length === 0) return;
  throw new Error(
    `Standalone Gateway schema integrity failed: required production tables are missing (${summarizeSchemaNames(missing)}). `
    + "The clean pre-release baseline does not repair or adopt drifted schemas. Recreate an empty Standalone Gateway schema or restore a complete database backup.",
  );
}

async function currentStandaloneGatewayTables(executor: PgLikeClient): Promise<Set<string>> {
  const result = await executor.query<{ table_name: string }>(
    `SELECT tablename AS table_name
     FROM pg_catalog.pg_tables
     WHERE schemaname = current_schema()
       AND (
         tablename = ANY($1::text[])
         OR tablename LIKE 'standalone\\_gateway\\_%' ESCAPE '\\'
       )`,
    [[STANDALONE_GATEWAY_SCHEMA_MIGRATIONS_TABLE, ...STANDALONE_GATEWAY_REQUIRED_TABLE_NAMES]],
  );
  return new Set(result.rows.map((row) => String(row.table_name)));
}

function summarizeSchemaNames(names: readonly string[]): string {
  const shown = names.slice(0, 8);
  return names.length > shown.length
    ? `${shown.join(", ")}, and ${names.length - shown.length} more`
    : shown.join(", ");
}

type LeaseRow = {
  lease_id: string;
  owner_id: string;
  lease_token: string;
  expires_at: string | Date;
  updated_at: string | Date;
};

type SessionRow = {
  session_id: string;
  opencode_session_id: string | null;
  title: string;
  status: StandaloneGatewaySessionRecord["status"];
  provider: StandaloneGatewaySessionRecord["provider"];
  provider_kind: StandaloneGatewaySessionRecord["providerKind"];
  provider_workspace_id?: string | null;
  channel_binding_id: string;
  external_user_id: string;
  external_chat_id: string;
  external_thread_id: string;
  last_event_sequence: string | number;
  created_at: string | Date;
  updated_at: string | Date;
};

type EventRow = {
  event_id: string;
  session_id: string;
  sequence: string | number;
  type: StandaloneGatewayEventType;
  payload: Record<string, unknown> | string;
  created_at: string | Date;
};

type JobRow = {
  job_id: string;
  kind: StandaloneGatewayJobKind;
  status: StandaloneGatewayJobRecord["status"];
  session_id: string | null;
  payload: Record<string, unknown> | string;
  claimed_by: string | null;
  claim_token: string | null;
  claim_expires_at: string | Date | null;
  attempt_count: string | number;
  available_at: string | Date;
  last_error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type IdentityRow = {
  identity_id: string;
  provider: StandaloneGatewayChannelIdentityRecord["provider"];
  provider_workspace_id?: string | null;
  external_user_id: string;
  role: StandaloneGatewayIdentityRole;
  status?: StandaloneGatewayIdentityStatus;
  created_at: string | Date;
  updated_at: string | Date;
};

type AuditRow = {
  audit_id: string;
  action: string;
  actor: string;
  metadata: Record<string, unknown> | string;
  created_at: string | Date;
};

function leaseFromRow(row: LeaseRow): StandaloneGatewayDaemonLease {
  return {
    leaseId: row.lease_id,
    ownerId: row.owner_id,
    leaseToken: row.lease_token,
    expiresAt: iso(row.expires_at),
    updatedAt: iso(row.updated_at),
  };
}

function sessionFromRow(row: SessionRow): StandaloneGatewaySessionRecord {
  return {
    sessionId: row.session_id,
    opencodeSessionId: row.opencode_session_id,
    title: row.title,
    status: row.status,
    provider: row.provider,
    providerKind: row.provider_kind,
    providerWorkspaceId: normalizeWorkspaceId(row.provider_workspace_id),
    channelBindingId: row.channel_binding_id,
    externalUserId: row.external_user_id,
    externalChatId: row.external_chat_id,
    externalThreadId: row.external_thread_id,
    lastEventSequence: Number(row.last_event_sequence),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function eventFromRow(row: EventRow): StandaloneGatewayEventRecord {
  return {
    eventId: row.event_id,
    sessionId: row.session_id,
    sequence: Number(row.sequence),
    type: row.type,
    payload: jsonRecord(row.payload),
    createdAt: iso(row.created_at),
  };
}

function jobFromRow(row: JobRow): StandaloneGatewayJobRecord {
  return {
    jobId: row.job_id,
    kind: row.kind,
    status: row.status,
    sessionId: row.session_id,
    payload: jsonRecord(row.payload),
    claimedBy: row.claimed_by,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at ? iso(row.claim_expires_at) : null,
    attemptCount: Number(row.attempt_count),
    availableAt: iso(row.available_at),
    lastError: row.last_error,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function identityFromRow(row: IdentityRow): StandaloneGatewayChannelIdentityRecord {
  return {
    identityId: row.identity_id,
    provider: row.provider,
    externalUserId: row.external_user_id,
    providerWorkspaceId: normalizeWorkspaceId(row.provider_workspace_id),
    role: normalizeIdentityRole(row.role),
    status: normalizeIdentityStatus(row.status || "active"),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function auditFromRow(row: AuditRow): StandaloneGatewayAuditRecord {
  return {
    auditId: row.audit_id,
    action: row.action,
    actor: row.actor,
    metadata: jsonRecord(row.metadata),
    createdAt: iso(row.created_at),
  };
}

function jsonRecord(value: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      // A corrupt JSON column must not throw out of the row mapper (audit P3-10) — the cloud-server
      // readers already tolerate this. Treat unparseable metadata as empty.
      return {};
    }
  }
  return value || {};
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
