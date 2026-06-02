import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { resolveHttpClientSource } from "@open-cowork/shared";

import { renderStandaloneGatewayDashboard, renderStandaloneGatewayMetrics } from "./dashboard.js";
import { runStandaloneGatewayDoctor } from "./doctor.js";
import type { StandaloneOpenCodeAdapter } from "./opencode.js";
import type { StandaloneProviderRegistry } from "./provider-registry.js";
import type { StandaloneGatewayRepository } from "./repository.js";
import type { StandaloneGatewayConfig } from "./types.js";

const maxWebhookBodyBytes = 1024 * 1024;
const webhookRateLimitWindowMs = 60_000;
const webhookRateLimitMaxRequests = 120;
const webhookAuthBackoffWindowMs = 60_000;
const webhookAuthBackoffMaxFailures = 20;
const webhookAuthBackoffMs = 60_000;
const maxWebhookRateRecords = 10_000;
const standaloneHttpErrorMarker = Symbol("standalone-http-error");

interface WebhookRateRecord {
  count: number;
  resetAt: number;
  blockedUntil: number;
}

type StandaloneHttpError = Error & {
  statusCode: number;
  publicMessage: string;
  retryAfterMs?: number;
  [standaloneHttpErrorMarker]: true;
}

class WebhookRateLimiter {
  private readonly records = new Map<string, WebhookRateRecord>();

  claim(key: string, nowMs: number, windowMs: number, maxRequests: number): { ok: true } | { ok: false; retryAfterMs: number } {
    const record = this.record(key, nowMs, windowMs);
    if (record.blockedUntil > nowMs) return { ok: false, retryAfterMs: record.blockedUntil - nowMs };
    record.count += 1;
    if (record.count > maxRequests) {
      record.blockedUntil = Math.max(record.blockedUntil, record.resetAt);
      return { ok: false, retryAfterMs: record.blockedUntil - nowMs };
    }
    return { ok: true };
  }

  check(key: string, nowMs: number, windowMs: number): { ok: true } | { ok: false; retryAfterMs: number } {
    const record = this.record(key, nowMs, windowMs);
    if (record.blockedUntil > nowMs) return { ok: false, retryAfterMs: record.blockedUntil - nowMs };
    return { ok: true };
  }

  backoff(key: string, nowMs: number, windowMs: number, maxFailures: number, backoffMs: number): void {
    const record = this.record(key, nowMs, windowMs);
    record.count += 1;
    if (record.count >= maxFailures) {
      record.blockedUntil = Math.max(record.blockedUntil, nowMs + backoffMs);
    }
  }

  private record(key: string, nowMs: number, windowMs: number): WebhookRateRecord {
    const existing = this.records.get(key);
    if (existing && existing.resetAt > nowMs) return existing;
    const record = { count: 0, resetAt: nowMs + windowMs, blockedUntil: 0 };
    this.records.set(key, record);
    if (this.records.size > maxWebhookRateRecords) this.prune(nowMs);
    while (this.records.size > maxWebhookRateRecords) {
      const oldest = this.records.keys().next().value;
      if (!oldest) break;
      this.records.delete(oldest);
    }
    return record;
  }

  private prune(nowMs: number): void {
    for (const [key, record] of this.records) {
      if (record.resetAt <= nowMs && record.blockedUntil <= nowMs) this.records.delete(key);
    }
  }
}

