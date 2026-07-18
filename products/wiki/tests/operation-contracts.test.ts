import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { routeHttpRequest } from "@openwiki/http-api";
import { handleMcpRequest, type McpToolMode } from "@openwiki/mcp-server";
import {
  mcpToolModeOperations,
  mcpToolOperationsForMode,
  operationNames,
  requiredScopesForOperation,
  type OpenWikiOperation,
  type OpenWikiScope,
} from "@openwiki/policy";
import { mcpManifest, openApiDocument } from "@openwiki/static-export";

type HttpMethod = "get" | "post";
type McpContractMode = "read" | "proposal" | "write";

interface OperationContract {
  operation: OpenWikiOperation;
  scopes: OpenWikiScope[];
  http: Array<{ path: string; method: HttpMethod }>;
  mcp?: McpContractMode;
  cli: RegExp;
}

const OPERATION_CONTRACTS: OperationContract[] = [
  contract("wiki.search", ["wiki:search"], [{ path: "/api/v1/search", method: "get" }], "read", /search <query>/),
  contract("wiki.recall", ["wiki:search"], [{ path: "/api/v1/recall", method: "post" }], "read", /recall <query>/),
  contract("wiki.ask", ["wiki:ask"], [{ path: "/api/v1/ask", method: "post" }], "read", /ask <question>/),
  contract("wiki.think", ["wiki:ask"], [{ path: "/api/v1/think", method: "post" }], "read", /think <question>/),
  contract("wiki.read_page", ["wiki:read"], [{ path: "/api/v1/pages/{id}", method: "get" }], "read", /page read <id>/),
  contract("wiki.read_source", ["wiki:read"], [{ path: "/api/v1/sources/{id}", method: "get" }], "read", /source read <id>/),
  contract("wiki.read_claim", ["wiki:read"], [{ path: "/api/v1/claims/{id}", method: "get" }], "read", /claim read <id>/),
  contract("wiki.list_facts", ["wiki:read"], [{ path: "/api/v1/facts", method: "get" }], "read", /facts list/),
  contract("wiki.read_fact", ["wiki:read"], [{ path: "/api/v1/facts/{id}", method: "get" }], "read", /facts list\|read <id>/),
  contract("wiki.list_takes", ["wiki:read"], [{ path: "/api/v1/takes", method: "get" }], "read", /takes list/),
  contract("wiki.read_take", ["wiki:read"], [{ path: "/api/v1/takes/{id}", method: "get" }], "read", /takes list\|read <id>/),
  contract("wiki.takes_scorecard", ["wiki:read"], [{ path: "/api/v1/takes/scorecard", method: "get" }], "read", /takes list\|read <id>\|scorecard/),
  contract("wiki.find_trajectory", ["wiki:read"], [{ path: "/api/v1/trajectory", method: "get" }], "read", /trajectory <id-or-query>/),
  contract("wiki.list_proposals", ["wiki:read"], [{ path: "/api/v1/proposals", method: "get" }], "read", /proposal list/),
  contract("wiki.read_proposal", ["wiki:read"], [{ path: "/api/v1/proposals/{id}", method: "get" }], "read", /proposal read <proposal-id>/),
  contract("wiki.read_proposal_detail", ["wiki:read"], [{ path: "/api/v1/proposals/{id}/detail", method: "get" }], "read", /proposal detail <proposal-id>/),
  contract("wiki.read_decision", ["wiki:read"], [{ path: "/api/v1/decisions/{id}", method: "get" }], "read", /decision read <id>/),
  contract("wiki.trace_claim", ["wiki:read"], [{ path: "/api/v1/claims/{id}/trace", method: "get" }], "read", /claim trace <id>/),
  contract("wiki.get_history", ["wiki:read"], [{ path: "/api/v1/pages/{id}/history", method: "get" }], "read", /history <id>/),
  contract("wiki.diff_versions", ["wiki:read"], [{ path: "/api/v1/pages/{id}/diff", method: "get" }], "read", /diff <id>/),
  contract("wiki.list_recent_changes", ["wiki:read"], [{ path: "/api/v1/recent-changes", method: "get" }], "read", /changes/),
  contract("wiki.git_status", ["wiki:read"], [{ path: "/api/v1/git/status", method: "get" }], "read", /git status\|configure\|pull\|push/),
  contract("wiki.git_pull", ["wiki:commit"], [{ path: "/api/v1/git/pull", method: "post" }], "write", /git status\|configure\|pull\|push/),
  contract("wiki.git_push", ["wiki:publish"], [{ path: "/api/v1/git/push", method: "post" }], "write", /git status\|configure\|pull\|push/),
  contract("wiki.sync_now", ["wiki:publish"], [{ path: "/api/v1/sync/now", method: "post" }], "write", /sync now/),
  contract("wiki.list_events", ["wiki:read"], [{ path: "/api/v1/events", method: "get" }], "read", /events/),
  contract("wiki.list_runs", ["wiki:read"], [{ path: "/api/v1/runs", method: "get" }], "read", /runs/),
  contract("wiki.dream_status", ["wiki:read"], [{ path: "/api/v1/dream/runs", method: "get" }], "read", /dream status/),
  contract("wiki.dream_run", ["wiki:read", "wiki:propose"], [{ path: "/api/v1/dream/runs", method: "post" }], "proposal", /dream run/),
  contract("wiki.list_topics", ["wiki:read"], [{ path: "/api/v1/topics", method: "get" }], "read", /topics/),
  contract("wiki.list_open_questions", ["wiki:read"], [{ path: "/api/v1/open-questions", method: "get" }], "read", /questions/),
  contract("wiki.inbox_list", ["wiki:inbox:read"], [{ path: "/api/v1/inbox/items", method: "get" }], "read", /inbox list/),
  contract("wiki.inbox_read", ["wiki:inbox:read"], [{ path: "/api/v1/inbox/items/{id}", method: "get" }], "read", /inbox read <inbox-id>/),
  contract("wiki.inbox_submit", ["wiki:inbox:submit"], [{ path: "/api/v1/inbox/items", method: "post" }], "proposal", /inbox add --title text/),
  contract("wiki.inbox_process", ["wiki:inbox:process"], [{ path: "/api/v1/inbox/items/{id}/process", method: "post" }], "write", /inbox ignore\|retry\|process <inbox-id>/),
  contract("wiki.inbox_ignore", ["wiki:inbox:process"], [{ path: "/api/v1/inbox/items/{id}/ignore", method: "post" }], "write", /inbox ignore\|retry\|process <inbox-id>/),
  contract("wiki.inbox_retry", ["wiki:inbox:process"], [{ path: "/api/v1/inbox/items/{id}/retry", method: "post" }], "write", /inbox ignore\|retry\|process <inbox-id>/),
  contract("wiki.detect_governance", ["wiki:read"], [{ path: "/api/v1/governance/detectors", method: "get" }], "read", /governance detectors/),
  contract("wiki.graph_neighbors", ["wiki:read"], [{ path: "/api/v1/graph/{id}/neighbors", method: "get" }], "read", /graph edges\|neighbors/),
  contract("wiki.graph_backlinks", ["wiki:read"], [{ path: "/api/v1/graph/{id}/backlinks", method: "get" }], "read", /graph edges\|neighbors/),
  contract("wiki.graph_related", ["wiki:read"], [{ path: "/api/v1/graph/{id}/related", method: "get" }], "read", /graph edges\|neighbors/),
  contract("wiki.graph_path", ["wiki:read"], [{ path: "/api/v1/graph/path", method: "get" }], "read", /graph edges\|neighbors/),
  contract("wiki.graph_orphans", ["wiki:read"], [{ path: "/api/v1/graph/orphans", method: "get" }], "read", /graph edges\|neighbors/),
  contract("wiki.graph_stale", ["wiki:read"], [{ path: "/api/v1/graph/stale", method: "get" }], "read", /graph edges\|neighbors/),
  contract("wiki.graph_report", ["wiki:read"], [{ path: "/api/v1/graph/report", method: "get" }], "read", /graph edges\|neighbors/),
  contract("wiki.read_policy", ["wiki:admin"], [{ path: "/api/v1/policy", method: "get" }], "write", /policy read/),
  contract("wiki.preview_permissions", ["wiki:admin"], [{ path: "/api/v1/policy/preview", method: "get" }], undefined, /policy preview/),
  contract("wiki.list_workspaces", ["wiki:admin"], [{ path: "/api/v1/workspaces", method: "get" }], "write", /workspace registry/),
  contract("wiki.connect_workspace", ["wiki:admin"], [{ path: "/api/v1/workspaces/connect", method: "post" }], "write", /workspace connect/),
  contract("wiki.propose_policy", ["wiki:admin"], [{ path: "/api/v1/policy/proposals", method: "post" }], "write", /policy propose sections\|grants\|approval-rules/),
  contract("wiki.propose_section_policy", ["wiki:admin"], [{ path: "/api/v1/policy/sections/proposals", method: "post" }], "write", /policy propose-section/),
  contract("wiki.propose_edit", ["wiki:propose"], [{ path: "/api/v1/proposals", method: "post" }], "proposal", /propose-edit <page-id>/),
  contract("wiki.propose_source", ["wiki:propose"], [{ path: "/api/v1/sources/propose", method: "post" }], "proposal", /source propose --title text/),
  contract("wiki.propose_synthesis", ["wiki:propose"], [{ path: "/api/v1/synthesis", method: "post" }], "proposal", /synthesize --title text/),
  contract("wiki.propose_fact", ["wiki:propose"], [{ path: "/api/v1/facts/proposals", method: "post" }], "proposal", /facts propose --text text/),
  contract("wiki.propose_take", ["wiki:propose"], [{ path: "/api/v1/takes/proposals", method: "post" }], "proposal", /takes propose --statement text/),
  contract("wiki.resolve_take", ["wiki:propose"], [{ path: "/api/v1/takes/{id}/resolve", method: "post" }], "proposal", /takes resolve <take-id>/),
  contract("wiki.forget_fact", ["wiki:propose"], [{ path: "/api/v1/facts/{id}/forget", method: "post" }], "proposal", /facts list\|read <id>\|propose\|forget <id>/),
  contract("wiki.comment_on_proposal", ["wiki:propose"], [{ path: "/api/v1/proposals/{id}/comments", method: "post" }], "proposal", /proposal comment <proposal-id>/),
  contract("wiki.ingest_source", ["wiki:ingest:draft"], [{ path: "/api/v1/sources/ingest", method: "post" }], "write", /source ingest --title text/),
  contract("wiki.fetch_source", ["wiki:ingest:draft"], [{ path: "/api/v1/sources/fetch", method: "post" }], "write", /source fetch --title text/),
  contract("wiki.review_proposal", ["wiki:review"], [{ path: "/api/v1/proposals/{id}/review", method: "post" }], "write", /proposal review <proposal-id>/),
  contract("wiki.close_proposal", ["wiki:review"], [{ path: "/api/v1/proposals/{id}/close", method: "post" }], "write", /proposal close <proposal-id>/),
  contract("wiki.apply_proposal", ["wiki:commit"], [{ path: "/api/v1/proposals/{id}/apply", method: "post" }], "write", /proposal apply <proposal-id>/),
  contract("wiki.create_synthesis", ["wiki:patch"], [{ path: "/api/v1/synthesis/create", method: "post" }], "write", /synthesize --title text/),
  contract("wiki.run_lint", ["wiki:patch"], [{ path: "/api/v1/lint", method: "post" }], "write", /run index\|export\|lint/),
  contract("wiki.run_job", ["wiki:patch"], [{ path: "/api/v1/runs", method: "post" }], "write", /run index\|export\|lint\|inbox-process\|inbox-reconcile/),
  contract("wiki.commit_changes", ["wiki:commit"], [{ path: "/api/v1/commit", method: "post" }], "write", /commit --message text/),
  contract("wiki.publish", ["wiki:publish"], [{ path: "/api/v1/publish", method: "post" }], "write", /publish static/),
];

