import { readFileSync } from "node:fs";

import { normalizeChannelProviderIdentity, type ChannelProviderKind } from "@open-cowork/gateway-channel";
import { parseJsoncText, splitTrustedProxyCidrs } from "@open-cowork/shared";

import { assertPrivateBindHost, assertPrivateOpenCodeEndpoint } from "./network-policy.js";
import { normalizeStandaloneRuntimeRoot } from "./runtime-root.js";
import type { StandaloneGatewayConfig, StandaloneGatewayProviderConfig } from "./types.js";

export type StandaloneGatewayEnv = Record<string, string | undefined>;

const defaultHost = "127.0.0.1";
const defaultPort = 8795;

export function loadStandaloneGatewayConfig(rawEnv: StandaloneGatewayEnv = process.env): StandaloneGatewayConfig {
  const env = mergeStandaloneGatewayFileConfig(rawEnv);
  const store = readStoreKind(env.OPEN_COWORK_STANDALONE_GATEWAY_STORE);
  const databaseUrl = store === "postgres"
    ? readRequired(env.OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL, "OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL")
    : readString(env.OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_URL);
  const adminToken = readRequired(env.OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN, "OPEN_COWORK_STANDALONE_GATEWAY_ADMIN_TOKEN");
  const opencodeBaseUrl = readRequired(env.OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL, "OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_URL");
  const runtimeRoot = normalizeStandaloneRuntimeRoot(env.OPEN_COWORK_STANDALONE_GATEWAY_RUNTIME_ROOT);
  const allowPrivateDns = readBoolean(env.OPEN_COWORK_STANDALONE_GATEWAY_ALLOW_PRIVATE_DNS, false);
  const host = readString(env.OPEN_COWORK_STANDALONE_GATEWAY_HOST) || defaultHost;
  const publicBaseUrl = readNullable(env.OPEN_COWORK_STANDALONE_GATEWAY_PUBLIC_URL);
  const config: StandaloneGatewayConfig = {
    productMode: "standalone",
    store,
    deploymentMode: readDeploymentMode(env.OPEN_COWORK_STANDALONE_GATEWAY_DEPLOYMENT_MODE),
    server: {
      host,
      port: readPort(env.OPEN_COWORK_STANDALONE_GATEWAY_PORT, defaultPort),
      adminToken,
      publicBaseUrl,
      trustProxyHeaders: readBoolean(env.OPEN_COWORK_STANDALONE_GATEWAY_TRUST_PROXY_HEADERS, false),
      trustedProxyCidrs: splitTrustedProxyCidrs(env.OPEN_COWORK_STANDALONE_GATEWAY_TRUSTED_PROXY_CIDRS),
    },
    database: {
      url: databaseUrl,
      ssl: readBoolean(env.OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL, false),
      sslRejectUnauthorized: readBoolean(env.OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL_REJECT_UNAUTHORIZED, true),
      sslCaPath: readNullable(env.OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL_CA_PATH),
      sslCertPath: readNullable(env.OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL_CERT_PATH),
      sslKeyPath: readNullable(env.OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL_KEY_PATH),
    },
    opencode: {
      baseUrl: assertPrivateOpenCodeEndpoint(opencodeBaseUrl, { allowPrivateDns }).toString().replace(/\/$/, ""),
      allowPrivateDns,
      runtimeRoot,
      executionTimeoutMs: readInteger(
        env.OPEN_COWORK_STANDALONE_GATEWAY_OPENCODE_EXECUTION_TIMEOUT_MS,
        15 * 60 * 1000,
        1_000,
        24 * 60 * 60 * 1000,
      ),
    },
    retention: {
      sessionDays: readInteger(env.OPEN_COWORK_STANDALONE_GATEWAY_RETENTION_SESSION_DAYS, 90, 1, 3650),
      artifactDays: readInteger(env.OPEN_COWORK_STANDALONE_GATEWAY_RETENTION_ARTIFACT_DAYS, 30, 1, 3650),
      auditDays: readInteger(env.OPEN_COWORK_STANDALONE_GATEWAY_RETENTION_AUDIT_DAYS, 365, 1, 3650),
      jobDays: readInteger(env.OPEN_COWORK_STANDALONE_GATEWAY_RETENTION_JOB_DAYS, 30, 1, 3650),
    },
    providers: readProviders(env),
  };
  assertPrivateBindHost(host);
  if (publicBaseUrl && !adminToken) throw new Error("Public Standalone Gateway installs require an admin token.");
  if (isPlaceholderSecret(adminToken)) throw new Error("Standalone Gateway admin token is still a placeholder.");
  return config;
}

export function assertStandaloneGatewayProductionDatabaseSecurity(config: StandaloneGatewayConfig): void {
  const issue = standaloneGatewayProductionDatabaseSecurityIssue(config);
  if (issue) throw new Error(issue);
}

export function standaloneGatewayProductionDatabaseSecurityIssue(config: StandaloneGatewayConfig): string | null {
  if (config.store === "memory") return null;
  if (config.deploymentMode === "solo") return null;
  if (!config.database.ssl) {
    return `Standalone Gateway ${config.deploymentMode} deployments require OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL=true.`;
  }
  if (!config.database.sslRejectUnauthorized) {
    return `Standalone Gateway ${config.deploymentMode} deployments require verified Postgres TLS. Keep OPEN_COWORK_STANDALONE_GATEWAY_DATABASE_SSL_REJECT_UNAUTHORIZED=true.`;
  }
  return null;
}

