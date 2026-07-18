import http from "node:http";
import { MCP_PROTOCOL_VERSION } from "@openwiki/mcp-server";
import { createWorkspace } from "@openwiki/repo";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { routeMcpRequest, writeMcpHttpResponse } from "../packages/http-api/src/mcp-http.ts";
import { createMemoryMcpSessionStore, mcpHttpSessionExpired, type McpHttpRuntime } from "../packages/http-api/src/mcp-http-runtime.ts";

test("HTTP MCP runtime seam supports memory sessions, rate limits, and metrics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-http-mcp-runtime-seam-"));
  let now = 1_000;
  const sessionStore = createMemoryMcpSessionStore({ protocolVersion: MCP_PROTOCOL_VERSION, now: () => now });
  const metricEvents: string[] = [];
  const runtime: McpHttpRuntime = {
    sessionStore,
    rateLimiter: {
      async check() {
        return { allowed: true, bucket: "mcp", dimension: "anonymous", limit: 10, remaining: 9, resetAt: now + 1000 };
      },
      recordRejection() {
        metricEvents.push("rate-limited");
      },
    },
    metrics: {
      recordRequest() {
        metricEvents.push("request");
      },
      recordTool(tool, mode, status) {
        metricEvents.push(`${tool}:${mode}:${status}`);
      },
    },
    stream: { retryMs: 25, heartbeat: (date) => `: custom ${date.toISOString()}\n\n` },
  };
  try {
    await createWorkspace(root, "HTTP MCP Runtime Seam Wiki");
    const initialized = await routeMcpRequest(root, new URL("http://openwiki.local/mcp?tools=read"), {
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
    }, {}, { runtime });
    const sessionId = initialized.headers?.["MCP-Session-Id"];
    assert.ok(sessionId);

    const session = await sessionStore.read(root, sessionId);
    assert.ok(session);
    assert.equal(session.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(mcpHttpSessionExpired(session, now), false);
    now += 25 * 60 * 60 * 1000;
    assert.equal(await sessionStore.read(root, sessionId), undefined);

    const toolResult = await routeMcpRequest(root, new URL("http://openwiki.local/mcp?tools=read"), {
      jsonrpc: "2.0",
      id: "tools",
      method: "tools/call",
      params: { name: "wiki.search", arguments: { query: "agent" } },
    }, {}, { runtime });
    assert.equal(toolResult.status, 200);
    assert.ok(metricEvents.includes("wiki.search:read:success"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP MCP transport paths run through injected runtime seam", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-http-mcp-transport-runtime-"));
  const sessionStore = createMemoryMcpSessionStore();
  let denyNext = false;
  const runtime: McpHttpRuntime = {
    sessionStore,
    rateLimiter: {
      async check() {
        const allowed = !denyNext;
        denyNext = false;
        return { allowed, bucket: "mcp", dimension: "anonymous", limit: 1, remaining: allowed ? 1 : 0, resetAt: Date.now() + 1000 };
      },
      recordRejection() {},
    },
    metrics: { recordRequest() {}, recordTool() {} },
    stream: { retryMs: 25, heartbeat: (date) => `: custom ${date.toISOString()}\n\n` },
  };
  let server: http.Server | undefined;
  try {
    await createWorkspace(root, "HTTP MCP Transport Runtime Wiki");
    server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://openwiki.local");
      void writeMcpHttpResponse(root, request, response, url, {}, {}, runtime).catch((error: unknown) => {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : String(error));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const invalidProtocol = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "1900-01-01" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "bad", method: "tools/list" }),
    });
    assert.equal(invalidProtocol.status, 400);

    const initialize = await fetch(`${baseUrl}/mcp?tools=read`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": MCP_PROTOCOL_VERSION },
      body: JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize" }),
    });
    assert.equal(initialize.status, 200);
    const sessionId = initialize.headers.get("mcp-session-id");
    assert.ok(sessionId);

    const stream = await fetch(`${baseUrl}/mcp?once=true`, {
      headers: { accept: "text/event-stream", "mcp-protocol-version": MCP_PROTOCOL_VERSION, "mcp-session-id": sessionId },
    });
    assert.equal(stream.status, 200);
    assert.match(await stream.text(), /retry: 25/);

    const post = await fetch(`${baseUrl}/mcp?tools=read`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": MCP_PROTOCOL_VERSION, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
    });
    assert.equal(post.status, 200);

    denyNext = true;
    const limited = await fetch(`${baseUrl}/mcp?tools=read`, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": MCP_PROTOCOL_VERSION, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", id: "limited", method: "tools/list" }),
    });
    assert.equal(limited.status, 429);

    const deleted = await fetch(`${baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-protocol-version": MCP_PROTOCOL_VERSION, "mcp-session-id": sessionId },
    });
    assert.equal(deleted.status, 204);
  } finally {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    }
    await rm(root, { recursive: true, force: true });
  }
});
