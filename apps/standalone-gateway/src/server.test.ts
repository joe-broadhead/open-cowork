import test from "node:test";
import assert from "node:assert/strict";

import { loadStandaloneGatewayConfig } from "../dist/config.js";
import { FakeStandaloneOpenCodeAdapter } from "../dist/opencode.js";
import { createStandaloneProviderRegistry } from "../dist/provider-registry.js";
import { InMemoryStandaloneGatewayRepository } from "../dist/repository.js";
import { createStandaloneGatewayServer } from "../dist/server.js";

test("standalone server exposes health, readiness, and admin-gated dashboard", async () => {
  const config = loadStandaloneGatewayConfig({
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL: "postgres://gateway:gateway@127.0.0.1:5432/gateway",
    OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN: "standalone-admin-token",
    OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL: "http://127.0.0.1:4096",
    OPEN_COWORK_STANDALONE_GATEWAY_PORT: "0",
    OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_SHARED_SECRET: "standalone-webhook-secret",
    OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_DELIVERY_URL: "https://bridge.example.test/deliver",
  });
  const repository = new InMemoryStandaloneGatewayRepository();
  const opencode = new FakeStandaloneOpenCodeAdapter();
  const providers = createStandaloneProviderRegistry(config);
  const server = createStandaloneGatewayServer({ config, repository, opencode, providers });
  await server.listen();
  try {
    const url = server.url();
    assert.ok(url);
    assert.equal((await fetch(`${url}/health`)).status, 200);
    const publicReady = await fetch(`${url}/ready`);
    assert.equal(publicReady.status, 200);
    assert.deepEqual(await publicReady.json(), { ok: true });
    const adminReady = await fetch(`${url}/ready`, {
      headers: { authorization: "Bearer standalone-admin-token" },
    });
    assert.equal(adminReady.status, 200);
    assert.match(JSON.stringify(await adminReady.json()), /product-mode/);
    assert.equal((await fetch(`${url}/dashboard`)).status, 401);
    const badWebhook = await fetch(`${url}/webhooks/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(badWebhook.status, 400);
    const dashboard = await fetch(`${url}/dashboard`, {
      headers: { authorization: "Bearer standalone-admin-token" },
    });
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /Standalone Gateway/);
    const metrics = await fetch(`${url}/metrics`, {
      headers: { authorization: "Bearer standalone-admin-token" },
    });
    assert.equal(metrics.status, 200);
    assert.match(await metrics.text(), /open_cowork_standalone_gateway_sessions/);
  } finally {
    await server.close();
  }
});

test("standalone server rate-limits repeated webhook requests by source", async () => {
  const config = loadStandaloneGatewayConfig({
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL: "postgres://gateway:gateway@127.0.0.1:5432/gateway",
    OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN: "standalone-admin-token",
    OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL: "http://127.0.0.1:4096",
    OPEN_COWORK_STANDALONE_GATEWAY_PORT: "0",
    OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_SHARED_SECRET: "standalone-webhook-secret",
    OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_DELIVERY_URL: "https://bridge.example.test/deliver",
  });
  const repository = new InMemoryStandaloneGatewayRepository();
  const opencode = new FakeStandaloneOpenCodeAdapter();
  const providers = createStandaloneProviderRegistry(config);
  const server = createStandaloneGatewayServer({ config, repository, opencode, providers });
  await server.listen();
  try {
    const url = server.url();
    assert.ok(url);
    for (let index = 0; index < 120; index += 1) {
      const response = await fetch(`${url}/webhooks/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      assert.equal(response.status, 400);
    }
    const blocked = await fetch(`${url}/webhooks/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get("retry-after"), "60");
    assert.match(JSON.stringify(await blocked.json()), /Too many Standalone Gateway webhook requests/);
  } finally {
    await server.close();
  }
});
