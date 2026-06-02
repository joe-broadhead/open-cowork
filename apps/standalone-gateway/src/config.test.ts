import test from "node:test";
import assert from "node:assert/strict";

import { loadStandaloneGatewayConfig } from "../dist/config.js";

const baseEnv = {
  OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL: "postgres://gateway:gateway@127.0.0.1:5432/gateway",
  OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN: "standalone-admin-token",
  OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL: "http://127.0.0.1:4096",
  OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_SHARED_SECRET: "standalone-webhook-secret",
  OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_DELIVERY_URL: "https://bridge.example.test/deliver",
} as const;

test("standalone gateway config requires private OpenCode, Postgres, admin token, and a provider", () => {
  const config = loadStandaloneGatewayConfig(baseEnv);

  assert.equal(config.productMode, "standalone");
  assert.equal(config.database.url, baseEnv.OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL);
  assert.equal(config.opencode.baseUrl, "http://127.0.0.1:4096");
  assert.deepEqual(config.providers.map((provider) => ({
    id: provider.id,
    kind: provider.kind,
    channelBindingId: provider.channelBindingId,
  })), [{
    id: "webhook",
    kind: "webhook",
    channelBindingId: "webhook",
  }]);
});

test("standalone gateway config rejects public OpenCode and placeholder admin secrets", () => {
  assert.throws(() => loadStandaloneGatewayConfig({
    ...baseEnv,
    OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL: "https://opencode.example.com",
  }), /public OpenCode endpoint/);

  assert.throws(() => loadStandaloneGatewayConfig({
    ...baseEnv,
    OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN: "replace-with-admin",
  }), /placeholder/);
});

test("standalone gateway config resolves trusted proxy policy", () => {
  const config = loadStandaloneGatewayConfig({
    ...baseEnv,
    OPEN_COWORK_STANDALONE_GATEWAY_TRUST_PROXY_HEADERS: "true",
    OPEN_COWORK_STANDALONE_GATEWAY_TRUSTED_PROXY_CIDRS: "127.0.0.0/8, ::1",
  });

  assert.equal(config.server.trustProxyHeaders, true);
  assert.deepEqual(config.server.trustedProxyCidrs, ["127.0.0.0/8", "::1"]);
});

test("standalone gateway supports multiple provider instances without Cloud", () => {
  const config = loadStandaloneGatewayConfig({
    ...baseEnv,
    OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_PROVIDER_ID: "webhook-ci",
    OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_BOT_TOKEN: "telegram-token",
    OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_PROVIDER_ID: "telegram-prod",
  });

  assert.deepEqual(config.providers.map((provider) => provider.id), ["telegram-prod", "webhook-ci"]);
});
