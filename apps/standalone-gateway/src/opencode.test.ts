import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  RUNTIME_EVENT_REDACTED,
  RUNTIME_EVENT_TRUNCATED,
} from "@open-cowork/shared";

import { createSdkOpenCodeAdapter, normalizeOpenCodeEvent } from "../dist/opencode.js";

const runtimeRoot = "/var/lib/open-cowork/standalone-gateway";

function asyncEvents(events: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

function quietControlPlane(): {
  subscribe(options?: { signal?: AbortSignal }): Promise<{ stream: AsyncIterable<unknown> }>;
} {
  return {
    async subscribe(options) {
      return {
        stream: {
          async *[Symbol.asyncIterator]() {
            yield { type: "server.connected", data: {} };
            await new Promise<void>((resolve) => {
              if (options?.signal?.aborted) {
                resolve();
                return;
              }
              options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
          },
        },
      };
    },
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function stablePromptId(admissionId: string): string {
  return `msg_${createHash("sha256")
    .update("open-cowork-standalone-prompt\0")
    .update(admissionId)
    .digest("hex")
    .slice(0, 24)}`;
}

test("standalone OpenCode adapter uses native v2 session creation", async () => {
  const calls: unknown[] = [];
  const clientConfigs: unknown[] = [];
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    runtimeRoot,
    loadSdk: async () => ({
      createOpencodeClient: (config) => {
        clientConfigs.push(config);
        return ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
          event: quietControlPlane(),
          session: {
            create: async (...args: unknown[]) => {
              calls.push(args);
              return { data: { data: { id: "oc-1" } } };
            },
            prompt: async () => ({}),
            interrupt: async () => ({}),
          },
        },
      });
      },
    }),
  });

  assert.deepEqual(await adapter.createSession({ title: "ignored native title" }), { opencodeSessionId: "oc-1" });
  assert.deepEqual(clientConfigs, [{ baseUrl: "http://127.0.0.1:4096", directory: runtimeRoot }]);
  assert.deepEqual(calls, [[{
    location: { directory: runtimeRoot },
  }, { throwOnError: true }]]);
});

test("standalone OpenCode adapter keeps the required native v2 session body on the wire", async () => {
  let capturedRequest: { method: string | undefined; url: string | undefined; body: string } | null = null;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      capturedRequest = {
        method: request.method,
        url: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { id: "oc-wire" } }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test HTTP server did not expose a TCP port.");
    const adapter = createSdkOpenCodeAdapter({
      baseUrl: `http://127.0.0.1:${address.port}`,
      runtimeRoot,
    });

    assert.deepEqual(await adapter.createSession({ title: "wire body" }), { opencodeSessionId: "oc-wire" });
    assert.deepEqual(capturedRequest, {
      method: "POST",
      url: "/api/session",
      body: JSON.stringify({ location: { directory: runtimeRoot } }),
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("standalone OpenCode adapter preserves explicit private DNS policy", () => {
  assert.doesNotThrow(() => createSdkOpenCodeAdapter({
    baseUrl: "http://opencode.internal:4096",
    runtimeRoot,
    allowPrivateDns: true,
    loadSdk: async () => ({}),
  }));
  assert.throws(() => createSdkOpenCodeAdapter({
    baseUrl: "http://opencode.internal:4096",
    runtimeRoot,
    loadSdk: async () => ({}),
  }), /public OpenCode endpoint/);
});

test("standalone OpenCode adapter replays durable events from the admitted prompt sequence", async () => {
  const order: string[] = [];
  const events: unknown[] = [];
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    runtimeRoot,
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
          event: quietControlPlane(),
          session: {
            create: async () => ({ data: { data: { id: "oc-1" } } }),
            prompt: async (input: unknown) => {
              order.push("prompt");
              assert.deepEqual(input, {
                sessionID: "oc-1",
                id: stablePromptId("provider-event-1"),
                prompt: { text: "hello" },
                delivery: "queue",
                resume: true,
              });
              return { data: { data: { id: stablePromptId("provider-event-1"), admittedSeq: 7 } } };
            },
            events: async (input: unknown) => {
              order.push("subscribe");
              assert.deepEqual(input, { sessionID: "oc-1", after: "6" });
              return {
                stream: {
                  async *[Symbol.asyncIterator]() {
                    order.push("stream-start");
                    yield { type: "session.input.admitted", durable: { seq: 7 }, data: { sessionID: "oc-1" } };
                    yield { type: "session.next.reasoning.ended", data: { sessionID: "oc-1", text: "private" } };
                    yield { type: "session.next.tool.called", data: { sessionID: "oc-1", callID: "call-1", tool: "read", input: { path: "README.md" } } };
                    yield { type: "session.next.tool.success", data: { sessionID: "oc-1", callID: "call-1", result: "ok" } };
                    yield { type: "session.next.text.ended", data: { sessionID: "other", text: "wrong session" } };
                    yield { type: "session.next.text.ended", data: { sessionID: "oc-1", text: "native assistant content" } };
                    yield { type: "session.next.step.ended", data: { sessionID: "oc-1", finish: "stop" } };
                  },
                },
              };
            },
            interrupt: async () => ({}),
          },
        },
      }),
    }),
  });

  await adapter.prompt({
    opencodeSessionId: "oc-1",
    admissionId: "provider-event-1",
    text: "hello",
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(order, ["prompt", "subscribe", "stream-start"]);
  assert.deepEqual(events, [
    { type: "tool.started", entityId: "call-1", payload: { sessionID: "oc-1", callID: "call-1", tool: "read", input: { path: "README.md" } } },
    { type: "tool.completed", entityId: "call-1", payload: { sessionID: "oc-1", callID: "call-1", result: "ok" } },
    { type: "assistant.message", payload: { text: "native assistant content" } },
  ]);
  assert.equal(JSON.stringify(events).includes("private"), false);
});

