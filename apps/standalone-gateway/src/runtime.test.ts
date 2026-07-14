import test from "node:test";
import assert from "node:assert/strict";

import { FakeChannelProvider } from "@open-cowork/gateway-testing";
import type { IncomingChannelMessage } from "@open-cowork/gateway-channel";

import { FakeStandaloneOpenCodeAdapter, type StandaloneOpenCodeAdapter } from "../dist/opencode.js";
import { InMemoryStandaloneGatewayRepository } from "../dist/repository.js";
import { createStandaloneGatewayRuntime } from "../dist/runtime.js";
import type { StandaloneGatewayIdentityRole, StandaloneGatewayIdentityStatus } from "../dist/types.js";

function message(id: string, text: string): IncomingChannelMessage {
  return {
    id,
    provider: "cli-standalone",
    providerKind: "cli",
    providerEventId: `event-${id}`,
    providerMessageId: id,
    target: { provider: "cli-standalone", providerKind: "cli", chatId: "chat-1", threadId: "thread-1" },
    sender: { providerUserId: "user-1" },
    text,
    rawText: text,
    isCommand: false,
    attachments: [],
    receivedAt: new Date("2026-06-01T00:00:00.000Z"),
    raw: {},
  };
}

const providerConfig = {
  id: "cli-standalone" as const,
  kind: "cli" as const,
  channelBindingId: "cli",
  enabled: true,
  credentials: {},
  settings: {},
};

async function authorize(
  repository: InMemoryStandaloneGatewayRepository,
  input: { role?: StandaloneGatewayIdentityRole; status?: StandaloneGatewayIdentityStatus; externalUserId?: string; providerWorkspaceId?: string } = {},
) {
  return repository.upsertChannelIdentity({
    provider: "cli-standalone",
    externalUserId: input.externalUserId || "user-1",
    providerWorkspaceId: input.providerWorkspaceId,
    role: input.role || "member",
    status: input.status || "active",
  });
}

test("standalone runtime prompts private OpenCode and persists projected events", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  await authorize(repository);
  const opencode = new FakeStandaloneOpenCodeAdapter();
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  const provider = new FakeChannelProvider({ id: "cli-standalone" });

  await runtime.handleMessage(provider, providerConfig, message("message-1", "build the thing"));

  assert.equal(opencode.prompts.length, 1);
  assert.equal(opencode.prompts[0]?.admissionId, "standalone:channel:cli-standalone::event-message-1");
  assert.equal((await repository.listSessions())[0]?.status, "idle");
  const snapshot = await repository.dashboardSnapshot();
  assert.equal(snapshot.sessions[0]?.provider, "cli-standalone");
  assert.equal(snapshot.audits[0]?.action, "standalone.prompt");
});

test("standalone runtime replies in-channel with the assistant output", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  await authorize(repository);
  const opencode = new FakeStandaloneOpenCodeAdapter();
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  const provider = new FakeChannelProvider({ id: "cli-standalone" });

  await runtime.handleMessage(provider, providerConfig, message("message-1", "build the thing"));

  assert.equal(provider.sent.length, 1);
  assert.equal(provider.sent[0]?.kind, "text");
  assert.equal(provider.sent[0]?.text, "Standalone response: build the thing");
  assert.equal(provider.sent[0]?.target.chatId, "chat-1");
  assert.ok(provider.sent[0]?.options?.deliveryId);
});

test("standalone runtime still replies when a provider declares a sub-100 text limit", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  await authorize(repository);
  const opencode = new FakeStandaloneOpenCodeAdapter();
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  // A non-conformant provider whose maxTextLength is below chunkText's minimum (100) must not
  // make every reply throw and get silently swallowed as standalone.reply.failed.
  const provider = new FakeChannelProvider({ id: "cli-standalone", capabilities: { maxTextLength: 20 } });

  await runtime.handleMessage(provider, providerConfig, message("message-1", "hi"));

  // "Standalone response: hi" (23 chars) is split into provider-sized (<=20) chunks and fully
  // delivered — no chunkText throw, no dropped reply, all content preserved.
  assert.ok(provider.sent.length >= 1, "reply must be delivered");
  for (const sent of provider.sent) assert.ok((sent.text?.length ?? 0) <= 20);
  assert.equal(provider.sent.map((s) => s.text).join(""), "Standalone response: hi");
  const snapshot = await repository.dashboardSnapshot();
  assert.ok(!snapshot.audits.find((a) => a.action === "standalone.reply.failed"), "reply must not fail");
});

