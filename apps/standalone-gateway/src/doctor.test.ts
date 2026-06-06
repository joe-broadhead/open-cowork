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
  const repository = new InMemoryStandaloneGatewayRepository();
  await repository.upsertChannelIdentity({
    provider: "webhook",
    externalUserId: "user-1",
    role: "admin",
  });

  const result = await runStandaloneGatewayDoctor({
    config,
    repository,
    opencode: new FakeStandaloneOpenCodeAdapter(),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map((check) => check.name), ["product-mode", "postgres", "opencode-private", "schema", "providers", "identity-authorization"]);
  assert.deepEqual(result.doctorChecks.map((check) => check.code), [
    "standalone_gateway.product_mode",
    "standalone_gateway.repository.readiness",
    "standalone_gateway.opencode.health",
    "standalone_gateway.schema.production_tables",
    "standalone_gateway.providers.configured",
    "standalone_gateway.identity_authorization",
  ]);
  assert.equal(result.readinessTimeline.at(-1)?.phase, "ready");
  assert.equal(result.runtimeStatus.authority, "standalone-gateway");
  assert.equal(result.workspaceAuthority.audit, "standalone_gateway_repository");
  assert.equal(result.redacted, true);
});

test("standalone doctor fails closed when no prompt-capable identity is configured", async () => {
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

  assert.equal(result.ok, false);
  assert.equal(result.doctorChecks.find((check) => check.code === "standalone_gateway.identity_authorization")?.status, "fail");
  assert.equal(result.readinessTimeline.at(-1)?.phase, "error");
});

test("standalone doctor ignores prompt-capable identities for unconfigured providers", async () => {
  const config = loadStandaloneGatewayConfig({
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL: "postgres://gateway:gateway@127.0.0.1:5432/gateway",
    OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN: "standalone-admin-token",
    OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL: "http://127.0.0.1:4096",
    OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_SHARED_SECRET: "standalone-webhook-secret",
    OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_DELIVERY_URL: "https://bridge.example.test/deliver",
  });
  const repository = new InMemoryStandaloneGatewayRepository();
  await repository.upsertChannelIdentity({
    provider: "webhook-other",
    externalUserId: "user-1",
    role: "admin",
  });

  const result = await runStandaloneGatewayDoctor({
    config,
    repository,
    opencode: new FakeStandaloneOpenCodeAdapter(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.doctorChecks.find((check) => check.code === "standalone_gateway.identity_authorization")?.status, "fail");
});

test("standalone doctor does not query identity authorization after repository readiness fails", async () => {
  const config = loadStandaloneGatewayConfig({
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL: "postgres://gateway:gateway@127.0.0.1:5432/gateway",
    OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN: "standalone-admin-token",
    OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL: "http://127.0.0.1:4096",
    OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_SHARED_SECRET: "standalone-webhook-secret",
    OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_DELIVERY_URL: "https://bridge.example.test/deliver",
  });
  let identitySummaryCalled = false;

  const result = await runStandaloneGatewayDoctor({
    config,
    repository: {
      readiness: async () => ({ ok: false, detail: "postgres unavailable" }),
      identityAuthorizationSummary: async () => {
        identitySummaryCalled = true;
        throw new Error("identity query should not run");
      },
    },
    opencode: new FakeStandaloneOpenCodeAdapter(),
  });

  assert.equal(identitySummaryCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.doctorChecks.find((check) => check.code === "standalone_gateway.repository.readiness")?.status, "fail");
  assert.equal(result.doctorChecks.find((check) => check.code === "standalone_gateway.identity_authorization")?.message, "Identity authorization could not be checked because the repository is not ready.");
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
