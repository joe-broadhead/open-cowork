import test from "node:test";
import assert from "node:assert/strict";

import { FakeChannelProvider } from "@open-cowork/gateway-testing";

import { FakeStandaloneOpenCodeAdapter } from "../dist/opencode.js";
import { InMemoryStandaloneGatewayRepository } from "../dist/repository.js";
import { createStandaloneGatewayRuntime } from "../dist/runtime.js";

test("standalone runtime prompts private OpenCode and persists projected events", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
  const opencode = new FakeStandaloneOpenCodeAdapter();
  const runtime = createStandaloneGatewayRuntime({ repository, opencode });
  const provider = new FakeChannelProvider({ id: "cli-standalone" });

  await runtime.handleMessage(provider, {
    id: "cli-standalone",
    kind: "cli",
    channelBindingId: "cli",
    enabled: true,
    credentials: {},
    settings: {},
  }, {
    id: "message-1",
    provider: "cli-standalone",
    providerKind: "cli",
    providerInstanceId: "cli-standalone",
    providerEventId: "event-1",
    providerMessageId: "message-1",
    target: { provider: "cli-standalone", providerKind: "cli", chatId: "chat-1", threadId: "thread-1" },
    sender: { providerUserId: "user-1" },
    text: "build the thing",
    rawText: "build the thing",
    isCommand: false,
    attachments: [],
    receivedAt: new Date("2026-06-01T00:00:00.000Z"),
    raw: {},
  });

  assert.equal(opencode.prompts.length, 1);
  assert.equal((await repository.listSessions())[0]?.status, "idle");
  const snapshot = await repository.dashboardSnapshot();
  assert.equal(snapshot.sessions[0]?.provider, "cli-standalone");
  assert.equal(snapshot.audits[0]?.action, "standalone.prompt");
});

test("standalone runtime records failed prompts durably", async () => {
  const repository = new InMemoryStandaloneGatewayRepository();
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

  await assert.rejects(() => runtime.handleMessage(provider, {
    id: "cli-standalone",
    kind: "cli",
    channelBindingId: "cli",
    enabled: true,
    credentials: {},
    settings: {},
  }, {
    id: "message-1",
    provider: "cli-standalone",
    providerKind: "cli",
    providerInstanceId: "cli-standalone",
    providerEventId: "event-1",
    providerMessageId: "message-1",
    target: { provider: "cli-standalone", providerKind: "cli", chatId: "chat-2", threadId: "thread-2" },
    sender: { providerUserId: "user-1" },
    text: "fail the thing",
    rawText: "fail the thing",
    isCommand: false,
    attachments: [],
    receivedAt: new Date("2026-06-01T00:00:00.000Z"),
    raw: {},
  }), /runtime unavailable/);

  const snapshot = await repository.dashboardSnapshot();
  assert.equal(snapshot.sessions[0]?.status, "failed");
  assert.equal(snapshot.audits[0]?.action, "standalone.prompt.failed");
});
