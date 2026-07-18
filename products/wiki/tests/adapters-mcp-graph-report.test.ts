import { handleMcpRequest } from "@openwiki/mcp-server";
import { createWorkspace } from "@openwiki/repo";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("MCP graph report summarizes the permission-filtered wiki graph", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-mcp-graph-report-"));
  try {
    await createWorkspace(root, "MCP Graph Report Wiki");

    const result = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "wiki.graph_report",
        arguments: { limit: 5 },
      },
    });
    const content = (result as {
      structuredContent: { schema_version: string; hub_nodes: Array<{ id: string }>; suggested_questions: unknown[] };
    }).structuredContent;
    assert.equal(content.schema_version, "openwiki-graph-analysis-v1");
    assert.ok(content.hub_nodes.some((node) => node.id === "page:concept:agent-memory"));
    assert.ok(content.suggested_questions.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