test("standalone runtime chunks long replies to the provider text limit", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  await authorize(repository);
  const longText = "word ".repeat(80).trim();
  const opencode: StandaloneOpenCodeAdapter = {
    async createSession() {
      return { opencodeSessionId: "oc-long" };
    },
    async prompt(input) {
      await input.onEvent({ type: "assistant.message", payload: { text: longText } });
    },
    async health() {
      return { ok: true, detail: "ready" };
    },
  };
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  const provider = new FakeChannelProvider({ id: "cli-standalone", capabilities: { maxTextLength: 100 } });

  await runtime.handleMessage(provider, providerConfig, message("message-1", "write a lot"));

  assert.ok(provider.sent.length > 1);
  for (const entry of provider.sent) {
    assert.ok((entry.text || "").length <= 100);
  }
  const deliveryIds = provider.sent.map((entry) => entry.options?.deliveryId);
  assert.equal(new Set(deliveryIds).size, deliveryIds.length);
});

test("standalone runtime coalesces streamed assistant snapshots into one reply", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  await authorize(repository);
  const opencode: StandaloneOpenCodeAdapter = {
    async createSession() {
      return { opencodeSessionId: "oc-stream" };
    },
    async prompt(input) {
      await input.onEvent({ type: "assistant.message", payload: { text: "Working on" } });
      await input.onEvent({ type: "assistant.message", payload: { text: "Working on it. Done." } });
      await input.onEvent({ type: "assistant.message", payload: { text: "Done." } });
    },
    async health() {
      return { ok: true, detail: "ready" };
    },
  };
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  const provider = new FakeChannelProvider({ id: "cli-standalone" });

  await runtime.handleMessage(provider, providerConfig, message("message-1", "stream it"));

  assert.equal(provider.sent.length, 1);
  assert.equal(provider.sent[0]?.text, "Working on it. Done.");
});

test("standalone runtime audits reply delivery failures without failing the prompt", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  await authorize(repository);
  const opencode = new FakeStandaloneOpenCodeAdapter();
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  const provider = new FakeChannelProvider({ id: "cli-standalone" });
  provider.sendText = async () => {
    throw new Error("provider offline");
  };

  await runtime.handleMessage(provider, providerConfig, message("message-1", "build the thing"));

  const snapshot = await repository.dashboardSnapshot();
  assert.equal(snapshot.sessions[0]?.status, "idle");
  assert.equal(snapshot.audits[0]?.action, "standalone.prompt");
  const replyAudit = snapshot.audits.find((audit) => audit.action === "standalone.reply.failed");
  assert.equal(replyAudit?.metadata.error, "provider offline");
});

test("standalone runtime stops claiming jobs the instant the lease is inactive", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  const opencode = new FakeStandaloneOpenCodeAdapter();
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  await repository.enqueueJob({ kind: "prompt", payload: { text: "job one", opencodeSessionId: "oc-job-one" } });
  await repository.enqueueJob({ kind: "prompt", payload: { text: "job two", opencodeSessionId: "oc-job-two" } });

  // isActive() === false (lease lost) → the claim loop breaks before touching the queue.
  assert.equal(await runtime.runDueJobs("worker-1", { isActive: () => false }), 0);
  // With the lease active the same backlog drains normally.
  assert.equal(await runtime.runDueJobs("worker-1", { isActive: () => true }), 2);
});

test("standalone runtime executes prompt jobs against OpenCode before completing them", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  const opencode = new FakeStandaloneOpenCodeAdapter();
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  const job = await repository.enqueueJob({ kind: "prompt", payload: { text: "run the report", opencodeSessionId: "oc-existing" } });

  assert.equal(await runtime.runDueJobs("worker-1"), 1);

  assert.deepEqual(opencode.prompts, [{
    opencodeSessionId: "oc-existing",
    admissionId: `standalone:job:${job.jobId}`,
    text: "run the report",
  }]);
  const snapshot = await repository.dashboardSnapshot();
  assert.equal(snapshot.jobs[0]?.status, "completed");
  assert.equal(snapshot.jobs[0]?.lastError, null);
});