test("standalone OpenCode adapter pairs durable transcript replay with filtered control events", async () => {
  const order: string[] = [];
  const projected: unknown[] = [];
  const controlReadStarted = deferred();
  const releaseFirstControl = deferred();
  const controlsDelivered = deferred();
  let controlSignal: AbortSignal | undefined;
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    runtimeRoot,
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
          event: {
            subscribe: async (options) => {
              order.push("control-subscribe");
              controlSignal = options?.signal;
              return {
                stream: {
                  async *[Symbol.asyncIterator]() {
                    controlReadStarted.resolve();
                    await releaseFirstControl.promise;
                    yield { id: "native-perm-1", type: "permission.v2.asked", data: { id: "perm-1", sessionID: "oc-1", action: "read", resources: ["README.md"] } };
                    yield { id: "native-perm-1", type: "permission.v2.asked", data: { id: "perm-1", sessionID: "oc-1", action: "read", resources: ["README.md"] } };
                    yield { id: "native-perm-reply-1", type: "permission.v2.replied", data: { sessionID: "oc-1", requestID: "perm-1", reply: "once" } };
                    yield { id: "native-question-1", type: "question.v2.asked", data: { id: "question-1", sessionID: "oc-1", questions: [] } };
                    yield { id: "native-question-reject-1", type: "question.v2.rejected", data: { sessionID: "oc-1", requestID: "question-1" } };
                    // Global transcript snapshots and other sessions never have
                    // projection ownership in this paired subscription.
                    yield { id: "native-text-duplicate", type: "session.next.text.ended", data: { sessionID: "oc-1", text: "global duplicate" } };
                    yield { id: "native-other", type: "permission.v2.asked", data: { id: "perm-other", sessionID: "oc-other", action: "read", resources: [] } };
                    await new Promise<void>((resolve) => {
                      if (controlSignal?.aborted) resolve();
                      else controlSignal?.addEventListener("abort", () => resolve(), { once: true });
                    });
                  },
                },
              };
            },
          },
          session: {
            create: async () => ({ data: { data: { id: "oc-1" } } }),
            prompt: async () => {
              order.push("prompt");
              return { data: { data: { id: "msg_test", admittedSeq: 11 } } };
            },
            events: async () => ({
              stream: {
                async *[Symbol.asyncIterator]() {
                  yield { type: "session.input.admitted", durable: { seq: 11 }, data: { sessionID: "oc-1" } };
                  await controlsDelivered.promise;
                  // These control records can also appear in aggregate history;
                  // the global stream remains their sole projection owner.
                  yield { type: "permission.v2.asked", data: { id: "perm-1", sessionID: "oc-1", action: "read", resources: ["README.md"] } };
                  yield { type: "question.v2.asked", data: { id: "question-1", sessionID: "oc-1", questions: [] } };
                  yield { type: "session.next.text.ended", data: { sessionID: "oc-1", text: "durable answer" } };
                  yield { type: "session.next.step.ended", data: { sessionID: "oc-1", finish: "stop" } };
                },
              },
            }),
            interrupt: async () => ({}),
          },
        },
      }),
    }),
  });

  const prompt = adapter.prompt({
    opencodeSessionId: "oc-1",
    admissionId: "prompt-with-controls",
    text: "inspect",
    onEvent: (event) => {
      projected.push(event);
      if (event.type === "question.resolved") controlsDelivered.resolve();
    },
  });
  await controlReadStarted.promise;
  assert.deepEqual(order, ["control-subscribe"], "prompt admission must wait for the lazy control stream's first event");
  releaseFirstControl.resolve();
  await prompt;

  assert.deepEqual(order, ["control-subscribe", "prompt"]);
  assert.deepEqual(projected, [
    { type: "permission.requested", entityId: "perm-1", payload: { id: "perm-1", sessionID: "oc-1", action: "read", resources: ["README.md"] } },
    { type: "permission.resolved", entityId: "perm-1", payload: { sessionID: "oc-1", requestID: "perm-1", reply: "once" } },
    { type: "question.asked", entityId: "question-1", payload: { id: "question-1", sessionID: "oc-1", questions: [] } },
    { type: "question.resolved", entityId: "question-1", payload: { sessionID: "oc-1", requestID: "question-1" } },
    { type: "assistant.message", payload: { text: "durable answer" } },
  ]);
});

