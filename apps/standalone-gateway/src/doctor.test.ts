import test from "node:test";
import assert from "node:assert/strict";

import { loadStandaloneGatewayConfig } from "../dist/config.js";
import { runStandaloneGatewayDoctor } from "../dist/doctor.js";
import { FakeStandaloneOpenCodeAdapter } from "../dist/opencode.js";
import { InMemoryStandaloneGatewayRepository } from "../dist/repository.js";

test("standalone doctor checks product mode, repository, OpenCode, schema, and providers", async () => {
  const config = loadStandaloneGatewayConfig({
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL: "postgres://gateway:gateway@127.0.0.1:5432/gateway",
    OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN: "standalone-admin-token",
    OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL: "http://127.0.0.1:4096",
    OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_SHARED_SECRET: "standalone-webhook-secret",
    OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_DELIVERY_URL: "https://bridge.example.test/deliver",
  });

  const result = await runStandaloneGatewayDoctor({
    config,
    repository: new InMemoryStandaloneGatewayRepository(),
    opencode: new FakeStandaloneOpenCodeAdapter(),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((check) => check.name), ["product-mode", "postgres", "opencode-private", "schema", "providers"]);
  assert.deepEqual(result.doctorChecks.map((check) => check.code), [
    "standalone_gateway.product_mode",
    "standalone_gateway.repository.readiness",
    "standalone_gateway.opencode.health",
    "standalone_gateway.schema.production_tables",
    "standalone_gateway.providers.configured",
  ]);
  assert.equal(result.readinessTimeline.at(-1)?.phase, "ready");
  assert.equal(result.runtimeStatus.authority, "standalone-gateway");
  assert.equal(result.workspaceAuthority.audit, "standalone_gateway_repository");
  assert.equal(result.redacted, true);
});

test("standalone doctor redacts secret-looking readiness details", async () => {
  const config = loadStandaloneGatewayConfig({
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL: "postgres://gateway:gateway@127.0.0.1:5432/gateway",
    OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN: "standalone-admin-token",
    OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL: "http://127.0.0.1:4096",
    OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_SHARED_SECRET: "standalone-webhook-secret",
    OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_DELIVERY_URL: "https://bridge.example.test/deliver",
  });

  const result = await runStandaloneGatewayDoctor({
    config,
    repository: {
      readiness: async () => ({
        ok: false,
        detail: "postgres://gateway:super-secret-password@127.0.0.1:5432/gateway token=standalone-admin-token",
      }),
    },
    opencode: {
      createSession: async () => ({ opencodeSessionId: "unused" }),
      prompt: async () => {},
      health: async () => ({ ok: false, detail: "Authorization: Bearer gateway-token-secret" }),
    },
  });

  const payload = JSON.stringify(result);
  assert.equal(result.ok, false);
  assert.equal(payload.includes("super-secret-password"), false);
  assert.equal(payload.includes("standalone-admin-token"), false);
  assert.equal(payload.includes("gateway-token-secret"), false);
  assert.match(payload, /\[redacted\]/);
  assert.equal(result.readinessTimeline.at(-1)?.phase, "error");
});