test("standalone runtime persists a queued job session binding before prompt admission", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  const session = await repository.findOrCreateSession({
    provider: "cli-standalone",
    providerKind: "cli",
    channelBindingId: "cli",
    target: { provider: "cli-standalone", providerKind: "cli", chatId: "chat-job", threadId: "thread-job" },
    externalUserId: "user-job",
    text: "durable job",
  });
  let bindingObservedBeforePrompt = false;
  const prompts: Array<{ opencodeSessionId: string; admissionId: string }> = [];
  const opencode: StandaloneOpenCodeAdapter = {
    async createSession() {
      return { opencodeSessionId: "oc-durable-job" };
    },
    async prompt(input) {
      bindingObservedBeforePrompt = (await repository.getSession(session.sessionId))?.opencodeSessionId === input.opencodeSessionId;
      prompts.push({ opencodeSessionId: input.opencodeSessionId, admissionId: input.admissionId });
    },
    async health() {
      return { ok: true, detail: "ready" };
    },
  };
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  const job = await repository.enqueueJob({
    kind: "prompt",
    sessionId: session.sessionId,
    payload: { text: "durable job" },
  });

  assert.equal(await runtime.runDueJobs("worker-1"), 1);
  assert.equal(bindingObservedBeforePrompt, true);
  assert.deepEqual(prompts, [{
    opencodeSessionId: "oc-durable-job",
    admissionId: `standalone:job:${job.jobId}`,
  }]);
  assert.equal((await repository.getSession(session.sessionId))?.status, "idle");
});

test("standalone runtime fails prompt jobs that carry no prompt text", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  const opencode = new FakeStandaloneOpenCodeAdapter();
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  await repository.enqueueJob({ kind: "prompt", payload: {} });

  assert.equal(await runtime.runDueJobs("worker-1"), 1);

  assert.equal(opencode.prompts.length, 0);
  const snapshot = await repository.dashboardSnapshot();
  assert.equal(snapshot.jobs[0]?.status, "failed");
  assert.match(snapshot.jobs[0]?.lastError || "", /missing a non-empty "text"/);
});

for (const kind of ["workflow", "watch", "team_task"] as const) {
  test(`standalone runtime fails unsupported ${kind} jobs instead of faking success`, async () => {
    const repository = new InMemoryStandaloneGatewayRepository();
    const opencode = new FakeStandaloneOpenCodeAdapter();
    const runtime = createStandaloneGatewayRuntime({ repository, opencode });
    await repository.enqueueJob({ kind, payload: { anything: true } });

    assert.equal(await runtime.runDueJobs("worker-1"), 1);

    assert.equal(opencode.prompts.length, 0);
    const snapshot = await repository.dashboardSnapshot();
    assert.equal(snapshot.jobs[0]?.status, "failed");
    assert.match(snapshot.jobs[0]?.lastError || "", /not implemented in the standalone gateway/);
    const unsupported = snapshot.audits.find((a) => a.action === "standalone.job.unsupported");
    assert.ok(unsupported, "expected a standalone.job.unsupported audit");
    assert.equal(unsupported.metadata.kind, kind);
    // Every claimed job — including unsupported kinds — records a claim audit for a consistent trail.
    const claimed = snapshot.audits.find((a) => a.action === "standalone.job.claimed");
    assert.ok(claimed, "expected a standalone.job.claimed audit for the unsupported kind");
    assert.equal(claimed.metadata.kind, kind);
  });
}