function readProviders(env: StandaloneGatewayEnv): StandaloneGatewayProviderConfig[] {
  const providers: StandaloneGatewayProviderConfig[] = [];
  const telegramToken = readString(env.OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_BOT_TOKEN);
  if (telegramToken) {
    providers.push(providerConfig({
      id: readString(env.OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_PROVIDER_ID) || "telegram",
      kind: "telegram",
      channelBindingId: readString(env.OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_CHANNEL_BINDING_ID) || "telegram",
      credentials: { botToken: telegramToken, webhookSecret: readString(env.OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_WEBHOOK_SECRET) },
      settings: {
        mode: readString(env.OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_MODE) || "polling",
        publicBaseUrl: readString(env.OPEN_COWORK_STANDALONE_GATEWAY_TELEGRAM_PUBLIC_URL),
      },
    }));
  }
  const webhookSecret = readString(env.OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_SHARED_SECRET);
  const webhookDeliveryUrl = readString(env.OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_DELIVERY_URL);
  if (webhookSecret || webhookDeliveryUrl) {
    if (!webhookSecret) throw new Error("Standalone webhook provider requires OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_SHARED_SECRET.");
    if (!webhookDeliveryUrl) throw new Error("Standalone webhook provider requires OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_DELIVERY_URL.");
    providers.push(providerConfig({
      id: readString(env.OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_PROVIDER_ID) || "webhook",
      kind: "webhook",
      channelBindingId: readString(env.OPEN_COWORK_STANDALONE_GATEWAY_WEBHOOK_CHANNEL_BINDING_ID) || "webhook",
      credentials: { sharedSecret: webhookSecret },
      settings: { deliveryUrl: webhookDeliveryUrl },
    }));
  }
  if (providers.length === 0) {
    throw new Error("Standalone Gateway requires at least one provider such as Telegram or signed webhook.");
  }
  assertUniqueProviderIds(providers);
  return providers;
}

function providerConfig(input: {
  id: string;
  kind: ChannelProviderKind;
  channelBindingId: string;
  credentials: Record<string, string>;
  settings: Record<string, unknown>;
}): StandaloneGatewayProviderConfig {
  const identity = normalizeChannelProviderIdentity(input.kind, input.id);
  return {
    id: identity.providerId,
    kind: identity.providerKind,
    channelBindingId: input.channelBindingId,
    enabled: true,
    credentials: Object.fromEntries(Object.entries(input.credentials).filter(([, value]) => value.trim())),
    settings: Object.fromEntries(Object.entries(input.settings).filter(([, value]) => value !== "" && value !== null && value !== undefined)),
  };
}

function assertUniqueProviderIds(providers: StandaloneGatewayProviderConfig[]) {
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) throw new Error(`Duplicate standalone provider id ${provider.id}.`);
    seen.add(provider.id);
  }
}

function readString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readNullable(value: unknown): string | null {
  const text = readString(value);
  return text || null;
}

function readRequired(value: unknown, name: string): string {
  const text = readString(value);
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  const text = readString(value).toLowerCase();
  if (text === "true" || text === "1" || text === "yes") return true;
  if (text === "false" || text === "0" || text === "no") return false;
  return fallback;
}

function readInteger(value: unknown, fallback: number, min: number, max: number): number {
  const text = readString(value);
  const parsed = text ? Number(text) : fallback;
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readPort(value: unknown, fallback: number): number {
  return readInteger(value, fallback, 0, 65535);
}

function readDeploymentMode(value: unknown): StandaloneGatewayConfig["deploymentMode"] {
  const text = readString(value);
  return text === "team" || text === "enterprise" ? text : "solo";
}

function readStoreKind(value: unknown): StandaloneGatewayConfig["store"] {
  const text = readString(value).toLowerCase();
  if (text === "memory" || text === "in-memory" || text === "inmemory") return "memory";
  if (text === "" || text === "postgres" || text === "postgresql" || text === "pg") return "postgres";
  throw new Error(`Unsupported OPEN_COWORK_STANDALONE_GATEWAY_STORE ${text}. Use postgres or memory.`);
}

// Optional file-config layer: environment variables override file values. The file (path via
// OPEN_COWORK_STANDALONE_GATEWAY_CONFIG, or inline JSON via _CONFIG_JSON) is a flat JSON map of
// the same OPEN_COWORK_STANDALONE_GATEWAY_* keys, so downstream builders can ship config as a
// file instead of (or alongside) env vars — mirroring the Cloud Channel Gateway's file config.
function mergeStandaloneGatewayFileConfig(env: StandaloneGatewayEnv): StandaloneGatewayEnv {
  const layers: StandaloneGatewayEnv[] = [];
  const path = readString(env.OPEN_COWORK_STANDALONE_GATEWAY_CONFIG);
  if (path) layers.push(parseStandaloneGatewayConfigFile(readFileSync(path, "utf8"), path));
  const inline = readString(env.OPEN_COWORK_STANDALONE_GATEWAY_CONFIG_JSON);
  if (inline) layers.push(parseStandaloneGatewayConfigFile(inline, "OPEN_COWORK_STANDALONE_GATEWAY_CONFIG_JSON"));
  if (layers.length === 0) return env;
  return Object.assign({}, ...layers, env);
}

function parseStandaloneGatewayConfigFile(raw: string, source: string): StandaloneGatewayEnv {
  // parseJsoncText accepts JSONC and already enforces a top-level object, so a malformed file
  // or a non-object (array/primitive) surfaces as one clear, source-attributed error.
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsoncText(raw);
  } catch (error) {
    throw new Error(`Standalone Gateway config ${source} must be a JSON object of OPEN_COWORK_STANDALONE_GATEWAY_* keys: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const result: StandaloneGatewayEnv = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = String(value);
    } else {
      throw new Error(`Standalone Gateway config ${source} key ${key} must be a string, number, or boolean.`);
    }
  }
  return result;
}

function isPlaceholderSecret(value: string): boolean {
  return /^(change-me|replace-with|example-|demo-)/i.test(value.trim());
}
