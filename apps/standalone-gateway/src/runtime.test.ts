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
    providerInstanceId: "cli-standalone",
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
  assert.equal((await repository.listSessions())[0]?.status, "idle");
  const snapshot = await repository.dashboardSnapshot();
  assert.equal(snapshot.sessions[0]?.provider, "cli-standalone");
  assert.equal(snapshot.audits[0]?.action, "standalone.prompt");
});

test("standalone runtime stops claiming jobs the instant the lease is inactive", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  const opencode = new FakeStandaloneOpenCodeAdapter();
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  await repository.enqueueJob({ kind: "prompt", payload: {} });
  await repository.enqueueJob({ kind: "prompt", payload: {} });

  // isActive() === false (lease lost) → the claim loop breaks before touching the queue.
  assert.equal(await runtime.runDueJobs("worker-1", { isActive: () => false }), 0);
  // With the lease active the same backlog drains normally.
  assert.equal(await runtime.runDueJobs("worker-1", { isActive: () => true }), 2);
});

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