test("standalone runtime serializes concurrent work for one channel session", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  await authorize(repository);
  let createCount = 0;
  let activePrompts = 0;
  let maxActivePrompts = 0;
  const prompts: Array<{ opencodeSessionId: string; text: string }> = [];
  const opencode: StandaloneOpenCodeAdapter = {
    async createSession() {
      createCount += 1;
      return { opencodeSessionId: `oc-${createCount}` };
    },
    async prompt(input) {
      activePrompts += 1;
      maxActivePrompts = Math.max(maxActivePrompts, activePrompts);
      prompts.push({ opencodeSessionId: input.opencodeSessionId, text: input.text });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await input.onEvent({ type: "assistant.message", payload: { text: `done: ${input.text}` } });
      activePrompts -= 1;
    },
    async health() {
      return { ok: true, detail: "ready" };
    },
  };
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  const provider = new FakeChannelProvider({ id: "cli-standalone" });

  await Promise.all([
    runtime.handleMessage(provider, providerConfig, message("message-1", "first")),
    runtime.handleMessage(provider, providerConfig, message("message-2", "second")),
  ]);

  assert.equal(createCount, 1);
  assert.equal(maxActivePrompts, 1);
  assert.deepEqual(prompts, [
    { opencodeSessionId: "oc-1", text: "first" },
    { opencodeSessionId: "oc-1", text: "second" },
  ]);
  const sessions = await repository.listSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.opencodeSessionId, "oc-1");
  assert.equal(sessions[0]?.status, "idle");
});

test("standalone runtime records failed prompts durably", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  await authorize(repository);
  const runtime = createStandaloneGatewayRuntime({
    repository,
    opencode: {
      async createSession() {
        return { opencodeSessionId: "oc-failed" };
      },
      async prompt() {
        throw new Error("runtime unavailable");
      },
      async health() {
        return { ok: true, detail: "ready" };
      },
    },
  });
  const provider = new FakeChannelProvider({ id: "cli-standalone" });

  await assert.rejects(() => runtime.handleMessage(provider, providerConfig, {
    ...message("message-1", "fail the thing"),
    target: { provider: "cli-standalone", providerKind: "cli", chatId: "chat-2", threadId: "thread-2" },
  }), /runtime unavailable/);

  const snapshot = await repository.dashboardSnapshot();
  assert.equal(snapshot.sessions[0]?.status, "failed");
  assert.equal(snapshot.audits[0]?.action, "standalone.prompt.failed");
});

test("standalone runtime treats a projected terminal error as failure even when an adapter returns normally", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  await authorize(repository);
  const runtime = createStandaloneGatewayRuntime({
    repository,
    opencode: {
      async createSession() {
        return { opencodeSessionId: "oc-terminal-error" };
      },
      async prompt(input) {
        await input.onEvent({
          type: "session.error",
          payload: { message: "terminal step failed", apiKey: "synthetic-value" },
        });
      },
      async health() {
        return { ok: true, detail: "ready" };
      },
    },
  });
  const provider = new FakeChannelProvider({ id: "cli-standalone" });

  await assert.rejects(
    () => runtime.handleMessage(provider, providerConfig, {
      ...message("message-terminal", "fail in stream"),
      target: { provider: "cli-standalone", providerKind: "cli", chatId: "chat-terminal", threadId: "thread-terminal" },
    }),
    /terminal step failed/,
  );

  const snapshot = await repository.dashboardSnapshot();
  assert.equal(snapshot.sessions[0]?.status, "failed");
  assert.equal(snapshot.audits.some((audit) => audit.action === "standalone.prompt"), false);
  assert.equal(snapshot.audits[0]?.action, "standalone.prompt.failed");
  assert.equal(provider.sent.length, 0);
});

test("standalone runtime records failed session creation durably", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  await authorize(repository);
  let promptCalled = false;
  const runtime = createStandaloneGatewayRuntime({
    repository,
    opencode: {
      async createSession() {
        throw new Error("session bind unavailable");
      },
      async prompt() {
        promptCalled = true;
      },
      async health() {
        return { ok: true, detail: "ready" };
      },
    },
  });
  const provider = new FakeChannelProvider({ id: "cli-standalone" });

  await assert.rejects(() => runtime.handleMessage(provider, providerConfig, {
    ...message("message-1", "fail before prompt"),
    target: { provider: "cli-standalone", providerKind: "cli", chatId: "chat-3", threadId: "thread-3" },
  }), /session bind unavailable/);

  const snapshot = await repository.dashboardSnapshot();
  assert.equal(promptCalled, false);
  assert.equal(snapshot.sessions[0]?.status, "failed");
  assert.equal(snapshot.sessions[0]?.opencodeSessionId, null);
  assert.equal(snapshot.audits[0]?.action, "standalone.prompt.failed");
});

