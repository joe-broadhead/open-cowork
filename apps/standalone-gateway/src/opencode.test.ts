import test from "node:test";
import assert from "node:assert/strict";

import { createSdkOpenCodeAdapter, normalizeOpenCodeEvent } from "../dist/opencode.js";

function asyncEvents(events: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

test("standalone OpenCode adapter uses native v2 session creation", async () => {
  const calls: unknown[] = [];
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
          event: { subscribe: async () => ({ stream: asyncEvents([]) }) },
          session: {
            create: async (...args: unknown[]) => {
              calls.push(args);
              return { data: { data: { id: "oc-1" } } };
            },
            prompt: async () => ({}),
            interrupt: async () => ({}),
          },
        },
      }),
    }),
  });

  assert.deepEqual(await adapter.createSession({ title: "ignored native title" }), { opencodeSessionId: "oc-1" });
  assert.equal(calls.length, 1);
});

test("standalone OpenCode adapter subscribes before native prompt and projects durable events", async () => {
  const order: string[] = [];
  const events: unknown[] = [];
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
          event: {
            subscribe: async () => {
              order.push("subscribe");
              return { stream: asyncEvents([
                { type: "session.next.reasoning.ended", data: { sessionID: "oc-1", text: "private" } },
                { type: "session.next.tool.called", data: { sessionID: "oc-1", callID: "call-1", tool: "read", input: { path: "README.md" } } },
                { type: "session.next.tool.success", data: { sessionID: "oc-1", callID: "call-1", result: "ok" } },
                { type: "session.next.text.ended", data: { sessionID: "other", text: "wrong session" } },
                { type: "session.next.text.ended", data: { sessionID: "oc-1", text: "native assistant content" } },
                { type: "session.next.step.ended", data: { sessionID: "oc-1", finish: "stop" } },
              ]) };
            },
          },
          session: {
            create: async () => ({ data: { data: { id: "oc-1" } } }),
            prompt: async (input: unknown) => {
              order.push("prompt");
              assert.deepEqual(input, {
                sessionID: "oc-1",
                prompt: { text: "hello" },
                delivery: "queue",
                resume: true,
              });
              return { data: { data: { id: "input-1" } } };
            },
            interrupt: async () => ({}),
          },
        },
      }),
    }),
  });

  await adapter.prompt({
    opencodeSessionId: "oc-1",
    text: "hello",
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(order, ["subscribe", "prompt"]);
  assert.deepEqual(events, [
    { type: "tool.started", entityId: "call-1", payload: { sessionID: "oc-1", callID: "call-1", tool: "read", input: { path: "README.md" } } },
    { type: "tool.completed", entityId: "call-1", payload: { sessionID: "oc-1", callID: "call-1", result: "ok" } },
    { type: "assistant.message", payload: { text: "native assistant content" } },
  ]);
  assert.equal(JSON.stringify(events).includes("private"), false);
});

test("standalone OpenCode adapter waits through tool-call steps", async () => {
  const events: unknown[] = [];
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
          event: { subscribe: async () => ({ stream: asyncEvents([
            { type: "session.next.step.ended", data: { sessionID: "oc-1", finish: "tool-calls" } },
            { type: "session.next.text.ended", data: { sessionID: "oc-1", text: "done" } },
            { type: "session.next.step.ended", data: { sessionID: "oc-1", finish: "stop" } },
          ]) }) },
          session: {
            create: async () => ({ data: { data: { id: "oc-1" } } }),
            prompt: async () => ({}),
            interrupt: async () => ({}),
          },
        },
      }),
    }),
  });

  await adapter.prompt({ opencodeSessionId: "oc-1", text: "hello", onEvent: (event) => events.push(event) });
  assert.deepEqual(events, [{ type: "assistant.message", payload: { text: "done" } }]);
});

test("standalone OpenCode adapter fails closed when native SDK APIs are unavailable", async () => {
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    loadSdk: async () => ({}),
  });

  await assert.rejects(() => adapter.createSession({ title: "hello" }), /SDK v2 is unavailable/);
  await assert.rejects(() => adapter.prompt({
    opencodeSessionId: "oc-1",
    text: "hello",
    onEvent: () => undefined,
  }), /SDK v2 is unavailable/);
  assert.equal((await adapter.health()).ok, false);
});

test("standalone OpenCode adapter redacts secrets from native failures", async () => {
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
          event: { subscribe: async () => ({ stream: asyncEvents([]) }) },
          session: {
            create: async () => ({ data: { data: { id: "oc-1" } } }),
            prompt: async () => { throw new Error("provider rejected token=super-secret"); },
            interrupt: async () => ({}),
          },
        },
      }),
    }),
  });

  await assert.rejects(() => adapter.prompt({
    opencodeSessionId: "oc-1",
    text: "hello",
    onEvent: () => undefined,
  }), /provider rejected token=\[redacted\]/);
});

test("standalone OpenCode adapter interrupts through native v2", async () => {
  let interrupted = "";
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
          event: { subscribe: async () => ({ stream: asyncEvents([]) }) },
          session: {
            create: async () => ({ data: { data: { id: "oc-1" } } }),
            prompt: async () => ({}),
            interrupt: async (input: { sessionID: string }) => { interrupted = input.sessionID; },
          },
        },
      }),
    }),
  });

  await adapter.abort?.("oc-1");
  assert.equal(interrupted, "oc-1");
});

test("native permission and question envelopes are normalized", () => {
  assert.deepEqual(normalizeOpenCodeEvent({
    type: "permission.v2.asked",
    properties: { id: "perm-1", sessionID: "oc-1", action: "read", resources: ["README.md"] },
  }), [{
    type: "permission.requested",
    entityId: "perm-1",
    payload: { id: "perm-1", sessionID: "oc-1", action: "read", resources: ["README.md"] },
  }]);
  assert.deepEqual(normalizeOpenCodeEvent(JSON.stringify({
    type: "question.v2.asked",
    properties: { id: "question-1", sessionID: "oc-1", questions: [] },
  })), [{
    type: "question.asked",
    entityId: "question-1",
    payload: { id: "question-1", sessionID: "oc-1", questions: [] },
  }]);
});