test("standalone OpenCode adapter interrupts an ambiguously admitted prompt when control observation fails", async () => {
  const serverAdmitted = deferred();
  let interrupts = 0;
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    runtimeRoot,
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
          event: {
            subscribe: async () => ({
              stream: {
                async *[Symbol.asyncIterator]() {
                  yield { type: "server.connected", data: {} };
                  await serverAdmitted.promise;
                },
              },
            }),
          },
          session: {
            create: async () => ({ data: { data: { id: "oc-1" } } }),
            prompt: async (_input, options) => {
              serverAdmitted.resolve();
              await new Promise<void>((_resolve, reject) => {
                if (options?.signal?.aborted) {
                  reject(new Error("prompt request aborted"));
                  return;
                }
                options?.signal?.addEventListener(
                  "abort",
                  () => reject(new Error("prompt request aborted")),
                  { once: true },
                );
              });
              return { data: { data: { id: "msg_test", admittedSeq: 1 } } };
            },
            events: async () => ({ stream: asyncEvents([]) }),
            interrupt: async () => { interrupts += 1; },
          },
        },
      }),
    }),
  });

  await assert.rejects(
    adapter.prompt({
      opencodeSessionId: "oc-1",
      admissionId: "ambiguous-admission",
      text: "inspect",
      onEvent: () => undefined,
    }),
    /control-plane event stream ended before the session completed/,
  );
  assert.equal(interrupts, 1);
});

test("standalone OpenCode adapter waits through tool-call steps", async () => {
  const events: unknown[] = [];
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    runtimeRoot,
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
          event: quietControlPlane(),
          session: {
            create: async () => ({ data: { data: { id: "oc-1" } } }),
            prompt: async () => ({ data: { data: { id: "msg_test", admittedSeq: 1 } } }),
            events: async () => ({ stream: asyncEvents([
              { type: "session.next.step.ended", data: { sessionID: "oc-1", finish: "tool-calls" } },
              { type: "session.next.text.ended", data: { sessionID: "oc-1", text: "done" } },
              { type: "session.next.step.ended", data: { sessionID: "oc-1", finish: "stop" } },
            ]) }),
            interrupt: async () => ({}),
          },
        },
      }),
    }),
  });

  await adapter.prompt({ opencodeSessionId: "oc-1", admissionId: "prompt-1", text: "hello", onEvent: (event) => events.push(event) });
  assert.deepEqual(events, [{ type: "assistant.message", payload: { text: "done" } }]);
});

