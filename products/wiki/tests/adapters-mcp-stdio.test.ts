import { runMcpStdioServer } from "@openwiki/mcp-server";
import { createWorkspace } from "@openwiki/repo";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

test("MCP stdio transport handles parse errors, notifications, initialize, and tools list", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-mcp-stdio-"));
  try {
    await createWorkspace(root, "MCP Stdio Wiki");
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

    const server = runMcpStdioServer({ root, input, output, toolMode: "read" });
    input.write("{bad json\n");
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" })}\n`);
    input.end();
    await server;

    const responses = Buffer.concat(chunks)
      .toString("utf8")
      .trim()
      .split(/\n+/)
      .map((line) => JSON.parse(line) as { id?: string; error?: { code?: number }; result?: unknown });
    assert.equal(responses.length, 3);
    assert.equal(responses[0]?.error?.code, -32700);
    assert.equal(responses[1]?.id, "init");
    assert.equal((responses[1]?.result as { serverInfo?: { name?: string } }).serverInfo?.name, "openwiki");
    assert.equal(responses[2]?.id, "tools");
    assert.ok((responses[2]?.result as { tools?: Array<{ name: string }> }).tools?.some((tool) => tool.name === "wiki.search"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
