#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHttpApi } from "@openwiki/http-api";
import { handleMcpRequest, MCP_PROTOCOL_VERSION } from "@openwiki/mcp-server";
import { mcpToolOperationsForMode } from "@openwiki/policy";
import { createWorkspace } from "@openwiki/repo";
import { buildSearchIndex } from "@openwiki/search";
import { rebuildIndexStore } from "@openwiki/index-store";
import { createServiceAccountToken } from "@openwiki/workflows";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = [process.execPath, ["--no-warnings", "--import", "tsx", path.join(REPO_ROOT, "packages", "cli", "src", "main.ts")]];

try {
  const report = await runMcpConformance();
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}

async function runMcpConformance() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-mcp-conformance-"));
  const root = path.join(tempRoot, "wiki");
  const previousOutputLimit = process.env.OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES;
  const checks = [];
  try {
    await createWorkspace(root, { title: "MCP Conformance Wiki", template: "team-wiki" });
    await installConformanceFixture(root);
    await Promise.all([buildSearchIndex(root), rebuildIndexStore(root)]);

    const proposalToken = await createServiceAccountToken({
      root,
      profile: "proposal-agent",
      id: "service:mcp-conformance-proposal",
      description: "MCP conformance proposal-mode agent",
      tokenDescription: "MCP conformance proposal token",
      expiresInDays: 1,
      auditActorId: "actor:eval:mcp-conformance",
    });
    const maintainerToken = await createServiceAccountToken({
      root,
      profile: "maintainer-automation",
      id: "service:mcp-conformance-maintainer",
      description: "MCP conformance write-mode agent",
      tokenDescription: "MCP conformance write token",
      expiresInDays: 1,
      auditActorId: "actor:eval:mcp-conformance",
    });

    await assertStdioSmoke(root);
    checks.push("stdio smoke");
    await assertToolModeParity(root);
    checks.push("tool mode parity");

    const server = await startHttpApi({ root, port: 0 });
    try {
      await assertHttpStreamableMcp(server.url, proposalToken.token.value, maintainerToken.token.value);
      checks.push("http streamable session lifecycle");
      await assertAuthAndPolicy(server.url, proposalToken.token.value);
      checks.push("auth denial and permission filtering");
      await assertProposalHappyPath(server.url, proposalToken.token.value);
      checks.push("proposal happy path");
      process.env.OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES = "2048";
      await assertLargeResponseTruncation(server.url, proposalToken.token.value);
      checks.push("large response truncation");
    } finally {
      await closeServer(server.server);
    }

    return {
      eval: "openwiki-mcp-conformance",
      status: "pass",
      checks,
    };
  } finally {
    if (previousOutputLimit === undefined) {
      delete process.env.OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES;
    } else {
      process.env.OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES = previousOutputLimit;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function installConformanceFixture(root) {
  await mkdir(path.join(root, "wiki", "private"), { recursive: true });
  await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await writeFile(
    path.join(root, "wiki", "concepts", "agent-memory.md"),
    pageMarkdown({
      id: "page:concept:agent-memory",
      title: "Agent Memory",
      pageType: "concept",
      summary: "Agent-facing MCP conformance page.",
      topics: ["mcp", "agents"],
      body: "Agent memory gives MCP clients a stable page for search, read, and proposal conformance checks.",
    }),
  );
  await writeFile(
    path.join(root, "wiki", "private", "agent-secret.md"),
    pageMarkdown({
      id: "page:private:agent-secret",
      title: "Agent Secret",
      pageType: "concept",
      summary: "Private MCP conformance fixture.",
      topics: ["mcp", "private"],
      body: "MCP_PRIVATE_CONFORMANCE_SECRET must never be returned to unauthorized agents.",
    }),
  );
  await writeFile(
    path.join(root, "wiki", "concepts", "large-agent-output.md"),
    pageMarkdown({
      id: "page:concept:large-agent-output",
      title: "Large Agent Output",
      pageType: "concept",
      summary: "Large MCP conformance fixture.",
      topics: ["mcp", "large-output"],
      body: "Large MCP conformance content.\n".repeat(300) + "\nMCP_CONFORMANCE_TAIL_SHOULD_BE_TRUNCATED",
    }),
  );
  await writeFile(
    path.join(root, "policy", "sections.json"),
    JSON.stringify(
      [
        {
          id: "section:agent-readable",
          title: "Agent Readable",
          paths: ["wiki/concepts/**", "sources/**", "claims/**", "proposals/**", "decisions/**", "events/**", "runs/**"],
          visibility: "internal",
        },
        {
          id: "section:agent-private",
          title: "Agent Private",
          paths: ["wiki/private/**"],
          visibility: "private",
        },
      ],
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(root, "policy", "grants.json"),
    JSON.stringify(
      [
        {
          principal: "group:all-users",
          section: "section:agent-readable",
          role: "contributor",
        },
      ],
      null,
      2,
    ) + "\n",
  );
}

function pageMarkdown(input) {
  return [
    "---",
    `id: ${input.id}`,
    `title: ${input.title}`,
    `page_type: ${input.pageType}`,
    `summary: ${input.summary}`,
    "sensitivity: internal",
    "topics:",
    ...input.topics.map((topic) => `  - ${topic}`),
    "source_ids: []",
    "claim_ids: []",
    "---",
    "",
    `# ${input.title}`,
    "",
    input.body,
    "",
  ].join("\n");
}

async function assertStdioSmoke(root) {
  const child = spawn(CLI[0], [...CLI[1], "--root", root, "mcp", "--stdio", "--tools", "proposal"], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  try {
    const responses = readJsonLines(child.stdout);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" })}\n`);
    const response = await waitForJsonRpcResponse(responses, "tools", 5000);
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.ok(response.result?.tools?.some((tool) => tool.name === "wiki.propose_edit"));
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    await waitForExit(child).catch(() => undefined);
  }
  assert.equal(stderr.join("").trim(), "");
}

async function assertToolModeParity(root) {
  for (const mode of ["read", "proposal", "write"]) {
    const response = await handleMcpRequest(root, { jsonrpc: "2.0", id: mode, method: "tools/list" }, { toolMode: mode });
    const actual = response.tools.map((tool) => tool.name).sort();
    const expected = mcpToolOperationsForMode(mode).sort();
    assert.deepEqual(actual, expected, mode);
  }
}

async function assertHttpStreamableMcp(baseUrl, proposalToken, maintainerToken) {
  const initialize = await mcpFetch(baseUrl, "proposal", {
    id: "init",
    method: "initialize",
    token: proposalToken,
    accept: "application/json, text/event-stream",
  });
  assert.equal(initialize.response.status, 200);
  const sessionId = initialize.response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  assert.equal(initialize.body.result.protocolVersion, MCP_PROTOCOL_VERSION);

  const stream = await fetch(`${baseUrl}/mcp?once=true`, {
    headers: {
      accept: "text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-session-id": sessionId,
      authorization: `Bearer ${proposalToken}`,
    },
  });
  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /openwiki mcp stream/);

  const writeTools = await mcpFetch(baseUrl, "write", {
    id: "write-tools",
    method: "tools/list",
    token: maintainerToken,
  });
  assert.equal(writeTools.body.error, undefined, JSON.stringify(writeTools.body.error));
  assert.ok(writeTools.body.result.tools.some((tool) => tool.name === "wiki.review_proposal"));

  const deleted = await fetch(`${baseUrl}/mcp`, {
    method: "DELETE",
    headers: {
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "mcp-session-id": sessionId,
      authorization: `Bearer ${proposalToken}`,
    },
  });
  assert.equal(deleted.status, 204);
}

async function assertAuthAndPolicy(baseUrl, proposalToken) {
  const denied = await mcpFetch(baseUrl, "proposal", {
    id: "denied-proposal",
    method: "tools/call",
    params: {
      name: "wiki.propose_edit",
      arguments: {
        page_id: "page:concept:agent-memory",
        body: "# Agent Memory\n\nAnonymous hosted MCP callers must not propose.",
        rationale: "Auth denial check.",
      },
    },
  });
  assert.equal(denied.body.error.code, -32001);
  assert.doesNotMatch(JSON.stringify(denied.body), /MCP_PRIVATE_CONFORMANCE_SECRET/);

  const filtered = await mcpFetch(baseUrl, "read", {
    id: "private-search",
    method: "tools/call",
    token: proposalToken,
    params: {
      name: "wiki.search",
      arguments: { query: "MCP_PRIVATE_CONFORMANCE_SECRET", limit: 10 },
    },
  });
  assert.equal(filtered.body.error, undefined, JSON.stringify(filtered.body.error));
  assert.doesNotMatch(JSON.stringify(filtered.body), /MCP_PRIVATE_CONFORMANCE_SECRET|page:private:agent-secret/);
}

async function assertProposalHappyPath(baseUrl, proposalToken) {
  const proposal = await mcpFetch(baseUrl, "proposal", {
    id: "proposal-happy-path",
    method: "tools/call",
    token: proposalToken,
    params: {
      name: "wiki.propose_edit",
      arguments: {
        page_id: "page:concept:agent-memory",
        body: "# Agent Memory\n\nHTTP MCP proposal-mode agents can propose bounded, governed edits.",
        rationale: "MCP conformance proposal happy path.",
      },
    },
  });
  assert.equal(proposal.body.error, undefined, JSON.stringify(proposal.body.error));
  assert.match(proposal.body.result.structuredContent.proposal.id, /^proposal:/);
}

async function assertLargeResponseTruncation(baseUrl, proposalToken) {
  const large = await mcpFetch(baseUrl, "read", {
    id: "large-output",
    method: "tools/call",
    token: proposalToken,
    params: {
      name: "wiki.read_page",
      arguments: { id: "page:concept:large-agent-output" },
    },
  });
  assert.equal(large.body.error, undefined, JSON.stringify(large.body.error));
  assert.equal(large.body.result.structuredContent.truncated, true);
  assert.equal(large.body.result.structuredContent.output_limit_bytes, 2048);
  assert.match(large.body.result.content[0].text, /OpenWiki MCP output truncated/);
  assert.doesNotMatch(large.body.result.content[0].text, /MCP_CONFORMANCE_TAIL_SHOULD_BE_TRUNCATED/);
}

async function mcpFetch(baseUrl, mode, input) {
  const headers = {
    "content-type": "application/json",
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    ...(input.accept === undefined ? {} : { accept: input.accept }),
    ...(input.token === undefined ? {} : { authorization: `Bearer ${input.token}` }),
  };
  const response = await fetch(`${baseUrl}/mcp?tools=${mode}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: input.id,
      method: input.method,
      ...(input.params === undefined ? {} : { params: input.params }),
    }),
  });
  return { response, body: await response.json() };
}

function readJsonLines(stream) {
  const queue = [];
  const waiters = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const parsed = JSON.parse(line);
        const waiter = waiters.shift();
        if (waiter) {
          waiter(parsed);
        } else {
          queue.push(parsed);
        }
      }
      newline = buffer.indexOf("\n");
    }
  });
  return {
    next() {
      const value = queue.shift();
      if (value !== undefined) {
        return Promise.resolve(value);
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function waitForJsonRpcResponse(responses, id, timeoutMs) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Timed out waiting for MCP response '${id}'`)), timeoutMs);
  });
  while (true) {
    const response = await Promise.race([responses.next(), timeout]);
    if (response.id === id) {
      return response;
    }
  }
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.on("exit", () => resolve());
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
