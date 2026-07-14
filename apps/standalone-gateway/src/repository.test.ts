import test from "node:test";
import assert from "node:assert/strict";

import * as standaloneGateway from "../dist/index.js";
import {
  createStandaloneGatewayPostgresRepository,
  PostgresStandaloneGatewayRepository,
  standalonePostgresPoolOptions,
} from "../dist/postgres-repository.js";
import { InMemoryStandaloneGatewayRepository } from "../dist/repository.js";
import { describeStandaloneRetention, runStandaloneGatewayRetention } from "../dist/retention.js";
import {
  STANDALONE_GATEWAY_BASELINE_MIGRATION_ID,
  STANDALONE_GATEWAY_REQUIRED_TABLE_NAMES,
  standaloneGatewayMigrations,
} from "../dist/schema.js";

function fakeProviderKey(...parts: string[]) {
  return parts.join("-");
}

test("standalone repository persists sessions, events, jobs, leases, and redacted audit state", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  const providerKey = fakeProviderKey("sk", "proj", "verysecretvalue");
  const routerKey = fakeProviderKey("sk", "or", "secretvalue");
  const jsonProviderKey = fakeProviderKey("sk", "proj", "jsonsecret");
  const lease = await repository.acquireDaemonLease({ leaseId: "daemon", ownerId: "node-1", ttlMs: 30_000 });
  assert.ok(lease?.leaseToken);
  assert.equal(await repository.acquireDaemonLease({ leaseId: "daemon", ownerId: "node-2", ttlMs: 30_000 }), null);
  const identity = await repository.upsertChannelIdentity({
    provider: "webhook-ci",
    externalUserId: "user-1",
    role: "member",
  });
  assert.equal(identity.status, "active");
  assert.equal((await repository.findChannelIdentity({
    provider: "webhook-ci",
    externalUserId: "user-1",
  }))?.identityId, identity.identityId);
  assert.equal(await repository.findChannelIdentity({
    provider: "webhook-ci",
    externalUserId: "user-1",
    providerWorkspaceId: "workspace-1",
  }), null);
  await repository.upsertChannelIdentity({
    provider: "webhook-ci",
    externalUserId: "user-1",
    providerWorkspaceId: "workspace-1",
    role: "viewer",
    status: "disabled",
  });
  await repository.upsertChannelIdentity({
    provider: "webhook-other",
    externalUserId: "user-1",
    role: "admin",
  });
  assert.equal((await repository.findChannelIdentity({
    provider: "webhook-ci",
    externalUserId: "user-1",
    providerWorkspaceId: "workspace-1",
  }))?.role, "viewer");
  assert.deepEqual(await repository.identityAuthorizationSummary({ providers: ["webhook-ci"] }), {
    total: 2,
    active: 1,
    promptCapable: 1,
  });

  const session = await repository.findOrCreateSession({
    provider: "webhook-ci",
    providerKind: "webhook",
    channelBindingId: "webhook",
    target: { provider: "webhook-ci", providerKind: "webhook", chatId: "chat-1", threadId: "thread-1" },
    externalUserId: "user-1",
    text: "hello",
  });
  const sameSession = await repository.findOrCreateSession({
    provider: "webhook-ci",
    providerKind: "webhook",
    channelBindingId: "webhook",
    target: { provider: "webhook-ci", providerKind: "webhook", chatId: "chat-1", threadId: "thread-1" },
    externalUserId: "user-1",
    text: "hello again",
  });
  assert.equal(sameSession.sessionId, session.sessionId);
  assert.equal(sameSession.lastEventSequence, 1);
  const firstBinding = await repository.updateSessionRuntime({ sessionId: session.sessionId, opencodeSessionId: "oc-1", status: "running" });
  const secondBinding = await repository.updateSessionRuntime({ sessionId: session.sessionId, opencodeSessionId: "oc-2", status: "idle" });
  assert.equal(firstBinding.opencodeSessionId, "oc-1");
  assert.equal(secondBinding.opencodeSessionId, "oc-1");
  await repository.appendEvent({ sessionId: session.sessionId, type: "user.message", payload: { text: "hello", token: "secret-token" } });
  const job = await repository.enqueueJob({ kind: "prompt", sessionId: session.sessionId, payload: { token: "secret-token" } });
  const claimed = await repository.claimNextJob({ claimedBy: "worker-1", ttlMs: 30_000 });
  assert.equal(claimed?.jobId, job.jobId);
  await repository.finishJob({ jobId: job.jobId, claimToken: claimed!.claimToken!, status: "completed" });
  const failedJob = await repository.enqueueJob({ kind: "prompt", sessionId: session.sessionId, payload: { note: "provider failure" } });
  const failedClaim = await repository.claimNextJob({ claimedBy: "worker-1", ttlMs: 30_000 });
  assert.equal(failedClaim?.jobId, failedJob.jobId);
  await repository.finishJob({
    jobId: failedJob.jobId,
    claimToken: failedClaim!.claimToken!,
    status: "failed",
    lastError: `Incorrect API key provided: ${providerKey} api_key:"${routerKey}" {"password":"hunter2","apiKey":"${jsonProviderKey}"} upstream failed with Bearer bare-secret-token and Basic dXNlcjpzZWNyZXQ= postgres://gateway:super-secret-password@127.0.0.1/db`,
  });
  await repository.recordAudit("test.audit", "user-1", { token: "secret-token", note: "ok" });

  const snapshot = await repository.dashboardSnapshot();
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.identities.length, 3);
  assert.equal(snapshot.jobs.find((entry) => entry.jobId === job.jobId)?.status, "completed");
  const persistedFailure = snapshot.jobs.find((entry) => entry.jobId === failedJob.jobId)?.lastError || "";
  assert.equal(persistedFailure.includes(providerKey), false);
  assert.equal(persistedFailure.includes(routerKey), false);
  assert.equal(persistedFailure.includes("hunter2"), false);
  assert.equal(persistedFailure.includes(jsonProviderKey), false);
  assert.equal(persistedFailure.includes("bare-secret-token"), false);
  assert.equal(persistedFailure.includes("dXNlcjpzZWNyZXQ="), false);
  assert.equal(persistedFailure.includes("super-secret-password"), false);
  assert.match(persistedFailure, /\[redacted\]/);
  assert.equal(snapshot.audits[0]?.metadata.token, "[redacted]");
});