export interface StandaloneGatewayServer {
  url(): string | null;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createStandaloneGatewayServer(input: {
  config: StandaloneGatewayConfig;
  repository: StandaloneGatewayRepository;
  opencode: StandaloneOpenCodeAdapter;
  providers: StandaloneProviderRegistry;
}): StandaloneGatewayServer {
  const webhookLimiter = new WebhookRateLimiter();
  const server = createServer((req, res) => {
    void handleRequest(input, req, res, webhookLimiter).catch((error) => {
      const responseError = publicErrorResponse(error);
      if (responseError.statusCode >= 500) logInternalError(error);
      writeJson(res, responseError.statusCode, { ok: false, error: responseError.message }, responseError.retryAfterMs ? {
        "retry-after": retryAfterSeconds(responseError.retryAfterMs),
      } : {});
    });
  });
  return {
    url() {
      const address = server.address();
      return typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : null;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(input.config.server.port, input.config.server.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

async function handleRequest(input: {
  config: StandaloneGatewayConfig;
  repository: StandaloneGatewayRepository;
  opencode: StandaloneOpenCodeAdapter;
  providers: StandaloneProviderRegistry;
}, req: IncomingMessage, res: ServerResponse, webhookLimiter: WebhookRateLimiter): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, { ok: true, productMode: "standalone" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/ready") {
    const doctor = await runStandaloneGatewayDoctor(input);
    writeJson(res, doctor.ok ? 200 : 503, isAdminRequest(input.config, req) ? doctor : { ok: doctor.ok });
    return;
  }
  if (req.method === "GET" && url.pathname === "/dashboard") {
    assertAdmin(input.config, req);
    const html = renderStandaloneGatewayDashboard(await input.repository.dashboardSnapshot());
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    });
    res.end(html);
    return;
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    assertAdmin(input.config, req);
    const metrics = renderStandaloneGatewayMetrics(await input.repository.dashboardSnapshot());
    res.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(metrics);
    return;
  }
  if (req.method === "POST" && url.pathname.startsWith("/webhooks/")) {
    const providerId = decodeURIComponent(url.pathname.slice("/webhooks/".length));
    const source = webhookSource(req, input.config.server.trustProxyHeaders, input.config.server.trustedProxyCidrs);
    enforceWebhookLimit(webhookLimiter, `request:${source}:${providerId}`);
    enforceWebhookAuthBackoff(webhookLimiter, `auth:${source}:${providerId}`);
    const rawBody = await readBody(req);
    const payload = parseJsonBody(rawBody);
    try {
      await input.providers.handleWebhook(providerId, payload, req.headers, rawBody);
    } catch (error) {
      if (isWebhookAuthFailure(error)) {
        recordWebhookAuthFailure(webhookLimiter, `auth:${source}:${providerId}`);
        throw httpError(401, "Standalone Gateway webhook verification failed.");
      }
      throw error;
    }
    writeJson(res, 202, { ok: true });
    return;
  }
  writeJson(res, 404, { ok: false, error: "not_found" });
}

function assertAdmin(config: StandaloneGatewayConfig, req: IncomingMessage): void {
  if (isAdminRequest(config, req)) return;
  throw httpError(401, "Standalone Gateway admin token required.");
}

function isAdminRequest(config: StandaloneGatewayConfig, req: IncomingMessage): boolean {
  const header = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  return constantTimeEqual(token, config.server.adminToken);
}

function enforceWebhookLimit(limiter: WebhookRateLimiter, key: string): void {
  const verdict = limiter.claim(key, Date.now(), webhookRateLimitWindowMs, webhookRateLimitMaxRequests);
  if (!verdict.ok) {
    throw httpError(429, "Too many Standalone Gateway webhook requests. Try again later.", verdict.retryAfterMs);
  }
}

function enforceWebhookAuthBackoff(limiter: WebhookRateLimiter, key: string): void {
  const verdict = limiter.check(key, Date.now(), webhookAuthBackoffWindowMs);
  if (!verdict.ok) {
    throw httpError(429, "Too many rejected Standalone Gateway webhook requests. Try again later.", verdict.retryAfterMs);
  }
}

function recordWebhookAuthFailure(limiter: WebhookRateLimiter, key: string): void {
  limiter.backoff(key, Date.now(), webhookAuthBackoffWindowMs, webhookAuthBackoffMaxFailures, webhookAuthBackoffMs);
}

function webhookSource(
  req: IncomingMessage,
  trustProxyHeaders = false,
  trustedProxyCidrs: readonly string[] | null | undefined = null,
): string {
  return resolveHttpClientSource({
    socketAddress: req.socket.remoteAddress,
    headers: req.headers,
    policy: { trustProxyHeaders, trustedProxyCidrs },
  });
}

function retryAfterSeconds(ms: number): string {
  return String(Math.max(1, Math.ceil(ms / 1000)));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxWebhookBodyBytes) {
        reject(httpError(413, `Standalone Gateway webhook body exceeds ${maxWebhookBodyBytes} bytes.`));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function parseJsonBody(rawBody: string): unknown {
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw httpError(400, "Standalone Gateway webhook body must be valid JSON.");
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function httpError(statusCode: number, message: string, retryAfterMs?: number): StandaloneHttpError {
  const error = new Error(message) as StandaloneHttpError;
  error.statusCode = statusCode;
  error.publicMessage = message;
  error.retryAfterMs = retryAfterMs;
  error[standaloneHttpErrorMarker] = true;
  return error;
}

function publicErrorResponse(error: unknown): { statusCode: number; message: string; retryAfterMs: number | null } {
  if (isStandaloneHttpError(error)) {
    return {
      statusCode: error.statusCode,
      message: error.publicMessage,
      retryAfterMs: typeof error.retryAfterMs === "number" ? error.retryAfterMs : null,
    };
  }
  return { statusCode: 500, message: "internal_server_error", retryAfterMs: null };
}

function isStandaloneHttpError(error: unknown): error is StandaloneHttpError {
  return error instanceof Error
    && (error as { [standaloneHttpErrorMarker]?: unknown })[standaloneHttpErrorMarker] === true
    && typeof (error as { statusCode?: unknown }).statusCode === "number"
    && typeof (error as { publicMessage?: unknown }).publicMessage === "string";
}

function isWebhookAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /signature|secret|authorization|authorized|token|timestamp|replay/i.test(message);
}

function logInternalError(error: unknown): void {
  const detail = error instanceof Error ? (error.stack || error.message) : String(error);
  process.stderr.write(`Standalone Gateway request failed: ${detail}\n`);
}

function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}
