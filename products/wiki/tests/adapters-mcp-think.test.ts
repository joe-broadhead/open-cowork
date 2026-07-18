import { routeHttpRequest } from "@openwiki/http-api";
import { handleMcpRequest } from "@openwiki/mcp-server";
import { createWorkspace } from "@openwiki/repo";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("MCP adapter exposes deterministic wiki.think synthesis", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-mcp-think-"));
  try {
    await createWorkspace(root, "MCP Think Wiki");

    const tools = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const toolNames = (tools as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name);
    assert.ok(toolNames.includes("wiki.think"));

    const think = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "wiki.think",
        arguments: { question: "How does OpenWiki store agent memory?", limit: 3 },
      },
    });
    const structured = (think as {
      structuredContent: {
        diagnostics: { retrieval: { retrievers_used?: string[] }; synthesis: { provider: string } };
        citations: Array<{ id: string }>;
        search: { explain?: unknown };
      };
    }).structuredContent;
    assert.equal(structured.diagnostics.synthesis.provider, "deterministic");
    assert.equal(structured.search.explain, undefined);
    assert.equal(structured.diagnostics.retrieval.retrievers_used?.length ?? 0, 0);
    assert.equal(structured.citations[0]?.id, "source:2026-05-21-001");

    const explained = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "wiki.think",
        arguments: { question: "How does OpenWiki store agent memory?", limit: 3, include_explain: true },
      },
    });
    const explainedStructured = (explained as {
      structuredContent: {
        diagnostics: { retrieval: { retrievers_used?: string[] } };
        search: { explain?: unknown };
      };
    }).structuredContent;
    assert.equal(explainedStructured.search.explain, undefined);
    assert.ok((explainedStructured.diagnostics.retrieval.retrievers_used?.length ?? 0) > 0);

    const http = await routeHttpRequest(root, "POST", "/api/v1/think", {
      question: "How does OpenWiki store agent memory?",
      limit: 3,
      include_explain: true,
    });
    assert.equal(http.status, 200);
    const httpBody = http.body as {
      diagnostics: { retrieval: { retrievers_used?: string[] } };
      search: { explain?: unknown };
    };
    assert.equal(httpBody.search.explain, undefined);
    assert.ok((httpBody.diagnostics.retrieval.retrievers_used?.length ?? 0) > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