test("standalone runtime isolates sessions by provider workspace", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  await authorize(repository, { providerWorkspaceId: "workspace-a" });
  await authorize(repository, { providerWorkspaceId: "workspace-b" });
  const opencode = new FakeStandaloneOpenCodeAdapter();
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  const provider = new FakeChannelProvider({ id: "cli-standalone" });

  await runtime.handleMessage(provider, providerConfig, {
    ...message("message-a", "workspace a"),
    raw: { workspace_id: "workspace-a" },
  });
  await runtime.handleMessage(provider, providerConfig, {
    ...message("message-b", "workspace b"),
    raw: { workspace_id: "workspace-b" },
  });

  const sessions = await repository.listSessions();
  assert.equal(opencode.prompts.length, 2);
  assert.equal(sessions.length, 2);
  assert.deepEqual(new Set(sessions.map((session) => session.providerWorkspaceId)), new Set(["workspace-a", "workspace-b"]));
});

test("standalone runtime denies unknown identities before session creation", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  const opencode = new FakeStandaloneOpenCodeAdapter();
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  const provider = new FakeChannelProvider({ id: "cli-standalone" });

  await runtime.handleMessage(provider, providerConfig, message("message-1", "do not prompt"));

  const snapshot = await repository.dashboardSnapshot();
  assert.equal(opencode.prompts.length, 0);
  assert.equal(snapshot.sessions.length, 0);
  assert.equal(snapshot.audits[0]?.action, "standalone.prompt.denied");
  assert.equal(snapshot.audits[0]?.metadata.reason, "identity_not_found");
});

for (const role of ["viewer", "approver"] as const) {
  test(`standalone runtime denies ${role} identities before prompting`, async () => {
    const repository = new InMemoryStandaloneGatewayRepository();
    await authorize(repository, { role });
    const opencode = new FakeStandaloneOpenCodeAdapter();
    const runtime = createStandaloneGatewayRuntime({ repository, opencode });
    const provider = new FakeChannelProvider({ id: "cli-standalone" });

    await runtime.handleMessage(provider, providerConfig, message(`message-${role}`, "do not prompt"));

    const snapshot = await repository.dashboardSnapshot();
    assert.equal(opencode.prompts.length, 0);
    assert.equal(snapshot.sessions.length, 0);
    assert.equal(snapshot.audits[0]?.metadata.reason, "role_not_allowed");
    assert.equal(snapshot.audits[0]?.metadata.identityRole, role);
  });
}

test("standalone runtime denies disabled identities before prompting", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  await authorize(repository, { role: "member", status: "disabled" });
  const opencode = new FakeStandaloneOpenCodeAdapter();
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  const provider = new FakeChannelProvider({ id: "cli-standalone" });

  await runtime.handleMessage(provider, providerConfig, message("message-disabled", "do not prompt"));

  const snapshot = await repository.dashboardSnapshot();
  assert.equal(opencode.prompts.length, 0);
  assert.equal(snapshot.sessions.length, 0);
  assert.equal(snapshot.audits[0]?.metadata.reason, "identity_disabled");
  assert.equal(snapshot.audits[0]?.metadata.identityStatus, "disabled");
});

for (const role of ["member", "admin", "owner"] as const) {
  test(`standalone runtime allows ${role} identities to prompt`, async () => {
    const repository = new InMemoryStandaloneGatewayRepository();
    await authorize(repository, { role });
    const opencode = new FakeStandaloneOpenCodeAdapter();
    const runtime = createStandaloneGatewayRuntime({ repository, opencode });
    const provider = new FakeChannelProvider({ id: "cli-standalone" });

    await runtime.handleMessage(provider, providerConfig, message(`message-${role}`, "prompt"));

    const snapshot = await repository.dashboardSnapshot();
    assert.equal(opencode.prompts.length, 1);
    assert.equal(snapshot.sessions.length, 1);
    assert.equal(snapshot.audits[0]?.action, "standalone.prompt");
  });
}