test("standalone OpenCode adapter rejects terminal step failures after projecting a bounded public error", async () => {
  const events: unknown[] = [];
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    runtimeRoot,
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
          event: quietControlPlane(),
          session: {
            create: async () => ({ data: { data: { id: "oc-1" } } }),
            prompt: async () => ({ data: { data: { id: "msg_test", admittedSeq: 1 } } }),
            events: async () => ({ stream: asyncEvents([{
              type: "session.next.step.failed",
              data: {
                sessionID: "oc-1",
                error: { message: "model execution failed", authorization: "Bearer synthetic-secret" },
                output: "x".repeat(2 * 1024 * 1024),
              },
            }]) }),
            interrupt: async () => ({}),
          },
        },
      }),
    }),
  });

  await assert.rejects(
    () => adapter.prompt({
      opencodeSessionId: "oc-1",
      admissionId: "prompt-1",
      text: "hello",
      onEvent: (event) => events.push(event),
    }),
    /model execution failed/,
  );
  assert.equal(events.length, 1);
  const event = events[0] as { type: string; payload: Record<string, unknown> };
  assert.equal(event.type, "session.error");
  assert.equal(
    (event.payload.error as Record<string, unknown>).authorization,
    RUNTIME_EVENT_REDACTED,
  );
  assert.equal(JSON.stringify(event).includes("synthetic-secret"), false);
  assert.equal(JSON.stringify(event).includes(RUNTIME_EVENT_TRUNCATED), true);
  assert.ok(Buffer.byteLength(JSON.stringify(event), "utf8") < 128 * 1024);
});

test("standalone OpenCode adapter fails closed when native SDK APIs are unavailable", async () => {
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    runtimeRoot,
    loadSdk: async () => ({}),
  });

  await assert.rejects(() => adapter.createSession({ title: "hello" }), /SDK v2 is unavailable/);
  await assert.rejects(() => adapter.prompt({
    opencodeSessionId: "oc-1",
    admissionId: "prompt-1",
    text: "hello",
    onEvent: () => undefined,
  }), /SDK v2 is unavailable/);
  assert.equal((await adapter.health()).ok, false);
});

test("standalone OpenCode adapter redacts secrets from native failures", async () => {
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    runtimeRoot,
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
          event: quietControlPlane(),
          session: {
            create: async () => ({ data: { data: { id: "oc-1" } } }),
            prompt: async () => { throw new Error("provider rejected token=super-secret"); },
            events: async () => ({ stream: asyncEvents([]) }),
            interrupt: async () => ({}),
          },
        },
      }),
    }),
  });

  await assert.rejects(() => adapter.prompt({
    opencodeSessionId: "oc-1",
    admissionId: "prompt-1",
    text: "hello",
    onEvent: () => undefined,
  }), /provider rejected token=\[redacted\]/);
});

test("standalone OpenCode adapter fails safely when the durable event stream cannot connect", async () => {
  let prompted = false;
  let subscribedSignal: AbortSignal | undefined;
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    runtimeRoot,
    eventConnectionTimeoutMs: 10,
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
          event: quietControlPlane(),
          session: {
            create: async () => ({ data: { data: { id: "oc-1" } } }),
            prompt: async () => {
              prompted = true;
              return { data: { data: { id: "msg_test", admittedSeq: 1 } } };
            },
            events: async (_input, options) => {
              subscribedSignal = options?.signal;
              return {
                stream: {
                  async *[Symbol.asyncIterator]() {
                    await new Promise<void>((resolve) => {
                      subscribedSignal?.addEventListener("abort", () => resolve(), { once: true });
                    });
                    yield* [];
                  },
                },
              };
            },
            interrupt: async () => ({}),
          },
        },
      }),
    }),
  });

  await assert.rejects(
    () => adapter.prompt({
      opencodeSessionId: "oc-1",
      admissionId: "prompt-1",
      text: "hello",
      onEvent: () => undefined,
    }),
    /Timed out connecting to the OpenCode event stream/,
  );
  assert.equal(prompted, true);
  assert.equal(subscribedSignal?.aborted, true);
});

