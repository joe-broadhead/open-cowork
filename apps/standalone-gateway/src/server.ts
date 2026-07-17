import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { channelWebhookErrorCode, WebhookRateLimiter } from "@open-cowork/gateway-channel";
import { resolveHttpClientSource } from "@open-cowork/shared";

import { renderStandaloneGatewayDashboard, renderStandaloneGatewayMetrics } from "./dashboard.js";
import { runStandaloneGatewayDoctor, type StandaloneGatewayDoctorReport } from "./doctor.js";
import type { StandaloneOpenCodeAdapter } from "./opencode.js";
import type { StandaloneProviderRegistry } from "./provider-registry.js";
import type { StandaloneGatewayRepository } from "./repository.js";
import type { StandaloneGatewayConfig } from "./types.js";
import { redactSecretText } from "./redaction.js";

const maxWebhookBodyBytes = 1024 * 1024;
const webhookRateLimitWindowMs = 60_000;
const webhookRateLimitMaxRequests = 120;
const webhookAuthBackoffWindowMs = 60_000;
const webhookAuthBackoffMaxFailures = 20;
const webhookAuthBackoffMs = 60_000;
const standaloneHttpErrorMarker = Symbol("standalone-http-error");

type StandaloneHttpError = Error & {
  statusCode: number;
  publicMessage: string;
  retryAfterMs?: number;
  [standaloneHttpErrorMarker]: true;
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
  // Cache the readiness doctor behind a short TTL with single-flight (audit P1-G3): /ready is
  // unauthenticated and an anonymous caller could hammer it into repeated OpenCode round-trips +
  // identity scans. Bounds the real work to once per window regardless of probe rate.
  const cachedDoctor = createCachedDoctor(() => runStandaloneGatewayDoctor(input), READY_DOCTOR_CACHE_MS);
  const server = createServer((req, res) => {
    void handleRequest(input, req, res, webhookLimiter, cachedDoctor).catch((error) => {
      const responseError = publicErrorResponse(error);
      if (responseError.statusCode >= 500) logInternalError(error);
      writeJson(res, responseError.statusCode, { ok: false, error: responseError.message }, responseError.retryAfterMs ? {
        "retry-after": retryAfterSeconds(responseError.retryAfterMs),
      } : {});
    });
  });
  // Slowloris + connection-exhaustion guards (the body reader caps bytes, not time),
  // mirroring apps/gateway. This single daemon is internet-facing in webhook mode.
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 10_000;
  server.maxConnections = 1_024;
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

const READY_DOCTOR_CACHE_MS = 2_000;

// Short-TTL, single-flight cache around the readiness doctor. Concurrent probes within the window
// share one in-flight run, and the result is reused until it expires, so /ready can't be turned into
// a load amplifier (each run does an OpenCode round-trip + a DB readiness check).
export function createCachedDoctor(
  run: () => Promise<StandaloneGatewayDoctorReport>,
  ttlMs: number,
  now: () => number = () => Date.now(),
): () => Promise<StandaloneGatewayDoctorReport> {
  let cached: { at: number; report: StandaloneGatewayDoctorReport } | null = null;
  let inflight: Promise<StandaloneGatewayDoctorReport> | null = null;
  return () => {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.report);
    if (inflight) return inflight;
    inflight = run()
      .then((report) => { cached = { at: now(), report }; return report; })
      .finally(() => { inflight = null; });
    return inflight;
  };
}

async function handleRequest(input: {
  config: StandaloneGatewayConfig;
  repository: StandaloneGatewayRepository;
  opencode: StandaloneOpenCodeAdapter;
  providers: StandaloneProviderRegistry;
}, req: IncomingMessage, res: ServerResponse, webhookLimiter: WebhookRateLimiter, cachedDoctor: () => Promise<StandaloneGatewayDoctorReport>): Promise<void> {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, { ok: true, productMode: "standalone" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/ready") {
    const doctor = await cachedDoctor();
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
  const verdict = limiter.claim({
    key,
    nowMs: Date.now(),
    windowMs: webhookRateLimitWindowMs,
    maxRequests: webhookRateLimitMaxRequests,
  });
  if (!verdict.ok) {
    throw httpError(429, "Too many Standalone Gateway webhook requests. Try again later.", verdict.retryAfterMs);
  }
}

function enforceWebhookAuthBackoff(limiter: WebhookRateLimiter, key: string): void {
  const verdict = limiter.check({
    key,
    nowMs: Date.now(),
    windowMs: webhookAuthBackoffWindowMs,
  });
  if (!verdict.ok) {
    throw httpError(429, "Too many rejected Standalone Gateway webhook requests. Try again later.", verdict.retryAfterMs);
  }
}

function recordWebhookAuthFailure(limiter: WebhookRateLimiter, key: string): void {
  limiter.backoff({
    key,
    nowMs: Date.now(),
    windowMs: webhookAuthBackoffWindowMs,
    maxFailures: webhookAuthBackoffMaxFailures,
    backoffMs: webhookAuthBackoffMs,
  });
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
  const code = channelWebhookErrorCode(error);
  return code === "auth";
}

function logInternalError(error: unknown): void {
  const detail = error instanceof Error ? (error.stack || error.message) : String(error);
  process.stderr.write(`Standalone Gateway request failed: ${redactSecretText(detail)}\n`);
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