test("standalone package barrel exposes retention and repository adapters", () => {
  assert.deepEqual(describeStandaloneRetention({
    retention: { sessionDays: 30, artifactDays: 7, auditDays: 90, jobDays: 14 },
  } as never), ["sessions:30d", "artifacts:7d", "audit:90d", "jobs:14d"]);
  assert.equal(standaloneGateway.describeStandaloneRetention, describeStandaloneRetention);
  assert.equal(typeof standaloneGateway.createStandaloneGatewayPostgresRepository, "function");
});

test("postgres repository factory builds explicit TLS pool options without a live database", async () => {
  let capturedOptions: unknown;
  let closed = false;
  const repository = await createStandaloneGatewayPostgresRepository({
    url: "postgres://gateway:gateway@db.example.test:5432/gateway",
    ssl: true,
    sslRejectUnauthorized: true,
    sslCaPath: "/certs/ca.pem",
    sslCertPath: "/certs/client-cert.pem",
    sslKeyPath: "/certs/client-key.pem",
  }, {
    readFile: (path) => `file:${path}`,
    createPool: (options) => {
      capturedOptions = options;
      return {
        async query() {
          return { rows: [], rowCount: 0 };
        },
        async end() {
          closed = true;
        },
      };
    },
  });

  assert.deepEqual(capturedOptions, {
    connectionString: "postgres://gateway:gateway@db.example.test:5432/gateway",
    ssl: {
      rejectUnauthorized: true,
      ca: "file:/certs/ca.pem",
      cert: "file:/certs/client-cert.pem",
      key: "file:/certs/client-key.pem",
    },
  });
  assert.deepEqual(standalonePostgresPoolOptions("postgres://local"), {
    connectionString: "postgres://local",
  });
  assert.deepEqual(standalonePostgresPoolOptions({
    url: "postgres://gateway:gateway@db.example.test:5432/gateway?sslmode=require&application_name=open-cowork",
    ssl: false,
    sslRejectUnauthorized: true,
    sslCaPath: null,
    sslCertPath: null,
    sslKeyPath: null,
  }), {
    connectionString: "postgres://gateway:gateway@db.example.test:5432/gateway?sslmode=require&application_name=open-cowork",
  });
  assert.deepEqual(standalonePostgresPoolOptions({
    url: "postgres://gateway:gateway@db.example.test:5432/gateway?application_name=open-cowork&sslmode=disable&ssl=0&sslrootcert=/tmp/ca.pem",
    ssl: true,
    sslRejectUnauthorized: true,
    sslCaPath: null,
    sslCertPath: null,
    sslKeyPath: null,
  }), {
    connectionString: "postgres://gateway:gateway@db.example.test:5432/gateway?application_name=open-cowork",
    ssl: {
      rejectUnauthorized: true,
    },
  });
  await repository.close?.();
  assert.equal(closed, true);
});

