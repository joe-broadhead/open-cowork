import { startHttpApi } from "@openwiki/http-api";
import { rebuildIndexStore } from "@openwiki/index-store";
import { MCP_PROTOCOL_VERSION } from "@openwiki/mcp-server";
import { hashOpenWikiToken, resolveServiceAccountToken } from "@openwiki/policy";
import { createWorkspace } from "@openwiki/repo";
import { buildSearchIndex } from "@openwiki/search";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { routeMcpRequest, type McpHttpSession, type McpSessionStore } from "../packages/http-api/src/mcp-http.ts";

const execFileAsync = promisify(execFile);

test("HTTP MCP route uses injected session runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-http-mcp-runtime-"));
  const sessions: McpHttpSession[] = [];
  const store: McpSessionStore = {
    async create(sessionRoot, toolMode) {
      const session: McpHttpSession = {
        id: "session:test-injected",
        root: sessionRoot,
        toolMode,
        protocolVersion: MCP_PROTOCOL_VERSION,
        createdAt: 1,
        updatedAt: 1,
      };
      sessions.push(session);
      return session;
    },
    async read(_sessionRoot, sessionId) {
      return sessions.find((session) => session.id === sessionId);
    },
    async touch(_sessionRoot, session) {
      session.updatedAt += 1;
    },
    async delete(_sessionRoot, sessionId) {
      const index = sessions.findIndex((session) => session.id === sessionId);
      if (index >= 0) {
        sessions.splice(index, 1);
      }
    },
    async expire() {},
  };
  try {
    await createWorkspace(root, "HTTP MCP Runtime Wiki");
    const result = await routeMcpRequest(root, new URL("http://openwiki.local/mcp?tools=read"), {
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
    }, {}, { runtime: { sessionStore: store } });

    assert.equal(result.status, 200);
    assert.equal(result.headers?.["MCP-Session-Id"], "session:test-injected");
    assert.equal(sessions.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP MCP endpoint supports Streamable HTTP transport", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-http-mcp-streamable-"));
  try {
    await createWorkspace(root, "HTTP MCP Wiki");
    await addServiceAccount(root, {
      id: "http-mcp-contributor",
      actor_id: "actor:agent:http-mcp-contributor",
      role: "contributor",
      token_hashes: [hashOpenWikiToken("http-mcp-contributor-secret")],
    });
    await addServiceAccount(root, {
      id: "http-mcp-maintainer",
      actor_id: "actor:agent:http-mcp-maintainer",
      role: "maintainer",
      token_hashes: [hashOpenWikiToken("http-mcp-maintainer-secret")],
    });
    await Promise.all([buildSearchIndex(root), rebuildIndexStore(root)]);

    const server = await startHttpApi({ root, port: 0 });
    try {
      const oneShot = await fetch(`${server.url}/mcp?tools=read`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "one-shot",
          method: "tools/list",
        }),
      });
      assert.equal(oneShot.status, 200);
      assert.equal(oneShot.headers.get("mcp-protocol-version"), MCP_PROTOCOL_VERSION);
      const oneShotBody = (await oneShot.json()) as { result: { tools: Array<{ name: string }> } };
      assert.ok(oneShotBody.result.tools.some((tool) => tool.name === "wiki.search"));

      const invalidOrigin = await fetch(`${server.url}/mcp?tools=read`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "bad-origin",
          method: "tools/list",
        }),
      });
      assert.equal(invalidOrigin.status, 403);
      const invalidOriginBody = (await invalidOrigin.json()) as { error: { message: string } };
      assert.match(invalidOriginBody.error.message, /Origin/);

      const invalidProtocol = await fetch(`${server.url}/mcp?tools=read`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": "1900-01-01",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "bad-protocol",
          method: "tools/list",
        }),
      });
      assert.equal(invalidProtocol.status, 400);
      const invalidProtocolBody = (await invalidProtocol.json()) as { error: { message: string } };
      assert.match(invalidProtocolBody.error.message, /Unsupported MCP protocol version/);

      const initialize = await fetch(`${server.url}/mcp?tools=read`, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "init",
          method: "initialize",
        }),
      });
      assert.equal(initialize.status, 200);
      assert.equal(initialize.headers.get("mcp-protocol-version"), MCP_PROTOCOL_VERSION);
      const sessionId = initialize.headers.get("mcp-session-id");
      assert.ok(sessionId);
      const initializeBody = (await initialize.json()) as { result: { protocolVersion: string } };
      assert.equal(initializeBody.result.protocolVersion, MCP_PROTOCOL_VERSION);

      const missingSession = await fetch(`${server.url}/mcp`, {
        headers: {
          accept: "text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
      });
      assert.equal(missingSession.status, 400);
      const missingSessionBody = (await missingSession.json()) as { error: { message: string } };
      assert.match(missingSessionBody.error.message, /MCP-Session-Id/);

      const unknownSession = await fetch(`${server.url}/mcp`, {
        headers: {
          accept: "text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          "mcp-session-id": "unknown-session",
        },
      });
      assert.equal(unknownSession.status, 404);

      const unsupportedGet = await fetch(`${server.url}/mcp`, {
        headers: {
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          "mcp-session-id": sessionId,
        },
      });
      assert.equal(unsupportedGet.status, 406);

      const stream = await fetch(`${server.url}/mcp?once=true`, {
        headers: {
          accept: "text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          "mcp-session-id": sessionId,
        },
      });
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.equal(stream.headers.get("mcp-session-id"), sessionId);
      const streamText = await stream.text();
      assert.match(streamText, /retry: 15000/);
      assert.match(streamText, /: openwiki mcp stream/);

      const sseTools = await fetch(`${server.url}/mcp?tools=read`, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "sse-tools",
          method: "tools/list",
        }),
      });
      assert.equal(sseTools.status, 200);
      assert.match(sseTools.headers.get("content-type") ?? "", /text\/event-stream/);
      const sseToolsText = await sseTools.text();
      assert.match(sseToolsText, /event: message/);
      assert.match(sseToolsText, /"id":"sse-tools"/);
      assert.match(sseToolsText, /wiki\.search/);

      const readWithToken = await fetch(`${server.url}/mcp?tools=read`, {
        method: "POST",
        headers: {
          authorization: "Bearer http-mcp-contributor-secret",
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "read-token",
          method: "tools/call",
          params: {
            name: "wiki.read_page",
            arguments: { id: "page:concept:agent-memory" },
          },
        }),
      });
      assert.equal(readWithToken.status, 200);
      const readWithTokenBody = (await readWithToken.json()) as { result?: unknown; error?: unknown };
      assert.equal(readWithTokenBody.error, undefined);
      assert.ok(readWithTokenBody.result);

      const proposalWithToken = await fetch(`${server.url}/mcp?tools=proposal`, {
        method: "POST",
        headers: {
          authorization: "Bearer http-mcp-contributor-secret",
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "proposal-token",
          method: "tools/call",
          params: {
            name: "wiki.propose_edit",
            arguments: {
              page_id: "page:concept:agent-memory",
              body: "# Agent Memory\n\nStreamable HTTP MCP clients can propose edits with service-account tokens.",
              rationale: "Exercise HTTP MCP proposal auth.",
            },
          },
        }),
      });
      assert.equal(proposalWithToken.status, 200);
      const proposalWithTokenBody = (await proposalWithToken.json()) as { result?: unknown; error?: unknown };
      assert.equal(proposalWithTokenBody.error, undefined);
      assert.ok(proposalWithTokenBody.result);

      const inboxSubmitWithToken = await fetch(`${server.url}/mcp?tools=proposal`, {
        method: "POST",
        headers: {
          authorization: "Bearer http-mcp-contributor-secret",
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "inbox-submit-token",
          method: "tools/call",
          params: {
            name: "wiki.inbox_submit",
            arguments: {
              title: "Remote MCP transcript",
              content: "Hosted HTTP MCP agents can submit owned inbox material.",
              kind: "meeting_transcript",
              provider: "transcript_file",
            },
          },
        }),
      });
      assert.equal(inboxSubmitWithToken.status, 200);
      const inboxSubmitWithTokenBody = (await inboxSubmitWithToken.json()) as {
        result?: { structuredContent?: { item?: { id?: string; owner_actor_id?: string } } };
        error?: unknown;
      };
      assert.equal(inboxSubmitWithTokenBody.error, undefined);
      const inboxItemId = inboxSubmitWithTokenBody.result?.structuredContent?.item?.id;
      assert.ok(inboxItemId);
      assert.equal(inboxSubmitWithTokenBody.result?.structuredContent?.item?.owner_actor_id, "actor:agent:http-mcp-contributor");

      const inboxReadWithToken = await fetch(`${server.url}/mcp?tools=read`, {
        method: "POST",
        headers: {
          authorization: "Bearer http-mcp-contributor-secret",
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "inbox-read-token",
          method: "tools/call",
          params: {
            name: "wiki.inbox_read",
            arguments: { id: inboxItemId, include_content: true },
          },
        }),
      });
      assert.equal(inboxReadWithToken.status, 200);
      const inboxReadWithTokenBody = (await inboxReadWithToken.json()) as { result?: unknown; error?: unknown };
      assert.equal(inboxReadWithTokenBody.error, undefined);
      assert.ok(inboxReadWithTokenBody.result);

      const proposalProcessDenied = await fetch(`${server.url}/mcp?tools=proposal`, {
        method: "POST",
        headers: {
          authorization: "Bearer http-mcp-contributor-secret",
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "inbox-process-proposal-denied",
          method: "tools/call",
          params: {
            name: "wiki.inbox_process",
            arguments: { id: inboxItemId, dry_run: true },
          },
        }),
      });
      assert.equal(proposalProcessDenied.status, 200);
      const proposalProcessDeniedBody = (await proposalProcessDenied.json()) as { error: { code: number; message: string } };
      assert.equal(proposalProcessDeniedBody.error.code, -32603);
      assert.match(proposalProcessDeniedBody.error.message, /not enabled/);

      const writeProcessDenied = await fetch(`${server.url}/mcp?tools=write`, {
        method: "POST",
        headers: {
          authorization: "Bearer http-mcp-contributor-secret",
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "inbox-process-write-denied",
          method: "tools/call",
          params: {
            name: "wiki.inbox_process",
            arguments: { id: inboxItemId, dry_run: true },
          },
        }),
      });
      assert.equal(writeProcessDenied.status, 200);
      const writeProcessDeniedBody = (await writeProcessDenied.json()) as { error: { code: number; message: string } };
      assert.equal(writeProcessDeniedBody.error.code, -32001);
      assert.match(writeProcessDeniedBody.error.message, /wiki:inbox:process/);

      const applyDenied = await fetch(`${server.url}/mcp?tools=write`, {
        method: "POST",
        headers: {
          authorization: "Bearer http-mcp-contributor-secret",
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "apply-write-denied",
          method: "tools/call",
          params: {
            name: "wiki.apply_proposal",
            arguments: { proposal_id: "proposal:missing" },
          },
        }),
      });
      assert.equal(applyDenied.status, 200);
      const applyDeniedBody = (await applyDenied.json()) as { error: { code: number; message: string } };
      assert.equal(applyDeniedBody.error.code, -32001);
      assert.match(applyDeniedBody.error.message, /wiki:commit/);

      const deniedWrite = await fetch(`${server.url}/mcp?tools=write`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "denied-write",
          method: "tools/call",
          params: {
            name: "wiki.run_lint",
            arguments: {},
          },
        }),
      });
      assert.equal(deniedWrite.status, 200);
      const deniedWriteBody = (await deniedWrite.json()) as { error: { code: number; message: string } };
      assert.equal(deniedWriteBody.error.code, -32001);
      assert.match(deniedWriteBody.error.message, /wiki:patch/);

      const writeWithToken = await fetch(`${server.url}/mcp?tools=write`, {
        method: "POST",
        headers: {
          authorization: "Bearer http-mcp-maintainer-secret",
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "write-token",
          method: "tools/call",
          params: {
            name: "wiki.run_lint",
            arguments: {},
          },
        }),
      });
      assert.equal(writeWithToken.status, 200);
      const writeWithTokenBody = (await writeWithToken.json()) as {
        result: { structuredContent: { status: string } };
      };
      assert.equal(writeWithTokenBody.result.structuredContent.status, "passed");

      const deleteSession = await fetch(`${server.url}/mcp`, {
        method: "DELETE",
        headers: {
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          "mcp-session-id": sessionId,
        },
      });
      assert.equal(deleteSession.status, 204);

      const deletedSession = await fetch(`${server.url}/mcp`, {
        headers: {
          accept: "text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          "mcp-session-id": sessionId,
        },
      });
      assert.equal(deletedSession.status, 404);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP trusted identity headers require a proxy shared secret", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-http-trusted-headers-"));
  try {
    await createWorkspace(root, "Trusted Header Wiki");
    await assert.rejects(
      () =>
        startHttpApi({
          root,
          port: 0,
          defaultPolicy: {
            trustHeaders: true,
          },
        }),
      /Trusted auth headers require OPENWIKI_TRUST_AUTH_HEADERS_SECRET/,
    );
    await assert.rejects(
      () =>
        startHttpApi({
          root,
          port: 0,
          defaultPolicy: {
            trustHeaders: true,
            trustedHeaderSecret: "short",
          },
        }),
      /at least 16 characters/,
    );
    const server = await startHttpApi({
      root,
      port: 0,
      defaultPolicy: {
        trustHeaders: true,
        trustedHeaderSecret: "proxy-shared-secret",
      },
    });
    try {
      const untrusted = await fetch(`${server.url}/api/v1/policy`, {
        headers: {
          "x-openwiki-role": "admin",
        },
      });
      assert.equal(untrusted.status, 403);

      const wrongSecret = await fetch(`${server.url}/api/v1/policy`, {
        headers: {
          "x-openwiki-role": "admin",
          "x-openwiki-proxy-secret": "wrong-secret",
        },
      });
      assert.equal(wrongSecret.status, 403);

      const trusted = await fetch(`${server.url}/api/v1/policy`, {
        headers: {
          "x-openwiki-role": "admin",
          "x-openwiki-groups": "finance platform",
          "x-openwiki-proxy-secret": "proxy-shared-secret",
        },
      });
      assert.equal(trusted.status, 200);

      const trustedPreview = await fetch(
        `${server.url}/api/v1/policy/preview?group=finance&target_path=${encodeURIComponent("wiki/concepts/agent-memory.md")}`,
        {
          headers: {
            "x-openwiki-role": "admin",
            "x-openwiki-groups": "finance platform",
            "x-openwiki-proxy-secret": "proxy-shared-secret",
          },
        },
      );
      assert.equal(trustedPreview.status, 200);
      assert.match(await trustedPreview.text(), /group:finance/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI serve rejects trusted headers without a configured shared secret", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-trusted-headers-"));
  try {
    await createWorkspace(root, "Trusted Header CLI Wiki");
    try {
      await execFileAsync(
        process.execPath,
        [
          "--no-warnings",
          "--import",
          "tsx",
          path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
          "--root",
          root,
          "serve",
          "--trust-headers",
          "--port",
          "0",
        ],
        {
          env: {
            ...process.env,
            OPENWIKI_TRUST_AUTH_HEADERS_SECRET: "",
          },
          timeout: 10_000,
        },
      );
      assert.fail("Expected trusted-header serve startup to fail without a shared secret");
    } catch (error) {
      const output = errorOutput(error);
      assert.match(output, /Trusted auth headers require OPENWIKI_TRUST_AUTH_HEADERS_SECRET/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted proxy origin requires a shared proxy secret", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-proxy-origin-"));
  const oldTrustProxyOrigin = process.env.OPENWIKI_TRUST_PROXY_ORIGIN;
  const oldTrustProxyOriginSecret = process.env.OPENWIKI_TRUST_PROXY_ORIGIN_SECRET;
  const oldTrustAuthSecret = process.env.OPENWIKI_TRUST_AUTH_HEADERS_SECRET;
  try {
    await createWorkspace(root, "Trusted Proxy Origin Wiki");
    process.env.OPENWIKI_TRUST_PROXY_ORIGIN = "1";
    delete process.env.OPENWIKI_TRUST_PROXY_ORIGIN_SECRET;
    delete process.env.OPENWIKI_TRUST_AUTH_HEADERS_SECRET;

    await assert.rejects(
      () => startHttpApi({ root, port: 0 }),
      /Trusted proxy origin requires OPENWIKI_TRUST_PROXY_ORIGIN_SECRET/,
    );
    process.env.OPENWIKI_TRUST_PROXY_ORIGIN_SECRET = "proxy-origin-secret";

    const server = await startHttpApi({ root, port: 0 });
    try {
      const untrustedForwardedOrigin = await fetch(`${server.url}/mcp?tools=read`, {
        method: "POST",
        headers: {
          origin: "https://wiki.example.com",
          host: "openwiki.internal",
          "x-forwarded-host": "wiki.example.com",
          "x-forwarded-proto": "https",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
      });
      assert.equal(untrustedForwardedOrigin.status, 403);

      const trustedForwardedOrigin = await fetch(`${server.url}/mcp?tools=read`, {
        method: "POST",
        headers: {
          origin: "https://wiki.example.com",
          host: "openwiki.internal",
          "x-forwarded-host": "wiki.example.com",
          "x-forwarded-proto": "https",
          "x-openwiki-proxy-secret": "proxy-origin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
      });
      assert.equal(trustedForwardedOrigin.status, 200);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    restoreEnv("OPENWIKI_TRUST_PROXY_ORIGIN", oldTrustProxyOrigin);
    restoreEnv("OPENWIKI_TRUST_PROXY_ORIGIN_SECRET", oldTrustProxyOriginSecret);
    restoreEnv("OPENWIKI_TRUST_AUTH_HEADERS_SECRET", oldTrustAuthSecret);
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI rejects raw bearer tokens on the command line", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-token-"));
  try {
    await createWorkspace(root, "CLI Token Wiki");
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "--no-warnings",
          "--import",
          "tsx",
          path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
          "--root",
          root,
          "mcp",
          "--stdio",
          "--token",
          "raw-service-token",
        ],
        { timeout: 2000 },
      ),
      /--token is disabled/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service-account token hashes are not accepted as bearer tokens", () => {
  const tokenHash = hashOpenWikiToken("raw-service-token");
  const config = {
    auth: {
      service_accounts: [
        {
          id: "service-account:test",
          actor_id: "actor:agent:test",
          scopes: ["wiki:read"],
          token_hashes: [tokenHash],
        },
      ],
    },
  } as Parameters<typeof resolveServiceAccountToken>[0];

  assert.equal(resolveServiceAccountToken(config, "raw-service-token")?.serviceAccountId, "service-account:test");
  assert.equal(resolveServiceAccountToken(config, tokenHash), undefined);
});

async function addServiceAccount(root: string, serviceAccount: Record<string, unknown>): Promise<void> {
  const configPath = path.join(root, "openwiki.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    auth?: { service_accounts?: Array<Record<string, unknown>> };
  };
  config.auth = {
    service_accounts: [...(config.auth?.service_accounts ?? []), serviceAccount],
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function errorOutput(error: unknown): string {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.stdout === "string") {
      parts.push(record.stdout);
    }
    if (typeof record.stderr === "string") {
      parts.push(record.stderr);
    }
  }
  return parts.join("\n");
}