test("standalone OpenCode adapter interrupts execution that exceeds its configured deadline", async () => {
  let interrupted = 0;
  let subscribedSignal: AbortSignal | undefined;
  const interruptStarted = deferred();
  const releaseInterrupt = deferred();
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    runtimeRoot,
    executionTimeoutMs: 10,
    interruptSettlementTimeoutMs: 1_000,
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
          event: quietControlPlane(),
          session: {
            create: async () => ({ data: { data: { id: "oc-1" } } }),
            prompt: async () => ({ data: { data: { id: "msg_test", admittedSeq: 1 } } }),
            events: async (_input, options) => {
              subscribedSignal = options?.signal;
              return {
                stream: {
                  async *[Symbol.asyncIterator]() {
                    yield { type: "session.input.admitted", data: { sessionID: "oc-1" } };
                    await new Promise<void>((resolve) => {
                      subscribedSignal?.addEventListener("abort", () => resolve(), { once: true });
                    });
                  },
                },
              };
            },
            interrupt: async () => {
              interrupted += 1;
              interruptStarted.resolve();
              await releaseInterrupt.promise;
            },
          },
        },
      }),
    }),
  });

  const rejection = assert.rejects(
    adapter.prompt({
      opencodeSessionId: "oc-1",
      admissionId: "prompt-1",
      text: "hello",
      onEvent: () => undefined,
    }),
    /execution exceeded its configured deadline/,
  );
  let released = false;
  void rejection.then(() => { released = true; });
  await interruptStarted.promise;
  await Promise.resolve();
  assert.equal(released, false, "the serialized caller must wait for interrupt settlement");
  releaseInterrupt.resolve();
  await rejection;
  assert.equal(interrupted, 1);
  assert.equal(released, true);
  assert.equal(subscribedSignal?.aborted, true);
});

test("standalone OpenCode adapter bounds a hung interrupt and fences the session until late success", async () => {
  const releaseInterrupt = deferred();
  let promptCalls = 0;
  let interrupted = 0;
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    runtimeRoot,
    executionTimeoutMs: 5,
    interruptSettlementTimeoutMs: 5,
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
          event: quietControlPlane(),
          session: {
            create: async () => ({ data: { data: { id: "oc-1" } } }),
            prompt: async () => {
              promptCalls += 1;
              return { data: { data: { id: "msg_test", admittedSeq: promptCalls } } };
            },
            events: async (_input, options) => ({
              stream: {
                async *[Symbol.asyncIterator]() {
                  yield { type: "session.input.admitted", data: { sessionID: "oc-1" } };
                  if (promptCalls === 1) {
                    await new Promise<void>((resolve) => {
                      if (options?.signal?.aborted) resolve();
                      else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
                    });
                    return;
                  }
                  yield { type: "session.next.step.ended", data: { sessionID: "oc-1", finish: "stop" } };
                },
              },
            }),
            interrupt: async () => {
              interrupted += 1;
              await releaseInterrupt.promise;
            },
          },
        },
      }),
    }),
  });

  await assert.rejects(
    adapter.prompt({ opencodeSessionId: "oc-1", admissionId: "prompt-1", text: "first", onEvent: () => undefined }),
    /execution exceeded its configured deadline/,
  );
  await assert.rejects(
    adapter.prompt({ opencodeSessionId: "oc-1", admissionId: "prompt-2", text: "second", onEvent: () => undefined }),
    /previous timed-out interrupt has not settled/,
  );
  assert.equal(promptCalls, 1);
  assert.equal(interrupted, 1);

  releaseInterrupt.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await adapter.prompt({ opencodeSessionId: "oc-1", admissionId: "prompt-3", text: "third", onEvent: () => undefined });
  assert.equal(promptCalls, 2);
});

test("standalone OpenCode adapter interrupts through native v2", async () => {
  let interrupted = "";
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    runtimeRoot,
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        v2: {
          health: { get: async () => ({ data: { healthy: true } }) },
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