test("standalone retention is lease-gated and preserves active sessions and jobs", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  const now = new Date("2026-06-05T00:00:00.000Z");
  const old = new Date("2026-02-01T00:00:00.000Z");
  const recent = new Date("2026-06-01T00:00:00.000Z");
  const lease = await repository.acquireDaemonLease({ leaseId: "daemon", ownerId: "node-1", ttlMs: 30_000, now });
  assert.ok(lease);
  const expiredSession = await repository.findOrCreateSession({
    provider: "webhook-ci",
    providerKind: "webhook",
    channelBindingId: "webhook",
    target: { provider: "webhook-ci", providerKind: "webhook", chatId: "chat-expired", threadId: "thread-expired" },
    externalUserId: "user-1",
    text: "expired session",
    now: old,
  });
  await repository.updateSessionRuntime({ sessionId: expiredSession.sessionId, opencodeSessionId: "oc-expired", status: "completed", now: old });
  const expiredJob = await repository.enqueueJob({ kind: "prompt", sessionId: expiredSession.sessionId, payload: { text: "expired" }, now: old });
  const expiredClaim = await repository.claimNextJob({ claimedBy: "node-1", ttlMs: 30_000, now: old });
  assert.equal(expiredClaim?.jobId, expiredJob.jobId);
  await repository.finishJob({ jobId: expiredJob.jobId, claimToken: expiredClaim!.claimToken!, status: "completed", now: old });

  const activeSession = await repository.findOrCreateSession({
    provider: "webhook-ci",
    providerKind: "webhook",
    channelBindingId: "webhook",
    target: { provider: "webhook-ci", providerKind: "webhook", chatId: "chat-active", threadId: "thread-active" },
    externalUserId: "user-1",
    text: "active session",
    now: old,
  });
  await repository.enqueueJob({ kind: "prompt", sessionId: activeSession.sessionId, payload: { text: "still pending" }, now: old });
  const reopenedSession = await repository.findOrCreateSession({
    provider: "webhook-ci",
    providerKind: "webhook",
    channelBindingId: "webhook",
    target: { provider: "webhook-ci", providerKind: "webhook", chatId: "chat-reopened", threadId: "thread-reopened" },
    externalUserId: "user-1",
    text: "old reopened session",
    now: old,
  });
  const touchedSession = await repository.findOrCreateSession({
    provider: "webhook-ci",
    providerKind: "webhook",
    channelBindingId: "webhook",
    target: { provider: "webhook-ci", providerKind: "webhook", chatId: "chat-reopened", threadId: "thread-reopened" },
    externalUserId: "user-1",
    text: "touch reopened session",
    now: recent,
  });
  assert.equal(touchedSession.sessionId, reopenedSession.sessionId);
  assert.equal(touchedSession.updatedAt, recent.toISOString());
  const runningSession = await repository.findOrCreateSession({
    provider: "webhook-ci",
    providerKind: "webhook",
    channelBindingId: "webhook",
    target: { provider: "webhook-ci", providerKind: "webhook", chatId: "chat-running", threadId: "thread-running" },
    externalUserId: "user-1",
    text: "running session",
    now: old,
  });
  await repository.updateSessionRuntime({ sessionId: runningSession.sessionId, opencodeSessionId: "oc-running", status: "running", now: old });
  const recentSession = await repository.findOrCreateSession({
    provider: "webhook-ci",
    providerKind: "webhook",
    channelBindingId: "webhook",
    target: { provider: "webhook-ci", providerKind: "webhook", chatId: "chat-recent", threadId: "thread-recent" },
    externalUserId: "user-1",
    text: "recent session",
    now: recent,
  });
  await repository.recordAudit("old.audit", "user-1", { token: "secret-token" }, old);
  await repository.recordAudit("recent.audit", "user-1", { note: "keep" }, recent);

  const config = {
    retention: { sessionDays: 30, artifactDays: 30, auditDays: 30, jobDays: 30 },
  } as never;
  assert.equal(await runStandaloneGatewayRetention({
    repository,
    config,
    lease: { leaseId: "daemon", ownerId: "node-1", leaseToken: "wrong-token" },
    now,
  }), null);

  const result = await runStandaloneGatewayRetention({
    repository,
    config,
    lease: { leaseId: "daemon", ownerId: "node-1", leaseToken: lease.leaseToken },
    now,
  });
  assert.equal(result?.sessionsDeleted, 1);
  assert.equal(result?.jobsDeleted, 1);
  assert.equal(result?.auditEventsDeleted, 1);
  const snapshot = await repository.dashboardSnapshot(20);
  assert.equal(snapshot.sessions.some((session) => session.sessionId === expiredSession.sessionId), false);
  assert.equal(snapshot.sessions.some((session) => session.sessionId === activeSession.sessionId), true);
  assert.equal(snapshot.sessions.some((session) => session.sessionId === reopenedSession.sessionId), true);
  assert.equal(snapshot.sessions.some((session) => session.sessionId === runningSession.sessionId), true);
  assert.equal(snapshot.sessions.some((session) => session.sessionId === recentSession.sessionId), true);
  assert.equal(snapshot.jobs.some((job) => job.jobId === expiredJob.jobId), false);
  assert.equal(snapshot.audits.some((audit) => audit.action === "old.audit"), false);
  assert.equal(snapshot.audits.some((audit) => audit.action === "recent.audit"), true);
  const retentionAudit = snapshot.audits.find((audit) => audit.action === "standalone.retention.pruned");
  assert.equal(retentionAudit?.metadata.sessionsDeleted, 1);
  assert.equal(retentionAudit?.metadata.jobsDeleted, 1);
});

