import test from "node:test";
import assert from "node:assert/strict";

import { InMemoryStandaloneGatewayRepository } from "../dist/repository.js";

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
