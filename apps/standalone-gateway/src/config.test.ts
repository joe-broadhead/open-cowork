import test from "node:test";
import assert from "node:assert/strict";

import {
  assertStandaloneGatewayProductionDatabaseSecurity,
  loadStandaloneGatewayConfig,
  standaloneGatewayProductionDatabaseSecurityIssue,
} from "../dist/config.js";

const baseEnv = {
  OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL: "postgres://gateway:gateway@127.0.0.1:5432/gateway",
  OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN: "standalone-admin-token",
  OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL: "http://127.0.0.1:4096",
  OPEN_COWORK_STANDALONE_GATEWAY_RUNTIME_ROOT: "/var/lib/open-cowork/standalone-gateway",
  OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_SHARED_SECRET: "standalone-webhook-secret",
  OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_DELIVERY_URL: "https://bridge.example.test/deliver",
} as const;

test("standalone gateway config requires private OpenCode, Postgres, admin token, and a provider", () => {
  const config = loadStandaloneGatewayConfig(baseEnv);

  assert.equal(config.productMode, "standalone");
  assert.equal(config.database.url, baseEnv.OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL);
  assert.equal(config.database.ssl, false);
  assert.equal(config.database.sslRejectUnauthorized, true);
  assert.equal(config.retention.jobDays, 30);
  assert.equal(config.opencode.baseUrl, "http://127.0.0.1:4096");
  assert.equal(config.opencode.runtimeRoot, "/var/lib/open-cowork/standalone-gateway");
  assert.equal(config.opencode.executionTimeoutMs, 15 * 60 * 1000);
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

test("standalone gateway config resolves Postgres TLS and retention windows", () => {
  const config = loadStandaloneGatewayConfig({
    ...baseEnv,
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL: "true",
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL_REJECT_UNAUTHORIZED: "false",
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL_CA_PATH: "/certs/ca.pem",
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL_CERT_PATH: "/certs/client-cert.pem",
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL_KEY_PATH: "/certs/client-key.pem",
    OPEN_COWORK_STANDALONE_GATEWAY_RETENTION_JOB_DAYS: "14",
    OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_EXECUTION_TIMEOUT_MS: "120000",
  });

  assert.equal(config.database.ssl, true);
  assert.equal(config.database.sslRejectUnauthorized, false);
  assert.equal(config.database.sslCaPath, "/certs/ca.pem");
  assert.equal(config.database.sslCertPath, "/certs/client-cert.pem");
  assert.equal(config.database.sslKeyPath, "/certs/client-key.pem");
  assert.equal(config.retention.jobDays, 14);
  assert.equal(config.opencode.executionTimeoutMs, 120_000);
});

test("standalone gateway production modes require verified Postgres TLS before serving", () => {
  const solo = loadStandaloneGatewayConfig(baseEnv);
  assert.doesNotThrow(() => assertStandaloneGatewayProductionDatabaseSecurity(solo));
  assert.equal(standaloneGatewayProductionDatabaseSecurityIssue(solo), null);

  const teamPlaintext = loadStandaloneGatewayConfig({
    ...baseEnv,
    OPEN_COWORK_STANDALONE_GATEWAY_DEPLOYMENT_MODE: "team",
  });
  assert.throws(
    () => assertStandaloneGatewayProductionDatabaseSecurity(teamPlaintext),
    /DATABASE_SSL=true/,
  );
  assert.match(
    standaloneGatewayProductionDatabaseSecurityIssue(teamPlaintext) || "",
    /DATABASE_SSL=true/,
  );

  const teamUnverified = loadStandaloneGatewayConfig({
    ...baseEnv,
    OPEN_COWORK_STANDALONE_GATEWAY_DEPLOYMENT_MODE: "team",
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL: "true",
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL_REJECT_UNAUTHORIZED: "false",
  });
  assert.throws(
    () => assertStandaloneGatewayProductionDatabaseSecurity(teamUnverified),
    /verified Postgres TLS/,
  );
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

test("standalone gateway config requires a dedicated absolute OpenCode runtime root", () => {
  assert.throws(() => loadStandaloneGatewayConfig({
    ...baseEnv,
    OPEN_COWORK_STANDALONE_GATEWAY_RUNTIME_ROOT: undefined,
  }), /RUNTIME_ROOT is required/);
  assert.throws(() => loadStandaloneGatewayConfig({
    ...baseEnv,
    OPEN_COWORK_STANDALONE_GATEWAY_RUNTIME_ROOT: "relative/workspace",
  }), /must be an absolute path/);
  assert.throws(() => loadStandaloneGatewayConfig({
    ...baseEnv,
    OPEN_COWORK_STANDALONE_GATEWAY_RUNTIME_ROOT: "/",
  }), /dedicated directory/);
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

test("standalone gateway defaults to the postgres store and requires a database url", () => {
  assert.equal(loadStandaloneGatewayConfig(baseEnv).store, "postgres");
  assert.throws(
    () => loadStandaloneGatewayConfig({ ...baseEnv, OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL: undefined }),
    /DATABASE_URL is required/,
  );
});

test("standalone gateway can run on an in-memory store without Postgres", () => {
  const config = loadStandaloneGatewayConfig({
    ...baseEnv,
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL: undefined,
    OPEN_COWORK_STANDALONE_GATEWAY_STORE: "memory",
    OPEN_COWORK_STANDALONE_GATEWAY_DEPLOYMENT_MODE: "team",
  });

  assert.equal(config.store, "memory");
  assert.equal(config.database.url, "");
  // The Postgres TLS gate is N/A for the in-memory store, even in team/enterprise mode.
  assert.equal(standaloneGatewayProductionDatabaseSecurityIssue(config), null);
  assert.doesNotThrow(() => assertStandaloneGatewayProductionDatabaseSecurity(config));
});

test("standalone gateway rejects an unknown store kind", () => {
  assert.throws(
    () => loadStandaloneGatewayConfig({ ...baseEnv, OPEN_COWORK_STANDALONE_GATEWAY_STORE: "sqlite" }),
    /Unsupported OPEN_COWORK_STANDALONE_GATEWAY_STORE/,
  );
});

test("standalone gateway merges file config with env vars taking precedence", () => {
  const fileJson = JSON.stringify({
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL: "postgres://file@127.0.0.1:5432/from-file",
    OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN: "file-admin-token",
    OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL: "http://127.0.0.1:4096",
    OPEN_COWORK_STANDALONE_GATEWAY_RUNTIME_ROOT: "/srv/open-cowork/runtime",
    OPEN_COWORK_STANDALONE_GATEWAY_RETENTION_JOB_DAYS: 7,
    OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_SHARED_SECRET: "file-webhook-secret",
    OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_DELIVERY_URL: "https://bridge.example.test/deliver",
  });
  const config = loadStandaloneGatewayConfig({
    OPEN_COWORK_STANDALONE_GATEWAY_CONFIG_JSON: fileJson,
    // Env overrides the file's database url; file-only keys (opencode, retention) still apply.
    OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL: "postgres://env@127.0.0.1:5432/from-env",
  });

  assert.equal(config.database.url, "postgres://env@127.0.0.1:5432/from-env");
  assert.equal(config.opencode.baseUrl, "http://127.0.0.1:4096");
  assert.equal(config.retention.jobDays, 7);
});

test("standalone gateway rejects a non-object config file", () => {
  assert.throws(
    () => loadStandaloneGatewayConfig({ ...baseEnv, OPEN_COWORK_STANDALONE_GATEWAY_CONFIG_JSON: "[1, 2, 3]" }),
    /must be a JSON object/,
  );
});
