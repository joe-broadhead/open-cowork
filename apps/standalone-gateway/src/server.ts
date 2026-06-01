import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

import { renderStandaloneGatewayDashboard, renderStandaloneGatewayMetrics } from "./dashboard.js";
import { runStandaloneGatewayDoctor } from "./doctor.js";
import type { StandaloneOpenCodeAdapter } from "./opencode.js";
import type { StandaloneProviderRegistry } from "./provider-registry.js";
import type { StandaloneGatewayRepository } from "./repository.js";
import type { StandaloneGatewayConfig } from "./types.js";

const maxWebhookBodyBytes = 1024 * 1024;

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
  const server = createServer((req, res) => {
    void handleRequest(input, req, res).catch((error) => {
      writeJson(res, error.statusCode || 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
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
}, req: IncomingMessage, res: ServerResponse): Promise<void> {
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
    const rawBody = await readBody(req);
    const payload = parseJsonBody(rawBody);
    await input.providers.handleWebhook(providerId, payload, req.headers, rawBody);
    writeJson(res, 202, { ok: true });
    return;
  }
  writeJson(res, 404, { ok: false, error: "not_found" });
}

function assertAdmin(config: StandaloneGatewayConfig, req: IncomingMessage): void {
  if (isAdminRequest(config, req)) return;
  const error = new Error("Standalone Gateway admin token required.") as Error & { statusCode: number };
  error.statusCode = 401;
  throw error;
}

function isAdminRequest(config: StandaloneGatewayConfig, req: IncomingMessage): boolean {
  const header = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  return constantTimeEqual(token, config.server.adminToken);
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

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
