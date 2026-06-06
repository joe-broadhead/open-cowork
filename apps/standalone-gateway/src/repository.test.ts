import test from "node:test";
import assert from "node:assert/strict";

import * as standaloneGateway from "../dist/index.js";
import { exportStandaloneGatewayBackup } from "../dist/backup.js";
import { PostgresStandaloneGatewayRepository } from "../dist/postgres-repository.js";
import { InMemoryStandaloneGatewayRepository } from "../dist/repository.js";
import { describeStandaloneRetention } from "../dist/retention.js";

test("standalone repository persists sessions, events, jobs, leases, and redacted audit state", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  const lease = await repository.acquireDaemonLease({ leaseId: "daemon", ownerId: "node-1", ttlMs: 30_000 });
  assert.ok(lease?.leaseToken);
  assert.equal(await repository.acquireDaemonLease({ leaseId: "daemon", ownerId: "node-2", ttlMs: 30_000 }), null);

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
  await repository.recordAudit("test.audit", "user-1", { token: "secret-token", note: "ok" });

  const snapshot = await repository.dashboardSnapshot();
  assert.equal(snapshot.sessions.length, 1);
  assert.equal(snapshot.jobs[0]?.status, "completed");
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
        jobs: [{ jobId: "job-1" }],
        audits: [{ auditId: "audit-1" }],
      };
    },
  } as never);

  assert.equal(requestedLimit, 500);
  assert.equal(backup.format, "open-cowork-standalone-gateway-backup-v1");
  assert.deepEqual(backup.sessions, [{ sessionId: "session-1" }]);
  assert.deepEqual(describeStandaloneRetention({
    retention: { sessionDays: 30, artifactDays: 7, auditDays: 90 },
  } as never), ["sessions:30d", "artifacts:7d", "audit:90d"]);
  assert.equal(standaloneGateway.exportStandaloneGatewayBackup, exportStandaloneGatewayBackup);
  assert.equal(standaloneGateway.describeStandaloneRetention, describeStandaloneRetention);
  assert.equal(typeof standaloneGateway.createStandaloneGatewayPostgresRepository, "function");
});

test("postgres repository adapter maps readiness and daemon lease rows without a live database", async () => {
  const now = new Date("2026-06-05T00:00:00.000Z");
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
  assert.ok(queries.some((query) => query.includes("RETURNING *")));
});
