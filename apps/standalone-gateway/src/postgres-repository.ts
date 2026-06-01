import { randomUUID } from "node:crypto";

import { standaloneGatewayMigrations } from "./schema.js";
import { redactRecord } from "./repository.js";
import type { StandaloneGatewayRepository } from "./repository.js";
import type {
  StandaloneGatewayAuditRecord,
  StandaloneGatewayDaemonLease,
  StandaloneGatewayDashboardSnapshot,
  StandaloneGatewayEventRecord,
  StandaloneGatewayEventType,
  StandaloneGatewayJobKind,
  StandaloneGatewayJobRecord,
  StandaloneGatewaySessionRecord,
  StandalonePromptInput,
} from "./types.js";

export interface PgLikeClient {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  release?(): void;
}

export interface PgLikePool extends PgLikeClient {
  connect?(): Promise<PgLikeClient>;
  end?(): Promise<void>;
}

export async function createStandaloneGatewayPostgresRepository(databaseUrl: string): Promise<StandaloneGatewayRepository> {
  const pg = await import("pg") as { Pool: new (options: { connectionString: string }) => PgLikePool };
  return new PostgresStandaloneGatewayRepository(new pg.Pool({ connectionString: databaseUrl }));
}

export class PostgresStandaloneGatewayRepository implements StandaloneGatewayRepository {
  constructor(private readonly pool: PgLikePool) {}

  async migrate(): Promise<void> {
    for (const migration of standaloneGatewayMigrations) {
      await this.withTransaction(async (client) => {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO standalone_gateway_schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
          [migration.id],
        );
      });
    }
  }

  async readiness(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.pool.query("SELECT 1");
      return { ok: true, detail: "postgres ready" };
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
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO standalone_gateway_sessions (
         session_id, title, status, provider, provider_kind, channel_binding_id,
         external_user_id, external_chat_id, external_thread_id, created_at, updated_at
       )
       VALUES ($1, $2, 'idle', $3, $4, $5, $6, $7, $8, $9, $9)
       ON CONFLICT (provider, external_chat_id, external_thread_id) DO UPDATE
       SET updated_at = standalone_gateway_sessions.updated_at
       RETURNING *`,
      [
        randomUUID(),
        input.title || input.text.slice(0, 80) || "Standalone Gateway session",
        input.provider,
        input.providerKind,
        input.channelBindingId,
        input.externalUserId,
        input.target.chatId,
        externalThreadId,
        now,
      ],
    );
    const session = sessionFromRow(result.rows[0]!);
    if (session.lastEventSequence === 0) {
      await this.appendEvent({ sessionId: session.sessionId, type: "session.created", payload: { title: session.title }, now: input.now });
      return await this.getSession(session.sessionId) || session;
    }
    return session;
  }

  async updateSessionRuntime(input: { sessionId: string; opencodeSessionId: string | null; status?: StandaloneGatewaySessionRecord["status"]; now?: Date }): Promise<StandaloneGatewaySessionRecord> {
    const result = await this.pool.query<SessionRow>(
      `UPDATE standalone_gateway_sessions
       SET opencode_session_id = $2,
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

  async claimNextJob(input: { claimedBy: string; ttlMs: number; now?: Date }): Promise<StandaloneGatewayJobRecord | null> {
    const now = input.now || new Date();
    const result = await this.pool.query<JobRow>(
      `WITH candidate AS (
         SELECT job_id
         FROM standalone_gateway_jobs
         WHERE available_at <= $1
           AND (
             status = 'pending'
             OR (status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= $1)
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
      [now.toISOString(), input.claimedBy, randomUUID(), new Date(now.getTime() + input.ttlMs).toISOString()],
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
      [input.jobId, input.claimToken, input.status, input.lastError || null, (input.now || new Date()).toISOString()],
    );
    if (!result.rows[0]) throw new Error("Cannot finish standalone gateway job with a stale claim token.");
    return jobFromRow(result.rows[0]);
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
    const [sessions, jobs, audits] = await Promise.all([
      this.listSessions(safeLimit),
      this.pool.query<JobRow>("SELECT * FROM standalone_gateway_jobs ORDER BY updated_at DESC LIMIT $1", [safeLimit]),
      this.pool.query<AuditRow>("SELECT * FROM standalone_gateway_audit_events ORDER BY created_at DESC LIMIT $1", [safeLimit]),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      sessions,
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
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  }
  return value || {};
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