test("postgres repository adapter maps readiness and daemon lease rows without a live database", async () => {
  const now = new Date("2026-06-05T00:00:00.000Z");
  const routerKey = fakeProviderKey("sk", "or", "secretvalue");
  const jsonProviderKey = fakeProviderKey("sk", "proj", "jsonsecret");
  const queries: string[] = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push(sql);
      if (sql === "SELECT 1") return { rows: [] };
      if (sql.includes("FROM pg_catalog.pg_tables")) {
        return {
          rows: ["standalone_gateway_schema_migrations", ...STANDALONE_GATEWAY_REQUIRED_TABLE_NAMES]
            .map((table_name) => ({ table_name })),
        };
      }
      if (sql.includes("SELECT id FROM standalone_gateway_schema_migrations")) {
        return { rows: [{ id: STANDALONE_GATEWAY_BASELINE_MIGRATION_ID }] };
      }
      if (sql.includes("INSERT INTO standalone_gateway_daemon_leases")) {
        return {
          rows: [{
            lease_id: params?.[0],
            owner_id: params?.[1],
            lease_token: "lease-token",
            expires_at: "2026-06-05T00:00:30.000Z",
            updated_at: now,
          }],
        };
      }
      if (sql.includes("INSERT INTO standalone_gateway_channel_identities")) {
        return {
          rows: [{
            identity_id: params?.[0],
            provider: params?.[1],
            provider_workspace_id: params?.[2],
            external_user_id: params?.[3],
            role: params?.[4],
            status: params?.[5],
            created_at: now,
            updated_at: now,
          }],
        };
      }
      if (sql.includes("FROM standalone_gateway_sessions ORDER BY updated_at DESC")) {
        return {
          rows: [{
            session_id: "session-1",
            opencode_session_id: "oc-1",
            title: "Session",
            status: "idle",
            provider: "webhook-ci",
            provider_kind: "webhook",
            provider_workspace_id: "workspace-1",
            channel_binding_id: "webhook",
            external_user_id: "user-1",
            external_chat_id: "chat-1",
            external_thread_id: "thread-1",
            last_event_sequence: 0,
            created_at: now,
            updated_at: now,
          }],
        };
      }
      if (sql.includes("FROM standalone_gateway_channel_identities ORDER BY updated_at DESC")) {
        return {
          rows: [{
            identity_id: "identity-1",
            provider: "webhook-ci",
            provider_workspace_id: "workspace-1",
            external_user_id: "user-1",
            role: "member",
            status: "active",
            created_at: now,
            updated_at: now,
          }],
        };
      }
      if (sql.includes("FROM standalone_gateway_jobs ORDER BY updated_at DESC")) {
        return {
          rows: [{
            job_id: "job-1",
            kind: "prompt",
            status: "completed",
            session_id: "session-1",
            payload: {},
            claimed_by: null,
            claim_token: null,
            claim_expires_at: null,
            attempt_count: 1,
            available_at: now,
            last_error: null,
            created_at: now,
            updated_at: now,
          }],
        };
      }
      if (sql.includes("FROM standalone_gateway_audit_events ORDER BY created_at DESC")) {
        return {
          rows: [{
            audit_id: "audit-1",
            action: "test.audit",
            actor: "user-1",
            metadata: {},
            created_at: now,
          }],
        };
      }
      if (sql.includes("FROM standalone_gateway_channel_identities")) {
        return {
          rows: [{
            identity_id: "identity-1",
            provider: params?.[0] || "webhook-ci",
            provider_workspace_id: params?.[2] || "",
            external_user_id: params?.[1] || "user-1",
            role: "member",
            status: "active",
            created_at: now,
            updated_at: now,
          }],
        };
      }
      if (sql.includes("UPDATE standalone_gateway_jobs")) {
        return {
          rows: [{
            job_id: params?.[0],
            kind: "prompt",
            status: params?.[2],
            session_id: "session-1",
            payload: {},
            claimed_by: "worker-1",
            claim_token: params?.[1],
            claim_expires_at: null,
            attempt_count: 1,
            available_at: now,
            last_error: params?.[3],
            created_at: now,
            updated_at: now,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("DELETE FROM standalone_gateway_daemon_leases")) return { rowCount: 1, rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const repository = new PostgresStandaloneGatewayRepository(pool as never);

  assert.deepEqual(await repository.readiness(), {
    ok: true,
    detail: "postgres ready; migration ledger and production tables verified",
  });
  const lease = await repository.acquireDaemonLease({ leaseId: "daemon", ownerId: "node-1", ttlMs: 30_000, now });
  assert.deepEqual(lease, {
    leaseId: "daemon",
    ownerId: "node-1",
    leaseToken: "lease-token",
    expiresAt: "2026-06-05T00:00:30.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
  });
  assert.equal(await repository.releaseDaemonLease({ leaseId: "daemon", ownerId: "node-1", leaseToken: "lease-token" }), true);
  const identity = await repository.upsertChannelIdentity({
    provider: "webhook-ci",
    externalUserId: "user-1",
    providerWorkspaceId: "workspace-1",
    role: "admin",
  });
  assert.equal(identity.providerWorkspaceId, "workspace-1");
  assert.equal((await repository.findChannelIdentity({
    provider: "webhook-ci",
    externalUserId: "user-1",
    providerWorkspaceId: "workspace-1",
  }))?.role, "member");
  const failedJob = await repository.finishJob({
    jobId: "job-1",
    claimToken: "claim-token",
    status: "failed",
    lastError: `OpenCode failed with Bearer bare-secret-token {"password":"hunter2","apiKey":"${jsonProviderKey}"} api_key:"${routerKey}"`,
    now,
  });
  assert.equal(failedJob.lastError?.includes("bare-secret-token"), false);
  assert.equal(failedJob.lastError?.includes(routerKey), false);
  assert.equal(failedJob.lastError?.includes("hunter2"), false);
  assert.equal(failedJob.lastError?.includes(jsonProviderKey), false);
  assert.match(failedJob.lastError || "", /\[redacted\]/);
  const snapshot = await repository.dashboardSnapshot();
  assert.equal(snapshot.identities[0]?.identityId, "identity-1");
  assert.ok(queries.some((query) => query.includes("RETURNING *")));
});

test("postgres repository retention is transactional and protected by the daemon lease", async () => {
  const now = new Date("2026-06-05T00:00:00.000Z");
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  let released = false;
  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT lease_id")) return { rows: [{ lease_id: "daemon" }], rowCount: 1 };
      if (sql.includes("DELETE FROM standalone_gateway_artifacts")) return { rows: [], rowCount: 2 };
      if (sql.includes("DELETE FROM standalone_gateway_sessions")) return { rows: [], rowCount: 3 };
      if (sql.includes("DELETE FROM standalone_gateway_jobs")) return { rows: [], rowCount: 4 };
      if (sql.includes("DELETE FROM standalone_gateway_audit_events")) return { rows: [], rowCount: 5 };
      if (sql.includes("INSERT INTO standalone_gateway_audit_events")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected retention query: ${sql}`);
    },
    release() {
      released = true;
    },
  };
  const repository = new PostgresStandaloneGatewayRepository({
    async connect() {
      return client;
    },
    async query() {
      throw new Error("retention should use an explicit transaction client");
    },
  } as never);

  const result = await repository.pruneRetention({
    retention: { sessionDays: 30, artifactDays: 7, auditDays: 90, jobDays: 14 },
    leaseId: "daemon",
    ownerId: "node-1",
    leaseToken: "lease-token",
    now,
  });

  assert.equal(result?.sessionsDeleted, 3);
  assert.equal(result?.artifactsDeleted, 2);
  assert.equal(result?.auditEventsDeleted, 5);
  assert.equal(result?.jobsDeleted, 4);
  assert.equal(queries[0]?.sql, "BEGIN");
  assert.equal(queries.at(-1)?.sql, "COMMIT");
  assert.equal(released, true);
  const retentionSql = queries.map((query) => query.sql).join("\n");
  assert.match(retentionSql, /FOR UPDATE/);
  assert.match(retentionSql, /NOT EXISTS/);
  assert.match(retentionSql, /jobs.status IN \('pending', 'claimed', 'running'\)/);
  assert.match(retentionSql, /FROM standalone_gateway_artifacts artifacts/);
  assert.match(retentionSql, /artifacts.created_at >= \$2/);
  assert.match(retentionSql, /status IN \('completed', 'failed', 'dead'\)/);
});

test("postgres repository touches existing sessions before appending new message events", async () => {
  const now = new Date("2026-06-01T00:00:00.000Z");
  const queries: string[] = [];
  const repository = new PostgresStandaloneGatewayRepository({
    async query(sql: string, params?: unknown[]) {
      queries.push(sql);
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO standalone_gateway_sessions")) {
        return {
          rows: [{
            session_id: "session-existing",
            opencode_session_id: "oc-existing",
            title: "Existing",
            status: "idle",
            provider: "webhook-ci",
            provider_kind: "webhook",
            provider_workspace_id: "",
            channel_binding_id: "webhook",
            external_user_id: "user-1",
            external_chat_id: "chat-1",
            external_thread_id: "thread-1",
            last_event_sequence: 7,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: params?.[9],
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected findOrCreate query: ${sql}`);
    },
  } as never);

  const session = await repository.findOrCreateSession({
    provider: "webhook-ci",
    providerKind: "webhook",
    channelBindingId: "webhook",
    target: { provider: "webhook-ci", providerKind: "webhook", chatId: "chat-1", threadId: "thread-1" },
    externalUserId: "user-1",
    text: "hello",
    now,
  });

  assert.equal(session.sessionId, "session-existing");
  assert.equal(session.updatedAt, now.toISOString());
  assert.match(queries.join("\n"), /updated_at = EXCLUDED\.updated_at/);
  assert.equal(queries.at(-1), "COMMIT");
});

test("postgres repository migrations skip the applied clean baseline", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const tables = new Set(["standalone_gateway_schema_migrations", ...STANDALONE_GATEWAY_REQUIRED_TABLE_NAMES]);
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM pg_catalog.pg_tables")) {
        const requested = (params?.[0] as string[]) || [];
        return { rows: requested.filter((name) => tables.has(name)).map((name) => ({ table_name: name })), rowCount: tables.size };
      }
      if (sql.includes("SELECT id FROM standalone_gateway_schema_migrations")) {
        return { rows: [{ id: STANDALONE_GATEWAY_BASELINE_MIGRATION_ID }], rowCount: 1 };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected migration query: ${sql}`);
    },
  };
  const repository = new PostgresStandaloneGatewayRepository(pool as never);

  await repository.migrate();

  const migrationSql = queries.map((query) => query.sql).join("\n");
  assert.equal(migrationSql.includes("CREATE UNIQUE INDEX IF NOT EXISTS standalone_gateway_sessions_provider_thread_unique"), false);
  assert.equal(migrationSql.includes("standalone_gateway_sessions_provider_workspace_thread_unique"), false);
  assert.equal(migrationSql.includes("standalone_gateway_jobs_active_session_idx"), false);
});

test("postgres repository refuses a clean baseline over untracked product tables before mutation", async () => {
  const queries: string[] = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM pg_catalog.pg_tables")) {
        const requested = (params?.[0] as string[]) || [];
        return {
          rows: requested.includes("standalone_gateway_sessions") ? [{ table_name: "standalone_gateway_sessions" }] : [],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected migration query: ${sql}`);
    },
  };
  const repository = new PostgresStandaloneGatewayRepository(pool as never);

  await assert.rejects(
    () => repository.migrate(),
    /Refusing to apply the clean Standalone Gateway baseline[\s\S]*Recreate an empty Standalone Gateway schema/,
  );

  assert.equal(queries.some((sql) => sql.includes("CREATE TABLE IF NOT EXISTS standalone_gateway_schema_migrations")), false);
  assert.equal(queries.some((sql) => sql.includes("INSERT INTO standalone_gateway_schema_migrations")), false);
});

