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
});