test("policy operations, scopes, and HTTP capabilities share one public operation contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-operation-contract-"));
  try {
    const publicOperationNames = operationNames().filter((operation) => operation !== "wiki.admin");
    assert.deepEqual(publicOperationNames, OPERATION_CONTRACTS.map((entry) => entry.operation));
    for (const entry of OPERATION_CONTRACTS) {
      assert.deepEqual(requiredScopesForOperation(entry.operation), entry.scopes, entry.operation);
    }

    const response = await routeHttpRequest(root, "GET", "/api/v1/capabilities");
    assert.equal(response.status, 200);
    assert.deepEqual(capabilityOperations(response.body), publicOperationNames);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenAPI, MCP tool tiers, and CLI help cover every public operation", async () => {
  const paths = openApiPaths(openApiDocument());
  const operationsReference = await readFile(path.join(process.cwd(), "docs", "reference", "operations.md"), "utf8");
  for (const entry of OPERATION_CONTRACTS) {
    assert.match(operationsReference, new RegExp(escapeRegExp(`\`${entry.operation}\``)), `${entry.operation} is missing operation reference docs`);
    for (const route of entry.http) {
      assert.ok(paths[route.path], `${entry.operation} is missing OpenAPI path ${route.path}`);
      assert.ok(paths[route.path]?.[route.method], `${entry.operation} is missing OpenAPI ${route.method.toUpperCase()} ${route.path}`);
    }
  }

  for (const mode of ["read", "proposal", "write"] satisfies McpToolMode[]) {
    const response = await handleMcpRequest(process.cwd(), { jsonrpc: "2.0", id: mode, method: "tools/list" }, { toolMode: mode });
    assert.deepEqual(sortedOperations(mcpToolNames(response)), sortedOperations(expectedMcpToolNames(mode)), mode);
    assert.deepEqual(sortedOperations(mcpToolOperationsForMode(mode)), sortedOperations(expectedMcpToolNames(mode)), mode);
  }

  assert.deepEqual(mcpManifestToolModes(mcpManifest()), {
    read: mcpToolModeOperations("read"),
    proposal: mcpToolModeOperations("proposal"),
    write: mcpToolModeOperations("write"),
  });

  const help = await readFile(path.join(process.cwd(), "packages", "cli", "src", "output.ts"), "utf8");
  for (const entry of OPERATION_CONTRACTS) {
    assert.match(help, entry.cli, `${entry.operation} is missing CLI help coverage`);
  }
});