test("postgres repository readiness rejects a ledger-only schema", async () => {
  const pool = {
    async query(sql: string, params?: unknown[]) {
      if (sql === "SELECT 1") return { rows: [{ "?column?": 1 }], rowCount: 1 };
      if (sql.includes("FROM pg_catalog.pg_tables")) {
        const requested = (params?.[0] as string[]) || [];
        return {
          rows: requested.includes("standalone_gateway_schema_migrations")
            ? [{ table_name: "standalone_gateway_schema_migrations" }]
            : [],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT id FROM standalone_gateway_schema_migrations")) {
        return { rows: [{ id: STANDALONE_GATEWAY_BASELINE_MIGRATION_ID }], rowCount: 1 };
      }
      throw new Error(`Unexpected readiness query: ${sql}`);
    },
  };
  const repository = new PostgresStandaloneGatewayRepository(pool as never);

  const readiness = await repository.readiness();

  assert.equal(readiness.ok, false);
  assert.match(readiness.detail, /required production tables are missing/);
});

test("standalone clean baseline includes current authorization and retention schema", () => {
  assert.equal(standaloneGatewayMigrations.length, 1);
  const baseline = standaloneGatewayMigrations[0];
  assert.ok(baseline);
  assert.equal(baseline.id, "0001_standalone_gateway_baseline");
  assert.match(baseline.sql, /provider_workspace_id text NOT NULL DEFAULT ''/);
  assert.match(baseline.sql, /standalone_gateway_sessions_provider_workspace_thread_unique/);
  assert.match(baseline.sql, /standalone_gateway_channel_identities_provider_workspace_user_unique/);
  assert.match(baseline.sql, /CHECK \(role IN \('owner', 'admin', 'member', 'approver', 'viewer'\)\)/);
  assert.match(baseline.sql, /CHECK \(status IN \('active', 'disabled'\)\)/);
  assert.match(baseline.sql, /standalone_gateway_sessions_retention_idx/);
  assert.match(baseline.sql, /WHERE status IN \('idle', 'failed', 'completed'\)/);
  assert.match(baseline.sql, /standalone_gateway_jobs_retention_idx/);
  assert.match(baseline.sql, /standalone_gateway_jobs_active_session_idx/);
  assert.match(baseline.sql, /standalone_gateway_artifacts_retention_idx/);
  assert.match(baseline.sql, /standalone_gateway_artifacts_session_retention_idx/);
  assert.doesNotMatch(baseline.sql, /pg_constraint/);
  assert.doesNotMatch(baseline.sql, /DROP CONSTRAINT/);
  assert.doesNotMatch(baseline.sql, /UNIQUE \(provider, external_user_id\)/);
});
