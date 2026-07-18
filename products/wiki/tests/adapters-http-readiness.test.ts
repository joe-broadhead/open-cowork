import { routeHttpRequest, startHttpApi } from "@openwiki/http-api";
import { componentHealthMetric } from "../packages/http-api/src/health-metrics.ts";
import { rebuildIndexStore } from "@openwiki/index-store";
import { hashOpenWikiToken, scopesForRole } from "@openwiki/policy";
import { createWorkspace } from "@openwiki/repo";
import { buildSearchIndex } from "@openwiki/search";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("HTTP adapter routes read and search requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-http-"));
  try {
    await createWorkspace(root, "HTTP Wiki");
    await addServiceAccount(root, {
      id: "http-researcher",
      actor_id: "actor:agent:http-researcher",
      role: "researcher",
      token_hashes: [hashOpenWikiToken("http-researcher-secret")],
    });
    await Promise.all([buildSearchIndex(root), rebuildIndexStore(root)]);

    const capabilities = await routeHttpRequest(root, "GET", "/api/v1/capabilities");
    assert.equal(capabilities.status, 200);
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.search"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.ask"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.ingest_source"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.propose_synthesis"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.create_synthesis"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.list_topics"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.list_open_questions"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.graph_neighbors"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.graph_path"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.fetch_source"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.list_runs"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.detect_governance"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.run_job"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.run_lint"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.commit_changes"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.publish"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.git_status"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.git_pull"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.git_push"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.list_workspaces"));
    assert.ok((capabilities.body as { operations: string[] }).operations.includes("wiki.connect_workspace"));
    assert.ok((capabilities.body as { adapters: string[] }).adapters.includes("mcp-http"));

    const openapi = await routeHttpRequest(root, "GET", "/api/v1/openapi.json");
    assert.equal(openapi.status, 200);
    assert.ok((openapi.body as { paths?: Record<string, unknown> }).paths?.["/api/v1/search"]);
    assert.ok((openapi.body as { paths?: Record<string, unknown> }).paths?.["/api/v1/openapi.json"]);
    assert.ok((openapi.body as { paths?: Record<string, unknown> }).paths?.["/mcp-manifest.json"]);
    assert.ok((openapi.body as { paths?: Record<string, unknown> }).paths?.["/api/v1/git/status"]);
    assert.ok((openapi.body as { paths?: Record<string, unknown> }).paths?.["/api/v1/git/pull"]);
    assert.ok((openapi.body as { paths?: Record<string, unknown> }).paths?.["/api/v1/git/push"]);
    assert.ok((openapi.body as { paths?: Record<string, unknown> }).paths?.["/api/v1/workspaces"]);
    assert.ok((openapi.body as { paths?: Record<string, unknown> }).paths?.["/api/v1/workspaces/connect"]);
    assert.ok((openapi.body as { paths?: Record<string, unknown> }).paths?.["/livez"]);
    assert.ok((openapi.body as { paths?: Record<string, unknown> }).paths?.["/readyz"]);
    assert.ok((openapi.body as { paths?: Record<string, unknown> }).paths?.["/metrics"]);

    const rootOpenapi = await routeHttpRequest(root, "GET", "/openapi.json");
    assert.equal(rootOpenapi.status, 200);
    assert.ok((rootOpenapi.body as { paths?: Record<string, unknown> }).paths?.["/api/v1/capabilities"]);

    const manifest = await routeHttpRequest(root, "GET", "/mcp-manifest.json");
    assert.equal(manifest.status, 200);
    const manifestBody = JSON.stringify(manifest.body);
    assert.ok(manifestBody.includes("wiki.search"));
    assert.ok(manifestBody.includes("wiki.git_status"));
    assert.ok(manifestBody.includes("wiki.git_pull"));
    assert.ok(manifestBody.includes("wiki.git_push"));
    assert.ok(manifestBody.includes("openwiki://page"));

    const health = await routeHttpRequest(root, "GET", "/healthz");
    assert.equal(health.status, 200);
    const liveness = await routeHttpRequest(root, "GET", "/livez");
    assert.equal(liveness.status, 200);
    assert.equal((liveness.body as { status: string }).status, "alive");
    const readiness = await routeHttpRequest(root, "GET", "/readyz", undefined, {
      actorId: "actor:user:ops",
      role: "admin",
    });
    assert.equal(readiness.status, 200);
    assert.equal((readiness.body as { status: string }).status, "ready");
    const deniedMetrics = await routeHttpRequest(root, "GET", "/metrics");
    assert.equal(deniedMetrics.status, 403);
    const metrics = await routeHttpRequest(root, "GET", "/metrics", undefined, {
      actorId: "actor:user:ops",
      role: "admin",
    });
    assert.equal(metrics.status, 200);
    assert.match(metrics.contentType ?? "", /text\/plain/);
    assert.match(metrics.body as string, /openwiki_up 1/);
    assert.match(metrics.body as string, /openwiki_workspace_records\{workspace_id="workspace:http-wiki",record_type="pages"\}/);

    const deniedWorkspaces = await routeHttpRequest(root, "GET", "/api/v1/workspaces");
    assert.equal(deniedWorkspaces.status, 403);
    const workspaces = await routeHttpRequest(root, "GET", "/api/v1/workspaces", undefined, {
      scopes: ["wiki:admin"],
      actorId: "actor:user:admin",
    });
    assert.equal(workspaces.status, 200);
    const workspaceRegistry = (workspaces.body as { registry: { workspaces: Array<{ id: string }>; repos: Array<{ repo_id: string }> } }).registry;
    assert.equal(workspaceRegistry.workspaces[0]?.id, "workspace:http-wiki");
    assert.equal(workspaceRegistry.repos[0]?.repo_id, "repo:default");
    assert.equal((health.body as { status: string }).status, "ok");
    assert.equal((health.body as { components?: { object_storage?: { backend?: string } } }).components?.object_storage?.backend, "local");
    assert.ok((health.body as { components?: { index_store?: { issues?: string[] } } }).components?.index_store);

    const search = await routeHttpRequest(root, "GET", "/api/v1/search?q=agent%20memory&limit=1&highlights=true");
    assert.equal(search.status, 200);
    const searchBody = search.body as { results: Array<{ id: string; highlights?: Record<string, string[]> }>; facets?: { types?: Record<string, number> }; next_cursor?: string };
    assert.equal(searchBody.results[0]?.id, "page:concept:agent-memory");
    assert.match(searchBody.results[0]?.highlights?.title?.[0] ?? "", /Agent Memory/);
    assert.ok((searchBody.facets?.types?.page ?? 0) >= 1);
    assert.equal(searchBody.next_cursor, "offset:1");
    const cursorSearch = await routeHttpRequest(root, "GET", `/api/v1/search?q=agent%20memory&limit=1&cursor=${encodeURIComponent(searchBody.next_cursor)}`);
    assert.equal(cursorSearch.status, 200);
    assert.notEqual((cursorSearch.body as { results: Array<{ id: string }> }).results[0]?.id, searchBody.results[0]?.id);

    const recordPage = await routeHttpRequest(root, "GET", "/api/v1/records?limit=1");
    assert.equal(recordPage.status, 200);
    const recordPageBody = recordPage.body as { records: Array<{ id: string; href: string }>; next_cursor?: string };
    assert.ok(recordPageBody.records[0]?.id);
    assert.ok(recordPageBody.next_cursor);
    const nextRecordPage = await routeHttpRequest(root, "GET", `/api/v1/records?limit=1&cursor=${encodeURIComponent(recordPageBody.next_cursor)}`);
    assert.equal(nextRecordPage.status, 200);
    assert.notEqual((nextRecordPage.body as { records: Array<{ id: string }> }).records[0]?.id, recordPageBody.records[0]?.id);
    const pageRecords = await routeHttpRequest(root, "GET", "/api/v1/records?type=page&prefix=agent");
    assert.equal(pageRecords.status, 200);
    assert.equal((pageRecords.body as { records: Array<{ id: string }> }).records[0]?.id, "page:concept:agent-memory");
    const recordGroups = await routeHttpRequest(root, "GET", "/api/v1/records?type=page&group_by=page_type&limit=1");
    assert.equal(recordGroups.status, 200);
    const recordGroupBody = recordGroups.body as { groups?: Array<{ id: string; count: number }>; records: Array<{ group: string }> };
    assert.ok(recordGroupBody.groups?.some((group) => group.id === "concept" && group.count >= 1));
    assert.equal(recordGroupBody.records[0]?.group, "concept");
    const conceptRecords = await routeHttpRequest(root, "GET", "/api/v1/records?type=page&group=concept&limit=1");
    assert.equal(conceptRecords.status, 200);
    assert.equal((conceptRecords.body as { records: Array<{ group: string }> }).records[0]?.group, "concept");

    const fuzzySearch = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/search?q=agnt%20memry&type=page&topic=agents&status=draft&persona=researcher&mode=hybrid&fuzzy=true&explain=true",
    );
    assert.equal(fuzzySearch.status, 200);
    const fuzzyBody = fuzzySearch.body as {
      persona: string;
      explain?: { retrievers_used?: string[]; retriever_stats?: { fuzzy?: { enabled?: boolean } } };
      results: Array<{ id: string; explain?: { retrieval?: { retrievers?: Record<string, unknown> } } }>;
    };
    assert.equal(fuzzyBody.persona, "researcher");
    assert.equal(fuzzyBody.results[0]?.id, "page:concept:agent-memory");
    assert.ok(fuzzyBody.results[0]?.explain?.retrieval?.retrievers?.fuzzy);
    assert.ok(fuzzyBody.explain?.retrievers_used?.includes("fuzzy"));
    assert.equal(fuzzyBody.explain?.retriever_stats?.fuzzy?.enabled, true);

    const answer = await routeHttpRequest(root, "POST", "/api/v1/ask", {
      question: "How does OpenWiki store agent memory?",
      limit: 3,
      include_explain: true,
    });
    assert.equal(answer.status, 200);
    assert.match((answer.body as { answer: string }).answer, /OpenWiki found/);

    const mcpTools = await routeHttpRequest(root, "POST", "/mcp?tools=read", {
      jsonrpc: "2.0",
      id: "tools",
      method: "tools/list",
    });
    assert.equal(mcpTools.status, 200);
    const mcpToolNames = (mcpTools.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      (tool) => tool.name,
    );
    assert.ok(mcpToolNames.includes("wiki.search"));
    assert.ok(!mcpToolNames.includes("wiki.propose_edit"));

    const mcpSearch = await routeHttpRequest(root, "POST", "/mcp?tools=read", {
      jsonrpc: "2.0",
      id: "search",
      method: "tools/call",
      params: {
        name: "wiki.search",
        arguments: {
          query: "agent memory",
          limit: 1,
        },
      },
    });
    assert.equal(mcpSearch.status, 200);
    assert.equal(
      (mcpSearch.body as { result: { structuredContent: { results: Array<{ id: string }> } } }).result
        .structuredContent.results[0]?.id,
      "page:concept:agent-memory",
    );

    const deniedMcpProposal = await routeHttpRequest(root, "POST", "/mcp?tools=proposal", {
      jsonrpc: "2.0",
      id: "denied-proposal",
      method: "tools/call",
      params: {
        name: "wiki.propose_edit",
        arguments: {
          page_id: "page:concept:agent-memory",
          body: "# Agent Memory\n\nRemote MCP defaults to viewer scopes.",
        },
      },
    });
    assert.equal(deniedMcpProposal.status, 200);
    assert.equal((deniedMcpProposal.body as { error: { code: number } }).error.code, -32001);
    assert.match((deniedMcpProposal.body as { error: { message: string } }).error.message, /wiki:propose/);

    const topics = await routeHttpRequest(root, "GET", "/api/v1/topics");
    assert.equal(topics.status, 200);
    assert.equal((topics.body as { topics: Array<{ topic: string }> }).topics[0]?.topic, "agents");

    const graphHttp = await routeHttpRequest(root, "GET", "/api/v1/graph/" + encodeURIComponent("page:concept:agent-memory") + "/neighbors");
    assert.equal(graphHttp.status, 200);
    assert.ok((graphHttp.body as { edges: Array<{ edge_type: string; to_id: string }> }).edges.some((edge) => edge.edge_type === "page_source" && edge.to_id === "source:2026-05-21-001"));

    const seededGraphHttp = await routeHttpRequest(root, "GET", "/api/v1/graph?seed=top&limit=2");
    assert.equal(seededGraphHttp.status, 200);
    const seededGraphBody = seededGraphHttp.body as { nodes: Array<{ id: string }>; edges: Array<{ from_id: string; to_id: string }> };
    assert.ok(seededGraphBody.nodes.length <= 2);
    assert.ok(seededGraphBody.edges.every((edge) => seededGraphBody.nodes.some((node) => node.id === edge.from_id) && seededGraphBody.nodes.some((node) => node.id === edge.to_id)));

    const graphPage = await routeHttpRequest(root, "GET", "/graph");
    assert.equal(graphPage.status, 200);
    assert.match(String(graphPage.body), /Workspace Graph/);
    assert.match(String(graphPage.body), /data-openwiki-graph/);
    assert.match(String(graphPage.body), /data-openwiki-graph-search/);
    assert.match(String(graphPage.body), /data-openwiki-graph-node-legend/);
    assert.match(String(graphPage.body), /data-openwiki-graph-edge-legend/);
    assert.match(String(graphPage.body), /data-openwiki-graph-search-results/);
    assert.match(String(graphPage.body), /data-openwiki-graph-fit/);
    assert.match(String(graphPage.body), /data-graph-src="\/api\/v1\/graph\?seed=top&amp;limit=1500"/);
    assert.match(String(graphPage.body), /data-graph-neighbor-src="\/api\/v1\/graph\/\{id\}\/neighbors\?limit=1500"/);
    assert.match(String(graphPage.body), /<svg class="ow-graph-visual"/);
    assert.match(String(graphPage.body), /Agent Memory/);

    const focusedGraphPage = await routeHttpRequest(root, "GET", "/graph?focus=" + encodeURIComponent("page:concept:agent-memory"));
    assert.equal(focusedGraphPage.status, 200);
    assert.match(String(focusedGraphPage.body), /is-focus/);
    assert.match(String(focusedGraphPage.body), /data-graph-src="\/api\/v1\/graph\/page%3Aconcept%3Aagent-memory\/neighbors\?limit=1500"/);

    const pageView = await routeHttpRequest(root, "GET", "/pages/" + encodeURIComponent("page:concept:agent-memory"));
    assert.equal(pageView.status, 200);
    assert.match(String(pageView.body), /Local Graph/);
    assert.match(String(pageView.body), /class="ow-local-graph"/);
    assert.match(String(pageView.body), /data-graph-mode="local"/);
    assert.match(String(pageView.body), /Open workspace graph/);
    assert.match(String(pageView.body), /\/pages\/page%3Aconcept%3Aagent-memory\/diff/);
    assert.match(String(pageView.body), /class="ow-record-actions"/);
    assert.match(String(pageView.body), /data-openwiki-copy-citation=/);

    const pageDiffView = await routeHttpRequest(root, "GET", "/pages/" + encodeURIComponent("page:concept:agent-memory") + "/diff");
    assert.equal(pageDiffView.status, 200);
    assert.match(String(pageDiffView.body), /Diff: Agent Memory/);
    assert.match(String(pageDiffView.body), /class="ow-diff/);
    assert.match(String(pageDiffView.body), /\/api\/v1\/pages\/page%3Aconcept%3Aagent-memory\/diff/);

    const sourceDiffView = await routeHttpRequest(root, "GET", "/sources/" + encodeURIComponent("source:2026-05-21-001") + "/diff");
    assert.equal(sourceDiffView.status, 200);
    assert.match(String(sourceDiffView.body), /class="ow-diff/);

    const claimDiffView = await routeHttpRequest(root, "GET", "/claims/" + encodeURIComponent("claim:2026-05-21-001") + "/diff");
    assert.equal(claimDiffView.status, 200);
    assert.match(String(claimDiffView.body), /class="ow-diff/);

    const graphPathHttp = await routeHttpRequest(root, "GET", "/api/v1/graph/path?from_id=" + encodeURIComponent("page:concept:agent-memory") + "&to_id=" + encodeURIComponent("source:2026-05-21-001"));
    assert.equal(graphPathHttp.status, 200);
    assert.equal((graphPathHttp.body as { found: boolean }).found, true);

    const graphOrphansHttp = await routeHttpRequest(root, "GET", "/api/v1/graph/orphans");
    assert.equal(graphOrphansHttp.status, 200);
    assert.ok(Array.isArray((graphOrphansHttp.body as { pages: unknown[] }).pages));

    const graphReportHttp = await routeHttpRequest(root, "GET", "/api/v1/graph/report?limit=5");
    assert.equal(graphReportHttp.status, 200);
    const graphReportBody = graphReportHttp.body as {
      schema_version: string;
      hub_nodes: Array<{ id: string }>;
      suggested_questions: Array<{ question: string }>;
    };
    assert.equal(graphReportBody.schema_version, "openwiki-graph-analysis-v1");
    assert.ok(graphReportBody.hub_nodes.some((node) => node.id === "page:concept:agent-memory"));
    assert.ok(graphReportBody.suggested_questions.length > 0);

    const lint = await routeHttpRequest(root, "POST", "/api/v1/lint", undefined, {
      scopes: ["wiki:patch"],
      actorId: "actor:user:maintainer",
    });
    assert.equal(lint.status, 200);
    assert.equal((lint.body as { status: string }).status, "passed");

    const questions = await routeHttpRequest(root, "GET", "/api/v1/open-questions");
    assert.equal(questions.status, 200);
    assert.equal(
      (questions.body as { open_questions: Array<{ question: string }> }).open_questions[0]?.question,
      "How should OpenWiki rank disputed claims?",
    );

    const governanceDetectors = await routeHttpRequest(root, "GET", "/api/v1/governance/detectors");
    assert.equal(governanceDetectors.status, 200);
    assert.ok(Array.isArray((governanceDetectors.body as { findings: unknown[] }).findings));

    const eventsBeforeWrites = await routeHttpRequest(root, "GET", "/api/v1/events");
    assert.equal(eventsBeforeWrites.status, 200);
    assert.deepEqual((eventsBeforeWrites.body as { events: unknown[] }).events, []);

    const runsBeforeWrites = await routeHttpRequest(root, "GET", "/api/v1/runs");
    assert.equal(runsBeforeWrites.status, 200);
    assert.deepEqual((runsBeforeWrites.body as { runs: unknown[] }).runs, []);

    const runMonitorBeforeWrites = await routeHttpRequest(root, "GET", "/api/v1/runs/monitor");
    assert.equal(runMonitorBeforeWrites.status, 200);
    assert.equal((runMonitorBeforeWrites.body as { counts: { total: number }; source: string }).counts.total, 0);
    assert.equal((runMonitorBeforeWrites.body as { counts: { total: number }; source: string }).source, "parser");

    const allowedMcpProposal = await routeHttpRequest(
      root,
      "POST",
      "/mcp?tools=proposal",
      {
        jsonrpc: "2.0",
        id: "allowed-proposal",
        method: "tools/call",
        params: {
          name: "wiki.propose_edit",
          arguments: {
            page_id: "page:concept:agent-memory",
            body: "# Agent Memory\n\nRemote MCP clients can propose edits when scoped.",
            rationale: "Remote MCP proposal smoke test.",
          },
        },
      },
      { token: "http-researcher-secret" },
    );
    assert.equal(allowedMcpProposal.status, 200);
    assert.match(
      (allowedMcpProposal.body as { result: { structuredContent: { proposal: { id: string } } } }).result
        .structuredContent.proposal.id,
      /^proposal:/,
    );

    const deniedRun = await routeHttpRequest(root, "POST", "/api/v1/runs", {
      run_type: "lint",
    });
    assert.equal(deniedRun.status, 403);
    const unknownRun = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/runs",
      {
        run_type: "unsupported.job",
        actor_id: "actor:user:http-maintainer",
      },
      { scopes: scopesForRole("admin"), actorId: "actor:user:http-maintainer" },
    );
    assert.equal(unknownRun.status, 400);

    const run = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/runs",
      {
        run_type: "lint",
        actor_id: "actor:user:http-maintainer",
      },
      { scopes: scopesForRole("maintainer"), actorId: "actor:user:http-maintainer" },
    );
    assert.equal(run.status, 202);
    const queuedRun = (run.body as { run: { id: string; status: string; run_type: string } }).run;
    assert.equal(queuedRun.status, "queued");
    assert.equal(queuedRun.run_type, "lint");

    const waitedRun = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/runs",
      {
        run_type: "lint",
        actor_id: "actor:user:http-maintainer",
        wait: true,
      },
      { scopes: scopesForRole("maintainer"), actorId: "actor:user:http-maintainer" },
    );
    assert.equal(waitedRun.status, 201);
    assert.equal((waitedRun.body as { run: { status: string; run_type: string } }).run.status, "succeeded");

    const runDetail = await routeHttpRequest(root, "GET", `/api/v1/runs/${encodeURIComponent(queuedRun.id)}`);
    assert.equal(runDetail.status, 200);
    assert.equal((runDetail.body as { run: { id: string; status: string }; events: Array<{ type: string }> }).run.id, queuedRun.id);
    assert.ok(
      (runDetail.body as { run: { id: string; status: string }; events: Array<{ type: string }> }).events.some(
        (event) => event.type === "run.created",
      ),
    );

    const runDetailPage = await routeHttpRequest(root, "GET", `/runs/${encodeURIComponent(queuedRun.id)}`);
    assert.equal(runDetailPage.status, 200);
    assert.match(String(runDetailPage.body), /Run JSON/);
    assert.match(String(runDetailPage.body), /Events/);

    const queuedRunMonitor = await routeHttpRequest(root, "GET", "/api/v1/runs/monitor?status=queued");
    assert.equal(queuedRunMonitor.status, 200);
    const queuedRunMonitorBody = queuedRunMonitor.body as {
      counts: { total: number; queued: number; succeeded: number };
      recent: Array<{ status: string; run_type: string }>;
    };
    assert.equal(queuedRunMonitorBody.counts.total, 2);
    assert.equal(queuedRunMonitorBody.counts.queued, 1);
    assert.equal(queuedRunMonitorBody.counts.succeeded, 1);
    assert.deepEqual(queuedRunMonitorBody.recent.map((run) => run.status), ["queued"]);

    const runsPage = await routeHttpRequest(root, "GET", "/runs?status=queued");
    assert.equal(runsPage.status, 200);
    assert.match(String(runsPage.body), /Run Monitor/);
    assert.match(String(runsPage.body), /Recent Runs/);

    const filteredEvents = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/events?event_type=run.created&actor_id=actor:user:http-maintainer",
    );
    assert.equal(filteredEvents.status, 200);
    assert.equal((filteredEvents.body as { events: Array<{ type: string; actor_id: string }> }).events.length, 2);
    assert.equal(
      (filteredEvents.body as { events: Array<{ type: string; actor_id: string }> }).events.every(
        (event) => event.type === "run.created" && event.actor_id === "actor:user:http-maintainer",
      ),
      true,
    );

    const filteredAudit = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/audit/export?event_type=run.created&actor_id=actor:user:http-maintainer",
    );
    assert.equal(filteredAudit.status, 200);
    const filteredAuditBody = filteredAudit.body as { counts: Record<string, number>; timeline: Array<{ kind: string }> };
    assert.equal(filteredAuditBody.counts.events, 2);
    assert.equal(filteredAuditBody.counts.runs, 0);
    assert.equal(filteredAuditBody.counts.proposals, 0);
    assert.equal(filteredAuditBody.counts.decisions, 0);
    assert.equal(filteredAuditBody.counts.timeline, 2);
    assert.equal(filteredAuditBody.timeline.every((entry) => entry.kind === "event"), true);

    const firstFilteredEventPage = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/events?event_type=run.created&actor_id=actor:user:http-maintainer&limit=1",
    );
    assert.equal(firstFilteredEventPage.status, 200);
    const firstFilteredEventPageBody = firstFilteredEventPage.body as {
      events: Array<{ id: string; type: string; actor_id: string }>;
      next_cursor?: string;
    };
    assert.equal(firstFilteredEventPageBody.events.length, 1);
    assert.ok(firstFilteredEventPageBody.next_cursor);
    assert.equal(firstFilteredEventPageBody.events[0]?.type, "run.created");
    assert.equal(firstFilteredEventPageBody.events[0]?.actor_id, "actor:user:http-maintainer");
    const secondFilteredEventPage = await routeHttpRequest(
      root,
      "GET",
      `/api/v1/events?event_type=run.created&actor_id=actor:user:http-maintainer&limit=1&cursor=${encodeURIComponent(firstFilteredEventPageBody.next_cursor ?? "")}`,
    );
    assert.equal(secondFilteredEventPage.status, 200);
    const secondFilteredEventPageBody = secondFilteredEventPage.body as {
      events: Array<{ id: string; type: string; actor_id: string }>;
    };
    assert.equal(secondFilteredEventPageBody.events.length, 1);
    assert.notEqual(secondFilteredEventPageBody.events[0]?.id, firstFilteredEventPageBody.events[0]?.id);
    assert.equal(secondFilteredEventPageBody.events[0]?.type, "run.created");
    assert.equal(secondFilteredEventPageBody.events[0]?.actor_id, "actor:user:http-maintainer");

    const firstFilteredAuditPage = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/audit/export?event_type=run.created&actor_id=actor:user:http-maintainer&limit=1",
    );
    assert.equal(firstFilteredAuditPage.status, 200);
    const firstFilteredAuditPageBody = firstFilteredAuditPage.body as {
      counts: { events: number; timeline: number };
      events: Array<{ id: string }>;
      timeline: Array<{ kind: string; id: string }>;
      next_cursor?: string;
      next_timeline_cursor?: string;
    };
    assert.equal(firstFilteredAuditPageBody.counts.events, 1);
    assert.equal(firstFilteredAuditPageBody.counts.timeline, 1);
    assert.ok(firstFilteredAuditPageBody.next_cursor);
    assert.ok(firstFilteredAuditPageBody.next_timeline_cursor);
    assert.equal(firstFilteredAuditPageBody.timeline[0]?.kind, "event");
    const secondFilteredAuditPage = await routeHttpRequest(
      root,
      "GET",
      `/api/v1/audit/export?event_type=run.created&actor_id=actor:user:http-maintainer&limit=1&cursor=${encodeURIComponent(
        firstFilteredAuditPageBody.next_cursor ?? "",
      )}&timeline_cursor=${encodeURIComponent(firstFilteredAuditPageBody.next_timeline_cursor ?? "")}`,
    );
    assert.equal(secondFilteredAuditPage.status, 200);
    const secondFilteredAuditPageBody = secondFilteredAuditPage.body as {
      counts: { events: number; timeline: number };
      events: Array<{ id: string }>;
      timeline: Array<{ kind: string; id: string }>;
    };
    assert.equal(secondFilteredAuditPageBody.counts.events, 1);
    assert.equal(secondFilteredAuditPageBody.counts.timeline, 1);
    assert.notEqual(secondFilteredAuditPageBody.events[0]?.id, firstFilteredAuditPageBody.events[0]?.id);
    assert.notEqual(secondFilteredAuditPageBody.timeline[0]?.id, firstFilteredAuditPageBody.timeline[0]?.id);
    assert.equal(secondFilteredAuditPageBody.timeline[0]?.kind, "event");

    const mixedAudit = await routeHttpRequest(root, "GET", "/api/v1/audit/export?limit=20");
    assert.equal(mixedAudit.status, 200);
    const mixedTimelineKinds = (mixedAudit.body as { timeline: Array<{ kind: string }>; counts: { timeline: number } }).timeline.map((entry) => entry.kind);
    assert.ok(mixedTimelineKinds.includes("event"));
    assert.ok(mixedTimelineKinds.includes("run"));
    assert.ok((mixedAudit.body as { timeline: unknown[]; counts: { timeline: number } }).counts.timeline > 0);

    const firstEventPage = await routeHttpRequest(root, "GET", "/api/v1/events?limit=1");
    assert.equal(firstEventPage.status, 200);
    const firstEventPageBody = firstEventPage.body as { events: Array<{ id: string }>; next_cursor?: string };
    assert.equal(firstEventPageBody.events.length, 1);
    assert.ok(firstEventPageBody.next_cursor);
    const secondEventPage = await routeHttpRequest(
      root,
      "GET",
      `/api/v1/events?limit=1&cursor=${encodeURIComponent(firstEventPageBody.next_cursor ?? "")}`,
    );
    assert.equal(secondEventPage.status, 200);
    const secondEventPageBody = secondEventPage.body as { events: Array<{ id: string }> };
    assert.equal(secondEventPageBody.events.length, 1);
    assert.notEqual(secondEventPageBody.events[0]?.id, firstEventPageBody.events[0]?.id);

    const webhook = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/webhooks/github",
      {
        event: "push",
        delivery_id: "delivery-1",
        repository: { full_name: "openwiki/docs" },
        ref: "refs/heads/main",
        after: "abc123",
        sender: { login: "maintainer" },
      },
      { scopes: scopesForRole("admin"), actorId: "actor:service:github" },
    );
    assert.equal(webhook.status, 202);
    assert.equal((webhook.body as { provider: string }).provider, "github");
    assert.equal((webhook.body as { run: { status: string; run_type: string } }).run.status, "queued");
    assert.equal((webhook.body as { run: { status: string; run_type: string } }).run.run_type, "index.rebuild");

    const deniedStaticExportWebhook = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/webhooks/github",
      {
        event: "push",
        run_type: "static.export",
        repository: { full_name: "openwiki/docs" },
      },
      { scopes: ["wiki:patch"], actorId: "actor:service:limited-webhook" },
    );
    assert.equal(deniedStaticExportWebhook.status, 403);

    const gitlabWebhook = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/webhooks/gitlab",
      {
        object_kind: "push",
        project: { path_with_namespace: "platform/wiki" },
        ref: "refs/heads/main",
        checkout_sha: "def456",
        enqueue: false,
      },
      { scopes: scopesForRole("maintainer"), actorId: "actor:service:gitlab" },
    );
    assert.equal(gitlabWebhook.status, 202);
    assert.equal((gitlabWebhook.body as { provider: string; run: unknown }).provider, "gitlab");
    assert.equal((gitlabWebhook.body as { run: unknown }).run, null);

    const deniedSource = await routeHttpRequest(root, "POST", "/api/v1/sources/ingest", {
      title: "Denied HTTP Evidence Note",
      source_type: "manual",
    });
    assert.equal(deniedSource.status, 403);

    const source = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/sources/ingest",
      {
        title: "HTTP Evidence Note",
        source_type: "manual",
        content: "HTTP ingested sources become searchable OpenWiki evidence.",
        actor_id: "actor:agent:http-client",
      },
      { token: "http-researcher-secret" },
    );
    assert.equal(source.status, 201);
    assert.match((source.body as { source: { id: string } }).source.id, /^source:/);
    const sourceId = (source.body as { source: { id: string } }).source.id;

    const sourceContent = await routeHttpRequest(root, "GET", `/api/v1/sources/${encodeURIComponent(sourceId)}/content`);
    assert.equal(sourceContent.status, 200);
    assert.match((sourceContent.body as { content?: { body?: string } }).content?.body ?? "", /HTTP ingested sources/);

    const proposedSource = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/sources/propose",
      {
        title: "HTTP Proposed Source",
        source_type: "webpage",
        url: "https://example.com/http-proposed-source",
        actor_id: "actor:agent:http-client",
        rationale: "HTTP clients can propose sources before ingestion.",
      },
      { token: "http-researcher-secret" },
    );
    assert.equal(proposedSource.status, 201);
    assert.match((proposedSource.body as { source: { id: string } }).source.id, /^source:/);
    assert.match(
      (proposedSource.body as { proposal: { target_path: string } }).proposal.target_path,
      /^sources\/manifests\//,
    );

    const fetchedSource = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/sources/fetch",
      {
        title: "HTTP Fetch Note",
        url: "https://example.com/fetch-note.txt",
        connector_id: "docs",
        credential_ref: "cred:docs-reader",
        actor_id: "actor:agent:http-client",
      },
      { token: "http-researcher-secret" },
    );
    assert.equal(fetchedSource.status, 202);
    const httpFetchedRun = (fetchedSource.body as {
      run: { status: string; run_type: string; input?: Record<string, unknown> };
    }).run;
    assert.equal(httpFetchedRun.status, "queued");
    assert.equal(httpFetchedRun.run_type, "source.fetch");
    assert.equal(httpFetchedRun.input?.title, "HTTP Fetch Note");
    assert.equal(httpFetchedRun.input?.connector_id, undefined);
    assert.equal(httpFetchedRun.input?.credential_ref, undefined);

    const eventsAfterIngest = await routeHttpRequest(root, "GET", "/api/v1/events?limit=20");
    assert.equal(eventsAfterIngest.status, 200);
    assert.ok((eventsAfterIngest.body as { events: Array<{ type: string }> }).events.some((event) => event.type === "source.ingested"));
    assert.ok((eventsAfterIngest.body as { events: Array<{ type: string }> }).events.some((event) => event.type === "webhook.github.received"));

    const eventStream = await routeHttpRequest(root, "GET", "/api/v1/events/stream?limit=20&once=true");
    assert.equal(eventStream.status, 200);
    assert.match(eventStream.contentType ?? "", /text\/event-stream/);
    assert.match(String(eventStream.body), /event: source\.ingested/);
    assert.match(String(eventStream.body), /event: webhook\.github\.received/);
    assert.match(String(eventStream.body), /data: \{/);

    const auditExport = await routeHttpRequest(root, "GET", "/api/v1/audit/export?limit=20");
    assert.equal(auditExport.status, 200);
    assert.ok((auditExport.body as { events: unknown[] }).events.length > 0);
    assert.ok((auditExport.body as { counts: { events: number } }).counts.events > 0);
    assert.ok((auditExport.body as { timeline: unknown[]; counts: { timeline: number } }).timeline.length > 0);
    assert.ok((auditExport.body as { timeline: unknown[]; counts: { timeline: number } }).counts.timeline > 0);

    const synthesis = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/synthesis",
      {
        title: "HTTP Synthesis",
        body: "# HTTP Synthesis\n\nHTTP clients can draft synthesis pages as proposals.",
        page_type: "concept",
        topics: ["agents"],
        actor_id: "actor:agent:http-client",
      },
      { token: "http-researcher-secret" },
    );
    assert.equal(synthesis.status, 201);
    assert.equal(
      (synthesis.body as { proposal: { target_path: string } }).proposal.target_path,
      "wiki/concepts/http-synthesis.md",
    );
    const synthesisProposalId = (synthesis.body as { proposal: { id: string } }).proposal.id;

    const httpComment = await routeHttpRequest(
      root,
      "POST",
      `/api/v1/proposals/${encodeURIComponent(synthesisProposalId)}/comments`,
      {
        body: "HTTP proposal comments let clients discuss edits before review.",
        actor_id: "actor:agent:http-client",
      },
      { token: "http-researcher-secret" },
    );
    assert.equal(httpComment.status, 201);
    assert.match((httpComment.body as { comment: { id: string } }).comment.id, /^comment:/);
    const secondHttpComment = await routeHttpRequest(
      root,
      "POST",
      `/api/v1/proposals/${encodeURIComponent(synthesisProposalId)}/comments`,
      {
        body: "Second HTTP proposal comment for cursor pagination.",
        actor_id: "actor:agent:http-client",
      },
      { token: "http-researcher-secret" },
    );
    assert.equal(secondHttpComment.status, 201);

    const httpComments = await routeHttpRequest(
      root,
      "GET",
      `/api/v1/proposals/${encodeURIComponent(synthesisProposalId)}/comments?limit=1`,
    );
    assert.equal(httpComments.status, 200);
    assert.ok((httpComments.body as { next_cursor?: string }).next_cursor);
    const nextHttpComments = await routeHttpRequest(
      root,
      "GET",
      `/api/v1/proposals/${encodeURIComponent(synthesisProposalId)}/comments?limit=1&cursor=${encodeURIComponent(
        (httpComments.body as { next_cursor?: string }).next_cursor ?? "",
      )}`,
    );
    assert.equal(nextHttpComments.status, 200);
    const pagedCommentBodies = [
      (httpComments.body as { comments: Array<{ body: string }> }).comments[0]?.body ?? "",
      (nextHttpComments.body as { comments: Array<{ body: string }> }).comments[0]?.body ?? "",
    ];
    assert.notEqual(pagedCommentBodies[0], pagedCommentBodies[1]);
    assert.ok(
      pagedCommentBodies.some((comment) => /discuss edits/.test(comment)) &&
        pagedCommentBodies.some((comment) => /cursor pagination/.test(comment)),
    );

    const server = await startHttpApi({ root, port: 0 });
    try {
      const home = await fetch(`${server.url}/`);
      assert.equal(home.status, 200);
      assert.match(home.headers.get("content-type") ?? "", /text\/html/);
      const homeHtml = await home.text();
      assert.match(homeHtml, /HTTP Wiki/);
      assert.match(homeHtml, /class="ow-topbar"/);
      assert.match(homeHtml, /href="\/_assets\/openwiki\.css"/);
      assert.match(homeHtml, /src="\/_assets\/openwiki\.js"/);
      assert.match(homeHtml, /data-search-api="\/api\/v1\/search"/);

      const homeHead = await fetch(`${server.url}/`, { method: "HEAD" });
      assert.equal(homeHead.status, 200);
      assert.match(homeHead.headers.get("content-type") ?? "", /text\/html/);
      assert.equal(await homeHead.text(), "");

      const stylesheet = await fetch(`${server.url}/_assets/openwiki.css`);
      assert.equal(stylesheet.status, 200);
      assert.match(stylesheet.headers.get("content-type") ?? "", /text\/css/);
      assert.equal(stylesheet.headers.get("x-content-type-options"), "nosniff");
      assert.equal(stylesheet.headers.get("x-frame-options"), "DENY");
      assert.match(stylesheet.headers.get("content-security-policy") ?? "", /default-src 'self'/);
      const stylesheetEtag = stylesheet.headers.get("etag");
      assert.match(stylesheetEtag ?? "", /^"sha256-[A-Za-z0-9_-]+"$/);
      assert.match(await stylesheet.text(), /\.ow-topbar/);

      const scriptHead = await fetch(`${server.url}/_assets/openwiki.js`, { method: "HEAD" });
      assert.equal(scriptHead.status, 200);
      assert.match(scriptHead.headers.get("content-type") ?? "", /text\/javascript/);
      const scriptEtag = scriptHead.headers.get("etag");
      assert.match(scriptEtag ?? "", /^"sha256-[A-Za-z0-9_-]+"$/);
      assert.equal(await scriptHead.text(), "");

      const conditionalScript = await fetch(`${server.url}/_assets/openwiki.js`, {
        headers: { "if-none-match": scriptEtag ?? "" },
      });
      assert.equal(conditionalScript.status, 304);
      assert.equal(conditionalScript.headers.get("etag"), scriptEtag);
      assert.equal(await conditionalScript.text(), "");

      const themeBootstrap = await fetch(`${server.url}/_assets/theme-bootstrap.js`);
      assert.equal(themeBootstrap.status, 200);
      const themeBootstrapEtag = themeBootstrap.headers.get("etag");
      assert.match(themeBootstrapEtag ?? "", /^"sha256-[A-Za-z0-9_-]+"$/);
      const conditionalThemeBootstrap = await fetch(`${server.url}/_assets/theme-bootstrap.js`, {
        headers: { "if-none-match": themeBootstrapEtag ?? "" },
      });
      assert.equal(conditionalThemeBootstrap.status, 304);

      const deniedAsset = await fetch(`${server.url}/_assets/../openwiki.css`);
      assert.equal(deniedAsset.status, 404);
      assert.equal(deniedAsset.headers.get("x-content-type-options"), "nosniff");
      assert.equal(deniedAsset.headers.get("x-frame-options"), "DENY");

      const invalidJson = await fetch(`${server.url}/api/v1/synthesis`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      assert.equal(invalidJson.status, 400);
      assert.equal(invalidJson.headers.get("x-content-type-options"), "nosniff");
      assert.match(invalidJson.headers.get("content-security-policy") ?? "", /default-src 'self'/);

      const tooDeepJson = await fetch(`${server.url}/api/v1/synthesis`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `${"[".repeat(102)}0${"]".repeat(102)}`,
      });
      assert.equal(tooDeepJson.status, 400);

      const response = await fetch(`${server.url}/api/v1/synthesis`, {
        method: "POST",
        headers: {
          authorization: "Bearer http-researcher-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "HTTP Header Synthesis",
          body: "# HTTP Header Synthesis\n\nBearer tokens can resolve configured OpenWiki service accounts.",
          page_type: "concept",
          topics: ["agents"],
        }),
      });
      assert.equal(response.status, 201);
      const payload = (await response.json()) as { proposal: { target_path: string } };
      assert.equal(payload.proposal.target_path, "wiki/concepts/http-header-synthesis.md");

      const streamedEvents = await fetch(`${server.url}/api/v1/events/stream?once=true&limit=20`);
      assert.equal(streamedEvents.status, 200);
      assert.match(streamedEvents.headers.get("content-type") ?? "", /text\/event-stream/);
      assert.equal(streamedEvents.headers.get("x-content-type-options"), "nosniff");
      assert.equal(streamedEvents.headers.get("referrer-policy"), "no-referrer");
      assert.equal(streamedEvents.headers.get("content-security-policy"), null);
      const streamedEventsText = await streamedEvents.text();
      assert.match(streamedEventsText, /event: source\.ingested/);
      assert.match(streamedEventsText, /data: \{/);

      const mcpResponse = await fetch(`${server.url}/mcp?tools=read`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "http-mcp-tools",
          method: "tools/list",
        }),
      });
      assert.equal(mcpResponse.status, 200);
      const mcpPayload = (await mcpResponse.json()) as { result: { tools: Array<{ name: string }> } };
      assert.ok(mcpPayload.result.tools.some((tool) => tool.name === "wiki.search"));
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.server.close((error) => (error ? reject(error) : resolve()));
      });
    }

    const page = await routeHttpRequest(root, "GET", "/api/v1/pages/page%3Aconcept%3Aagent-memory");
    assert.equal(page.status, 200);
    assert.equal((page.body as { title: string }).title, "Agent Memory");

    const adjacentMarkdown = await routeHttpRequest(root, "GET", "/pages/page%3Aconcept%3Aagent-memory.md");
    assert.equal(adjacentMarkdown.status, 200);
    assert.equal(adjacentMarkdown.contentType, "text/markdown; charset=utf-8");
    assert.match(String(adjacentMarkdown.body), /^---\nid: page:concept:agent-memory/m);
    assert.match(String(adjacentMarkdown.body), /# Agent Memory/);

    const adjacentJson = await routeHttpRequest(root, "GET", "/pages/page%3Aconcept%3Aagent-memory.json");
    assert.equal(adjacentJson.status, 200);
    assert.equal((adjacentJson.body as { id: string }).id, "page:concept:agent-memory");

    const publicMarkdown = await routeHttpRequest(root, "GET", "/concepts/agent-memory.md");
    assert.equal(publicMarkdown.status, 200);
    assert.equal(publicMarkdown.contentType, "text/markdown; charset=utf-8");
    assert.match(String(publicMarkdown.body), /source_ids:/);

    const publicJson = await routeHttpRequest(root, "GET", "/concepts/agent-memory.json");
    assert.equal(publicJson.status, 200);
    assert.equal((publicJson.body as { title: string }).title, "Agent Memory");

    const dashboard = await routeHttpRequest(root, "GET", "/?q=agent%20memory");
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.contentType, "text/html; charset=utf-8");
    assert.match(String(dashboard.body), /class="ow-topbar"/);
    assert.match(String(dashboard.body), /Search wiki/);
    assert.match(String(dashboard.body), /\/_assets\/openwiki\.css/);
    assert.match(String(dashboard.body), /data-search-api="\/api\/v1\/search"/);
    assert.match(String(dashboard.body), /data-search-index=""/);
    assert.match(String(dashboard.body), /Local viewer/);
    assert.match(String(dashboard.body), /Search Results/);
    assert.match(String(dashboard.body), /Proposal Queue/);
    assert.match(String(dashboard.body), /Recent Changes/);
    assert.match(String(dashboard.body), /Open Questions/);
    assert.match(String(dashboard.body), /\/api\/v1\/recent-changes/);
    assert.match(String(dashboard.body), />Graph<\/a>/);
    assert.doesNotMatch(String(dashboard.body), />Runs<\/a>/);
    assert.doesNotMatch(String(dashboard.body), />API<\/a>/);

    const deniedAdmin = await routeHttpRequest(root, "GET", "/admin");
    assert.equal(deniedAdmin.status, 403);
    const adminPage = await routeHttpRequest(root, "GET", "/admin", undefined, { role: "admin" });
    assert.equal(adminPage.status, 200);
    assert.match(String(adminPage.body), /Spaces/);
    assert.match(String(adminPage.body), /Service Accounts/);
    assert.match(String(adminPage.body), /MCP manifest/);
    assert.match(String(adminPage.body), /admin/);

    const spacesPage = await routeHttpRequest(root, "GET", "/spaces", undefined, { role: "admin" });
    assert.equal(spacesPage.status, 200);
    assert.match(String(spacesPage.body), /Spaces/);
    assert.match(String(spacesPage.body), /Create Space/);
    assert.match(String(spacesPage.body), /Edit Space Proposal/);
    assert.match(String(spacesPage.body), /method="get" action="\/spaces\/preview"/);
    assert.match(String(spacesPage.body), /method="post" action="\/policy\/sections\/propose"/);
    assert.match(String(spacesPage.body), /name="viewer_principals"/);
    assert.match(String(spacesPage.body), /Advanced Policy JSON/);

    const policyPage = await routeHttpRequest(root, "GET", "/policy", undefined, { role: "admin" });
    assert.equal(policyPage.status, 200);
    assert.match(String(policyPage.body), /Spaces/);

    const webPage = await routeHttpRequest(root, "GET", "/pages/page%3Aconcept%3Aagent-memory");
    assert.equal(webPage.status, 200);
    assert.match(String(webPage.body), /Agent Memory/);
    assert.match(String(webPage.body), /class="ow-breadcrumb"/);
    assert.match(String(webPage.body), /aria-current="page">Agent Memory/);
    assert.match(String(webPage.body), /class="ow-article-meta"/);
    assert.match(String(webPage.body), /<dt>Status<\/dt>/);
    assert.match(String(webPage.body), /<dt>Updated<\/dt>/);
    assert.match(String(webPage.body), /<dt>Source<\/dt><dd><a href="\/concepts\/agent-memory\.md">Markdown<\/a><\/dd>/);
    assert.match(String(webPage.body), /<dt>Data<\/dt><dd><a href="\/concepts\/agent-memory\.json">JSON<\/a><\/dd>/);
    assert.match(String(webPage.body), /class="ow-record-actions"/);
    assert.match(String(webPage.body), /data-openwiki-lazy-sidebar/);
    assert.match(String(webPage.body), /data-openwiki-sidebar-groups-src="\/api\/v1\/records\?type=page&amp;group_by=page_type&amp;limit=1"/);
    assert.match(String(webPage.body), /data-openwiki-copy-citation=/);
    assert.match(String(webPage.body), /Preview source/);
    assert.match(String(webPage.body), /Trace claim/);
    assert.match(String(webPage.body), /class="ow-prose"/);
    assert.match(String(webPage.body), /data-openwiki-graph-detail/);
    assert.match(String(webPage.body), /Continue Reading/);
    assert.match(String(webPage.body), /Open In Graph/);
    assert.match(String(webPage.body), /\/graph\?focus=page%3Aconcept%3Aagent-memory/);
    assert.match(String(webPage.body), /Machine Readable/);
    assert.match(String(webPage.body), /Governance/);
    assert.match(String(webPage.body), /History/);
    assert.match(String(webPage.body), /\/concepts\/agent-memory\.md/);

    const adminWebPage = await routeHttpRequest(root, "GET", "/pages/page%3Aconcept%3Aagent-memory", undefined, {
      role: "admin",
      actorId: "actor:user:admin-user",
    });
    assert.equal(adminWebPage.status, 200);
    assert.match(String(adminWebPage.body), />Admin<\/a>/);
    assert.match(String(adminWebPage.body), /Actor: actor:user:admin-user/);

    const deniedWebEditForm = await routeHttpRequest(root, "GET", "/pages/page%3Aconcept%3Aagent-memory/edit");
    assert.equal(deniedWebEditForm.status, 403);

    const webEditForm = await routeHttpRequest(root, "GET", "/pages/page%3Aconcept%3Aagent-memory/edit", undefined, {
      role: "admin",
      actorId: "actor:user:admin-user",
    });
    assert.equal(webEditForm.status, 200);
    assert.match(String(webEditForm.body), /Create Proposal/);
    assert.match(String(webEditForm.body), />Admin<\/a>/);
    assert.match(String(webEditForm.body), /Actor: actor:user:admin-user/);
    assert.match(String(webEditForm.body), /method="post" action="\/pages\/page%3Aconcept%3Aagent-memory\/propose"/);
    assert.match(String(webEditForm.body), /name="actor_id"/);
    assert.match(String(webEditForm.body), /name="title"/);
    assert.match(String(webEditForm.body), /name="summary"/);
    assert.match(String(webEditForm.body), /name="body"/);
    assert.match(String(webEditForm.body), /name="rationale"/);
    assert.match(String(webEditForm.body), /class="[^"]*markdown-editor/);
    assert.match(String(webEditForm.body), /data-openwiki-markdown-preview/);
    assert.match(String(webEditForm.body), /Markdown is rendered safely/);

    const webSource = await routeHttpRequest(root, "GET", "/sources/source%3A2026-05-21-001");
    assert.equal(webSource.status, 200);
    assert.match(String(webSource.body), /OpenWiki Protocol Draft/);
    assert.match(String(webSource.body), /class="ow-breadcrumb"/);
    assert.match(String(webSource.body), /class="ow-article-meta"/);
    assert.match(String(webSource.body), /<dt>Retrieved<\/dt>/);
    assert.match(String(webSource.body), /<dt>Data<\/dt><dd><a href="\/sources\/source%3A2026-05-21-001\.json">JSON<\/a><\/dd>/);
    assert.match(String(webSource.body), /<dt>Content<\/dt><dd><a href="\/api\/v1\/sources\/source%3A2026-05-21-001\/content">JSON<\/a><\/dd>/);
    assert.match(String(webSource.body), /class="ow-record-actions"/);
    assert.match(String(webSource.body), /data-openwiki-copy-citation=/);
    assert.match(String(webSource.body), /Pages/);
    assert.match(String(webSource.body), /data-graph-mode="local"/);
    assert.match(String(webSource.body), /Open workspace graph/);

    const adjacentSourceJson = await routeHttpRequest(root, "GET", "/sources/source%3A2026-05-21-001.json");
    assert.equal(adjacentSourceJson.status, 200);
    assert.equal((adjacentSourceJson.body as { id: string }).id, "source:2026-05-21-001");

    const sourceList = await routeHttpRequest(root, "GET", "/api/v1/sources?limit=5");
    assert.equal(sourceList.status, 200);
    assert.ok((sourceList.body as { sources: Array<{ id: string }> }).sources.some((source) => source.id === "source:2026-05-21-001"));

    const webClaim = await routeHttpRequest(root, "GET", "/claims/claim%3A2026-05-21-001");
    assert.equal(webClaim.status, 200);
    assert.match(String(webClaim.body), /OpenWiki stores/);
    assert.match(String(webClaim.body), /class="ow-breadcrumb"/);
    assert.match(String(webClaim.body), /class="ow-article-meta"/);
    assert.match(String(webClaim.body), /<dt>Status<\/dt>/);
    assert.match(String(webClaim.body), /<dt>Trace<\/dt><dd><a href="\/api\/v1\/claims\/claim%3A2026-05-21-001\/trace">JSON<\/a><\/dd>/);
    assert.match(String(webClaim.body), /class="ow-record-actions"/);
    assert.match(String(webClaim.body), /data-openwiki-copy-citation=/);
    assert.match(String(webClaim.body), /Confidence/);
    assert.match(String(webClaim.body), /Trace JSON/);
    assert.match(String(webClaim.body), /data-graph-mode="local"/);

    const adjacentClaimJson = await routeHttpRequest(root, "GET", "/claims/claim%3A2026-05-21-001.json");
    assert.equal(adjacentClaimJson.status, 200);
    assert.equal((adjacentClaimJson.body as { id: string }).id, "claim:2026-05-21-001");

    const sourceHistory = await routeHttpRequest(root, "GET", "/api/v1/sources/source%3A2026-05-21-001/history");
    assert.equal(sourceHistory.status, 200);
    assert.equal((sourceHistory.body as { record_id: string }).record_id, "source:2026-05-21-001");

    const claimHistory = await routeHttpRequest(root, "GET", "/api/v1/claims/claim%3A2026-05-21-001/history");
    assert.equal(claimHistory.status, 200);
    assert.equal((claimHistory.body as { record_id: string }).record_id, "claim:2026-05-21-001");

    const claimTrace = await routeHttpRequest(root, "GET", "/api/v1/claims/claim%3A2026-05-21-001/trace");
    assert.equal(claimTrace.status, 200);
    assert.equal((claimTrace.body as { evidence_summary: { source_count: number } }).evidence_summary.source_count, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP readiness requires derived search and index-store state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-readiness-"));
  try {
    await createWorkspace(root, "Readiness Wiki");

    const missing = await routeHttpRequest(root, "GET", "/readyz");
    assert.equal(missing.status, 503);
    assert.equal((missing.body as { status: string }).status, "not_ready");
    const missingComponents = (missing.body as {
      health?: {
        components?: {
          index_store?: { ok?: boolean; issues?: string[] };
          search_index?: { status?: string; issues?: string[] };
        };
      };
    }).health?.components;
    assert.equal(missingComponents?.index_store?.ok, false);
    assert.match(missingComponents?.index_store?.issues?.join("\n") ?? "", /openwiki db rebuild/);
    assert.equal(missingComponents?.search_index?.status, "missing");
    assert.match(missingComponents?.search_index?.issues?.join("\n") ?? "", /openwiki index/);

    await Promise.all([buildSearchIndex(root), rebuildIndexStore(root)]);

    const ready = await routeHttpRequest(root, "GET", "/readyz");
    assert.equal(ready.status, 200);
    assert.equal((ready.body as { status: string }).status, "ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("health metrics treat hosted skipped local stores as healthy", () => {
  assert.equal(componentHealthMetric({ status: "skipped", backend: "postgres", issues: [] }), 1);
  assert.equal(componentHealthMetric({ status: "missing", issues: ["run openwiki index"] }), 0);
});

test("hosted readiness requires Postgres-backed serving and queue stores", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-hosted-readiness-"));
  const oldRuntimeMode = process.env.OPENWIKI_RUNTIME_MODE;
  const oldRuntimeBackend = process.env.OPENWIKI_RUNTIME_BACKEND;
  const oldReadBackend = process.env.OPENWIKI_READ_BACKEND;
  const oldSearchBackend = process.env.OPENWIKI_SEARCH_BACKEND;
  const oldQueueBackend = process.env.OPENWIKI_QUEUE_BACKEND;
  const oldOperationalBackend = process.env.OPENWIKI_OPERATIONAL_STATE_BACKEND;
  const oldDatabase = process.env.DATABASE_URL;
  const oldOpenWikiDatabase = process.env.OPENWIKI_DATABASE_URL;
  try {
    await createWorkspace(root, "Hosted Readiness Wiki");
    await Promise.all([buildSearchIndex(root), rebuildIndexStore(root)]);
    await setRuntimeProfile(root, "hosted");
    delete process.env.OPENWIKI_RUNTIME_MODE;
    delete process.env.OPENWIKI_RUNTIME_BACKEND;
    delete process.env.OPENWIKI_READ_BACKEND;
    delete process.env.OPENWIKI_SEARCH_BACKEND;
    delete process.env.OPENWIKI_QUEUE_BACKEND;
    delete process.env.OPENWIKI_OPERATIONAL_STATE_BACKEND;
    delete process.env.DATABASE_URL;
    delete process.env.OPENWIKI_DATABASE_URL;

    const unauthenticatedReadiness = await routeHttpRequest(root, "GET", "/readyz");
    assert.equal(unauthenticatedReadiness.status, 503);
    assert.equal((unauthenticatedReadiness.body as { status?: string; health?: unknown }).status, "not_ready");
    assert.equal((unauthenticatedReadiness.body as { health?: unknown }).health, undefined);

    const readiness = await routeHttpRequest(root, "GET", "/healthz", undefined, {
      actorId: "actor:user:ops",
      role: "admin",
    });
    assert.equal(readiness.status, 200);
    assert.equal((readiness.body as { status: string }).status, "degraded");
    const runtimeMode = (readiness.body as {
      components?: {
        runtime_mode?: {
          status?: string;
          mode?: string;
          read_backend?: string;
          search_backend?: string;
          queue_backend?: string;
          operational_state_backend?: string;
          issues?: string[];
        };
      };
    }).components?.runtime_mode;
    assert.equal(runtimeMode?.status, "degraded");
    assert.equal(runtimeMode?.mode, "hosted");
    assert.equal(runtimeMode?.read_backend, "local");
    assert.equal(runtimeMode?.search_backend, "sqlite");
    assert.equal(runtimeMode?.queue_backend, "local");
    assert.equal(runtimeMode?.operational_state_backend, "memory");
    const issues = runtimeMode?.issues?.join("\n") ?? "";
    assert.match(issues, /OPENWIKI_DATABASE_URL or DATABASE_URL/);
    assert.match(issues, /OPENWIKI_READ_BACKEND=postgres/);
    assert.match(issues, /OPENWIKI_SEARCH_BACKEND=postgres/);
    assert.match(issues, /OPENWIKI_QUEUE_BACKEND=postgres/);
    assert.match(issues, /OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres/);

    const unresolvedToken = await routeHttpRequest(root, "GET", "/api/v1/capabilities", undefined, {
      token: "not-a-service-account-token",
    });
    assert.equal(unresolvedToken.status, 401);

    await addServiceAccount(root, {
      id: "hosted-agent",
      actor_id: "actor:agent:hosted-agent",
      role: "viewer",
      token_hashes: [hashOpenWikiToken("hosted-agent-secret")],
    });
    const resolvedToken = await routeHttpRequest(root, "GET", "/api/v1/capabilities", undefined, {
      token: "hosted-agent-secret",
    });
    assert.equal(resolvedToken.status, 200);

    const server = await startHttpApi({ root, port: 0 });
    try {
      const mcp = await fetch(`${server.url}/mcp?tools=read`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: {} }),
      });
      assert.equal(mcp.status, 401);
      const events = await fetch(`${server.url}/api/v1/events/stream`);
      assert.equal(events.status, 401);
    } finally {
      await server.close({ timeoutMs: 1000 });
    }
  } finally {
    restoreEnv("OPENWIKI_RUNTIME_MODE", oldRuntimeMode);
    restoreEnv("OPENWIKI_RUNTIME_BACKEND", oldRuntimeBackend);
    restoreEnv("OPENWIKI_READ_BACKEND", oldReadBackend);
    restoreEnv("OPENWIKI_SEARCH_BACKEND", oldSearchBackend);
    restoreEnv("OPENWIKI_QUEUE_BACKEND", oldQueueBackend);
    restoreEnv("OPENWIKI_OPERATIONAL_STATE_BACKEND", oldOperationalBackend);
    restoreEnv("DATABASE_URL", oldDatabase);
    restoreEnv("OPENWIKI_DATABASE_URL", oldOpenWikiDatabase);
    await rm(root, { recursive: true, force: true });
  }
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

async function setRuntimeProfile(root: string, profile: string): Promise<void> {
  const configPath = path.join(root, "openwiki.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { runtime?: Record<string, unknown> };
  config.runtime = { ...(config.runtime ?? {}), profile };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