function contract(
  operation: OpenWikiOperation,
  scopes: OpenWikiScope[],
  http: Array<{ path: string; method: HttpMethod }>,
  mcp: McpContractMode | undefined,
  cli: RegExp,
): OperationContract {
  return { operation, scopes, http, ...(mcp === undefined ? {} : { mcp }), cli };
}

function capabilityOperations(value: unknown): OpenWikiOperation[] {
  assert.ok(isRecord(value));
  const operations = value.operations;
  assert.ok(Array.isArray(operations));
  return operations.map((operation) => {
    assert.equal(typeof operation, "string");
    return operation as OpenWikiOperation;
  });
}

function openApiPaths(value: unknown): Record<string, Partial<Record<HttpMethod, unknown>>> {
  assert.ok(isRecord(value));
  assert.ok(isRecord(value.paths));
  return value.paths as Record<string, Partial<Record<HttpMethod, unknown>>>;
}

function mcpToolNames(value: unknown): OpenWikiOperation[] {
  assert.ok(isRecord(value));
  assert.ok(Array.isArray(value.tools));
  return value.tools.map((tool) => {
    assert.ok(isRecord(tool));
    assert.equal(typeof tool.name, "string");
    return tool.name as OpenWikiOperation;
  });
}

function mcpManifestToolModes(value: unknown): Record<McpContractMode, OpenWikiOperation[]> {
  assert.ok(isRecord(value));
  assert.ok(isRecord(value.tool_modes));
  return {
    read: mcpManifestToolMode(value.tool_modes.read),
    proposal: mcpManifestToolMode(value.tool_modes.proposal),
    write: mcpManifestToolMode(value.tool_modes.write),
  };
}

function mcpManifestToolMode(value: unknown): OpenWikiOperation[] {
  assert.ok(Array.isArray(value));
  return value.map((operation) => {
    assert.equal(typeof operation, "string");
    return operation as OpenWikiOperation;
  });
}

function expectedMcpToolNames(mode: McpToolMode): OpenWikiOperation[] {
  return OPERATION_CONTRACTS
    .filter((entry) => entry.mcp !== undefined && mcpModeRank(entry.mcp) <= mcpModeRank(mode))
    .map((entry) => entry.operation);
}

function sortedOperations(operations: OpenWikiOperation[]): OpenWikiOperation[] {
  return [...operations].sort();
}

function mcpModeRank(mode: McpContractMode): number {
  switch (mode) {
    case "read":
      return 1;
    case "proposal":
      return 2;
    case "write":
      return 3;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
