import test from "node:test";
import assert from "node:assert/strict";

import { createSdkOpenCodeAdapter } from "../dist/opencode.js";

test("standalone OpenCode adapter falls back to HTTP when SDK prompt shape is unavailable", async () => {
  const events: unknown[] = [];
  const requests: Array<{ url: string; body: string }> = [];
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        session: {
          create: async () => ({ id: "oc-1" }),
        },
      }),
    }),
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: String(init?.body || "") });
      return Response.json({ type: "message", text: "accepted" });
    },
  });

  await adapter.prompt({
    opencodeSessionId: "oc-1",
    text: "hello",
    onEvent: (event) => events.push(event),
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, "http://127.0.0.1:4096/session/oc-1/prompt");
  assert.deepEqual(JSON.parse(requests[0]?.body || "{}"), { text: "hello" });
  assert.deepEqual(events, [{ type: "assistant.message", payload: { text: "accepted" } }]);
});

test("standalone OpenCode adapter throws on HTTP prompt non-2xx without synthetic success", async () => {
  const events: unknown[] = [];
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    loadSdk: async () => ({}),
    fetch: async () => new Response("token=super-secret failure", { status: 503 }),
  });

  await assert.rejects(() => adapter.prompt({
    opencodeSessionId: "oc-1",
    text: "hello",
    onEvent: (event) => events.push(event),
  }), /OpenCode prompt request returned HTTP 503: token=\[redacted\] failure/);

  assert.deepEqual(events, []);
});

test("standalone OpenCode adapter redacts provider secrets from upstream prompt failures", async () => {
  const providerKey = ["sk", "proj", "verysecretvalue"].join("-");
  const routerKey = ["sk", "or", "secretvalue"].join("-");
  const jsonProviderKey = ["sk", "proj", "jsonsecret"].join("-");
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    loadSdk: async () => ({}),
    fetch: async () => new Response(
      `Incorrect API key provided: ${providerKey} api_key:"${routerKey}" {"password":"hunter2","apiKey":"${jsonProviderKey}"} authorization=Basic dXNlcjpzZWNyZXQ= postgres://gateway:super-secret-password@127.0.0.1/db`,
      { status: 401 },
    ),
  });

  await assert.rejects(async () => adapter.prompt({
    opencodeSessionId: "oc-1",
    text: "hello",
    onEvent: () => undefined,
  }), (error) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /OpenCode prompt request returned HTTP 401/);
    assert.equal(message.includes(providerKey), false);
    assert.equal(message.includes(routerKey), false);
    assert.equal(message.includes("hunter2"), false);
    assert.equal(message.includes(jsonProviderKey), false);
    assert.equal(message.includes("dXNlcjpzZWNyZXQ="), false);
    assert.equal(message.includes("super-secret-password"), false);
    assert.match(message, /\[redacted\]/);
    return true;
  });
});

test("standalone OpenCode adapter throws on prompt network failure", async () => {
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    loadSdk: async () => ({}),
    fetch: async () => {
      throw new Error("connect ECONNREFUSED authorization=Bearer abc123456789");
    },
  });

  await assert.rejects(() => adapter.prompt({
    opencodeSessionId: "oc-1",
    text: "hello",
    onEvent: () => undefined,
  }), (error) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /OpenCode prompt request failed: connect ECONNREFUSED authorization=Bearer \[REDACTED_TOKEN\]/);
    assert.equal(message.includes("abc123456789"), false);
    return true;
  });
});

test("standalone OpenCode adapter projects SDK fields-response parts", async () => {
  const events: unknown[] = [];
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        session: {
          prompt: async () => ({
            data: {
              parts: [
                { type: "reasoning", text: "hidden reasoning text" },
                { type: "text", text: "sdk assistant content" },
              ],
            },
            error: null,
            response: { status: 200 },
          }),
        },
      }),
    }),
    fetch: async () => {
      throw new Error("fetch should not be used");
    },
  });

  await adapter.prompt({
    opencodeSessionId: "oc-1",
    text: "hello",
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(events, [{ type: "assistant.message", payload: { text: "sdk assistant content" } }]);
  assert.equal(JSON.stringify(events).includes("hidden reasoning text"), false);
});

test("standalone OpenCode adapter throws on SDK fields-response errors", async () => {
  let fetchCalled = false;
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        session: {
          prompt: async () => ({
            data: null,
            error: { message: "provider rejected token=super-secret" },
            response: { status: 503 },
          }),
        },
      }),
    }),
    fetch: async () => {
      fetchCalled = true;
      return Response.json({});
    },
  });

  await assert.rejects(() => adapter.prompt({
    opencodeSessionId: "oc-1",
    text: "hello",
    onEvent: () => undefined,
  }), /OpenCode SDK prompt failed: provider rejected token=\[redacted\]/);
  assert.equal(fetchCalled, false);
});

test("standalone OpenCode adapter does not fall back when SDK prompt itself fails", async () => {
  let fetchCalled = false;
  const adapter = createSdkOpenCodeAdapter({
    baseUrl: "http://127.0.0.1:4096",
    loadSdk: async () => ({
      createOpencodeClient: () => ({
        session: {
          prompt: async () => {
            throw new Error("sdk transport failed Authorization: Bearer sdk-secret-token");
          },
        },
      }),
    }),
    fetch: async () => {
      fetchCalled = true;
      return Response.json({});
    },
  });

  await assert.rejects(() => adapter.prompt({
    opencodeSessionId: "oc-1",
    text: "hello",
    onEvent: () => undefined,
  }), /OpenCode SDK prompt failed: sdk transport failed \[REDACTED_TOKEN\]/);
  assert.equal(fetchCalled, false);
});
