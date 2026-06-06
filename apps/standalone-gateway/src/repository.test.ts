import test from "node:test";
import assert from "node:assert/strict";

import * as standaloneGateway from "../dist/index.js";
import { exportStandaloneGatewayBackup } from "../dist/backup.js";
import { PostgresStandaloneGatewayRepository } from "../dist/postgres-repository.js";
import { InMemoryStandaloneGatewayRepository } from "../dist/repository.js";
import { describeStandaloneRetention } from "../dist/retention.js";
import { standaloneGatewayMigrations } from "../dist/schema.js";

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

test("standalone package barrel exposes backup, retention, and repository adapters", async () => {
  let requestedLimit = 0;
  const backup = await exportStandaloneGatewayBackup({
    dashboardSnapshot: async (limit: number) => {
      requestedLimit = limit;
      return {
        generatedAt: "2026-06-05T00:00:00.000Z",
        sessions: [{ sessionId: "session-1" }],
        identities: [{ identityId: "identity-1" }],
        jobs: [{ jobId: "job-1" }],
        audits: [{ auditId: "audit-1" }],
      };
    },
  } as never);

  assert.equal(requestedLimit, 500);
  assert.equal(backup.format, "open-cowork-standalone-gateway-backup-v1");
  assert.deepEqual(backup.sessions, [{ sessionId: "session-1" }]);
  assert.deepEqual(backup.identities, [{ identityId: "identity-1" }]);
  assert.deepEqual(describeStandaloneRetention({
    retention: { sessionDays: 30, artifactDays: 7, auditDays: 90 },
  } as never), ["sessions:30d", "artifacts:7d", "audit:90d"]);
  assert.equal(standaloneGateway.exportStandaloneGatewayBackup, exportStandaloneGatewayBackup);
  assert.equal(standaloneGateway.describeStandaloneRetention, describeStandaloneRetention);
  assert.equal(typeof standaloneGateway.createStandaloneGatewayPostgresRepository, "function");
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

  assert.deepEqual(await repository.readiness(), { ok: true, detail: "postgres ready" });
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

test("postgres repository migrations skip applied migration ids before replaying old indexes", async () => {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const pool = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql.includes("CREATE TABLE IF NOT EXISTS standalone_gateway_schema_migrations")) return { rows: [], rowCount: 0 };
      if (sql.includes("SELECT id FROM standalone_gateway_schema_migrations")) {
        return { rows: params?.[0] === "0001_standalone_gateway_core" ? [{ id: params[0] }] : [], rowCount: params?.[0] === "0001_standalone_gateway_core" ? 1 : 0 };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO standalone_gateway_schema_migrations")) return { rows: [], rowCount: 1 };
      if (sql.includes("0001_standalone_gateway_core")) throw new Error("migration id should not be embedded in SQL");
      if (sql.includes("standalone_gateway_sessions_provider_workspace_thread_unique")) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected migration query: ${sql}`);
    },
  };
  const repository = new PostgresStandaloneGatewayRepository(pool as never);

  await repository.migrate();

  const migrationSql = queries.map((query) => query.sql).join("\n");
  assert.equal(migrationSql.includes("CREATE UNIQUE INDEX IF NOT EXISTS standalone_gateway_sessions_provider_thread_unique"), false);
  assert.equal(migrationSql.includes("standalone_gateway_sessions_provider_workspace_thread_unique"), true);
});

test("standalone identity migration drops legacy provider-user uniqueness by catalog lookup", () => {
  const migration = standaloneGatewayMigrations.find((entry) => entry.id === "0002_standalone_gateway_identity_authorization");
  assert.ok(migration);
  assert.match(migration.sql, /pg_constraint/);
  assert.match(migration.sql, /DROP CONSTRAINT %I/);
  assert.match(migration.sql, /ARRAY\['provider', 'external_user_id'\]/);
});
