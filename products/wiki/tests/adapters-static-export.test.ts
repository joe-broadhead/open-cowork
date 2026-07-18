import { routeHttpRequest } from "@openwiki/http-api";
import { scopesForRole } from "@openwiki/policy";
import { createWorkspace } from "@openwiki/repo";
import { exportStaticSite } from "@openwiki/static-export";
import { createSynthesis, ingestSource, proposeEdit, reviewProposal } from "@openwiki/workflows";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("static export writes machine-readable artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-static-"));
  try {
    await createWorkspace(root, "Static Wiki");
    const source = await ingestSource({
      root,
      title: "Static Export Evidence",
      sourceType: "manual",
      content: "Static export should expose captured public source fragments for browser-side and agent search.",
      actorId: "actor:user:researcher",
      trust: { sensitivity: "public", reliability: "medium" },
    });
    const sourceManifestPath = path.join(root, source.source.path);
    await writeFile(sourceManifestPath, (await readFile(sourceManifestPath, "utf8")) + "\nurl: javascript:alert(1)\n");
    await createSynthesis({
      root,
      title: "Static Graph Navigation",
      pageType: "concept",
      summary: "Static export page that links back to Agent Memory.",
      body: "# Static Graph Navigation\n\nThis static page links to [[agent-memory]], [Agent Memory relative](./agent-memory.md), and [protocol relative](//evil.example/path) so exported pages can show backlinks.",
      actorId: "actor:user:static-reviewer",
      rationale: "Exercise static backlinks.",
      decisionRationale: "Static backlink test page is scoped.",
    });
    await createSynthesis({
      root,
      title: "Topic Focus Encoding",
      pageType: "concept",
      summary: "Static export page for topic focus link encoding.",
      body: "# Topic Focus Encoding\n\nThis page exercises topic graph links.",
      topics: ["Q&A"],
      actorId: "actor:user:static-reviewer",
      rationale: "Exercise slugged topic focus links.",
      decisionRationale: "Topic focus test page is scoped.",
    });
    const proposal = await proposeEdit({
      root,
      pageId: "page:concept:agent-memory",
      body: "# Agent Memory\n\nStatic export proposals should keep graph context.",
      actorId: "actor:user:static-reviewer",
      rationale: "Exercise static proposal and decision pages.",
    });
    const decision = await reviewProposal({
      root,
      proposalId: proposal.proposal.id,
      decision: "accepted",
      rationale: "Static export graph context reviewed.",
      actorId: "actor:user:maintainer",
    });
    await execFileAsync("git", ["-C", root, "init", "--initial-branch", "master"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "OpenWiki Test"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "openwiki@example.com"]);
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "Static export fixture"]);
    const result = await exportStaticSite({ root, outDir: "public", baseUrl: "https://wiki.example.com", sitemapShardSize: 2 });
    assert.equal(result.html_mode, "full");
    assert.ok(result.html_page_count <= result.html_page_ceiling);
    assert.deepEqual(result.warnings, []);
    assert.ok(result.files.includes("search-index.json"));
    assert.ok(result.files.includes("search-records.jsonl"));
    assert.ok(result.files.includes("pages.jsonl"));
    assert.ok(result.files.includes("llms.txt"));
    assert.ok(result.files.includes("llms-full.txt"));
    assert.ok(result.files.includes("openapi.json"));
    assert.ok(result.files.includes("mcp-manifest.json"));
    assert.ok(result.files.includes("static-export-report.json"));
    assert.ok(result.files.includes("sitemap.xml"));
    assert.ok(result.files.includes("sitemaps/sitemap-1.xml"));
    assert.ok(result.files.includes("sitemaps/sitemap-2.xml"));
    assert.ok(result.files.includes("topics.json"));
    assert.ok(result.files.includes("open-questions.json"));
    assert.ok(result.files.includes("graph-report.json"));
    assert.ok(result.files.includes("graph-report.html"));
    assert.ok(result.files.includes("agents/index.md"));
    assert.ok(result.files.includes("proposals.json"));
    assert.ok(result.files.includes("proposal-comments.jsonl"));
    assert.ok(result.files.includes("events.jsonl"));
    assert.ok(result.files.includes("events.json"));
    assert.ok(result.files.includes("runs.jsonl"));
    assert.ok(result.files.includes("runs.json"));
    assert.ok(result.files.some((file) => /^assets\/openwiki\.[a-f0-9]+\.css$/.test(file)));
    assert.ok(result.files.some((file) => /^assets\/openwiki\.[a-f0-9]+\.js$/.test(file)));
    assert.ok(result.files.includes("assets/assets-manifest.json"));
    assert.ok(result.files.includes("assets/graph/fetch.js"));
    assert.ok(result.files.includes("graph.html"));
    assert.ok(result.files.includes("topics.html"));
    assert.ok(result.files.includes("changes.html"));
    assert.ok(result.files.includes("concepts/agent-memory.html"));
    assert.ok(result.files.includes("concepts/agent-memory.md"));
    assert.ok(result.files.includes("concepts/agent-memory.json"));
    assert.ok(result.files.includes("sources/2026-05-21-001.html"));
    assert.ok(result.files.includes("sources/2026-05-21-001.json"));
    assert.ok(result.files.includes("claims/2026-05-21-001.html"));
    assert.ok(result.files.includes("claims/2026-05-21-001.json"));
    assert.ok(result.files.includes(`${proposal.proposal.id.replace("proposal:", "proposals/")}.html`));
    assert.ok(result.files.includes(`${decision.decision.id.replace("decision:", "decisions/")}.html`));
    assert.ok(result.files.includes(`${source.source.id.replace("source:", "sources/")}.html`));
    assert.ok(result.files.includes(`${source.source.id.replace("source:", "sources/")}.json`));

    const indexHtml = await readFile(path.join(result.outDir, "index.html"), "utf8");
    assert.match(indexHtml, /class="ow-topbar"/);
    assert.match(indexHtml, /data-openwiki-search-trigger/);
    assert.match(indexHtml, /data-openwiki-sidebar-toggle/);
    assert.match(indexHtml, /data-openwiki-sidebar-close/);
    assert.match(indexHtml, /id="openwiki-sidebar"/);
    assert.match(indexHtml, /data-openwiki-sidebar-filter/);
    assert.match(indexHtml, /data-openwiki-sidebar-group/);
    assert.match(indexHtml, /data-search-index="search-index\.json"/);
    assert.match(indexHtml, /data-search-api=""/);
    assert.match(indexHtml, /Knowledge Map/);
    assert.match(indexHtml, /data-graph-src="graph\.json"/);
    assert.match(indexHtml, /data-graph-mode="preview"/);
    assert.match(indexHtml, /data-openwiki-graph-canvas role="img" tabindex="0"/);
    assert.match(indexHtml, /href="assets\/openwiki\.[a-f0-9]+\.css"/);
    assert.match(indexHtml, /href="concepts\/agent-memory\.html"/);
    assert.doesNotMatch(indexHtml, /href="\/assets\//);
    const pageHtml = await readFile(path.join(result.outDir, "concepts", "agent-memory.html"), "utf8");
    assert.match(pageHtml, /class="ow-breadcrumb"/);
    assert.match(pageHtml, /aria-current="page">Agent Memory/);
    assert.match(pageHtml, /<li class="is-active">\s*<div class="ow-record-list__title">[\s\S]*aria-current="page" href="\.\.\/concepts\/agent-memory\.html"/);
    assert.match(pageHtml, /class="ow-article-meta"/);
    assert.match(pageHtml, /<dt>Status<\/dt>/);
    assert.match(pageHtml, /<dt>Updated<\/dt>/);
    assert.match(pageHtml, /<dt>Source<\/dt><dd><a href="\.\.\/concepts\/agent-memory\.md">Markdown<\/a><\/dd>/);
    assert.match(pageHtml, /<dt>Data<\/dt><dd><a href="\.\.\/concepts\/agent-memory\.json">JSON<\/a><\/dd>/);
    assert.match(pageHtml, /class="ow-prose"/);
    assert.match(pageHtml, /Backlinks/);
    assert.match(pageHtml, /Static Graph Navigation/);
    assert.match(pageHtml, /Related/);
    assert.match(pageHtml, /page_source/);
    assert.match(pageHtml, /Continue Reading/);
    assert.match(pageHtml, /Open In Graph/);
    assert.match(pageHtml, /graph\.html\?focus=page%3Aconcept%3Aagent-memory/);
    assert.match(pageHtml, /data-openwiki-graph/);
    assert.match(pageHtml, /data-openwiki-graph-search/);
    assert.match(pageHtml, /data-openwiki-graph-depth/);
    assert.match(pageHtml, /data-openwiki-graph-node-legend/);
    assert.match(pageHtml, /data-openwiki-graph-search-results/);
    assert.match(pageHtml, /data-openwiki-graph-orphans/);
    assert.match(pageHtml, /data-openwiki-graph-fullscreen/);
    assert.match(pageHtml, /href="\.\.\/assets\/openwiki\.[a-f0-9]+\.css"/);
    assert.match(pageHtml, /href="\.\.\/concepts\/agent-memory\.md"/);
    assert.doesNotMatch(pageHtml, /href="\/assets\//);
    const staticGraphNavigationUnsafeHrefHtml = await readFile(path.join(result.outDir, "concepts", "static-graph-navigation.html"), "utf8");
    assert.match(staticGraphNavigationUnsafeHrefHtml, /protocol relative/);
    assert.doesNotMatch(staticGraphNavigationUnsafeHrefHtml, /href="\/\/evil\.example/);
    const sourceHtml = await readFile(path.join(result.outDir, "sources", "2026-05-21-001.html"), "utf8");
    assert.match(sourceHtml, /class="ow-article-meta"/);
    assert.match(sourceHtml, /<dt>Retrieved<\/dt>/);
    assert.match(sourceHtml, /<dt>Data<\/dt><dd><a href="\.\.\/sources\/2026-05-21-001\.json">JSON<\/a><\/dd>/);
    const unsafeSourceHtml = await readFile(path.join(result.outDir, `${source.source.id.replace("source:", "sources/")}.html`), "utf8");
    assert.match(unsafeSourceHtml, /javascript:alert\(1\)/);
    assert.doesNotMatch(unsafeSourceHtml, /href="javascript:/);
    const claimHtml = await readFile(path.join(result.outDir, "claims", "2026-05-21-001.html"), "utf8");
    assert.match(claimHtml, /class="ow-article-meta"/);
    assert.match(claimHtml, /<dt>Confidence<\/dt>/);
    assert.match(claimHtml, /<dt>Data<\/dt><dd><a href="\.\.\/claims\/2026-05-21-001\.json">JSON<\/a><\/dd>/);
    const graphHtml = await readFile(path.join(result.outDir, "graph.html"), "utf8");
    assert.match(graphHtml, /Workspace Graph/);
    assert.match(graphHtml, /data-graph-src="graph\.json"/);
    assert.match(graphHtml, /graph-report\.html/);
    const graphReportJson = JSON.parse(await readFile(path.join(result.outDir, "graph-report.json"), "utf8")) as {
      schema_version: string;
      hub_nodes: Array<{ id: string }>;
      suggested_questions: Array<{ question: string }>;
    };
    assert.equal(graphReportJson.schema_version, "openwiki-graph-analysis-v1");
    assert.ok(graphReportJson.hub_nodes.some((node) => node.id === "page:concept:agent-memory"));
    assert.ok(graphReportJson.suggested_questions.length > 0);
    const graphReportHtml = await readFile(path.join(result.outDir, "graph-report.html"), "utf8");
    assert.match(graphReportHtml, /Graph Report/);
    assert.match(graphReportHtml, /Hub Nodes/);
    assert.match(graphReportHtml, /Missing Link Candidates/);
    assert.match(graphReportHtml, /agents\/index\.md/);
    const agentGuide = await readFile(path.join(result.outDir, "agents", "index.md"), "utf8");
    assert.match(agentGuide, /Agent Graph Guide/);
    assert.match(agentGuide, /graph-report\.json/);
    assert.match(agentGuide, /\.\.\/concepts\/agent-memory\.md/);
    const staticGraphNavigationHtml = await readFile(path.join(result.outDir, "concepts", "static-graph-navigation.html"), "utf8");
    assert.match(staticGraphNavigationHtml, /href="\.\.\/concepts\/agent-memory\.html">Agent Memory relative<\/a>/);
    assert.doesNotMatch(staticGraphNavigationHtml, /href="https:\/\/wiki\.example\.com\/agent-memory/);
    assert.match(graphHtml, /data-openwiki-graph-depth/);
    assert.match(graphHtml, /data-openwiki-graph-node-legend/);
    assert.match(graphHtml, /data-openwiki-graph-edge-legend/);
    assert.match(graphHtml, /data-openwiki-graph-fit/);
    assert.match(graphHtml, /data-openwiki-graph-fullscreen/);
    assert.match(graphHtml, /data-openwiki-graph-detail/);
    const proposalHtml = await readFile(path.join(result.outDir, `${proposal.proposal.id.replace("proposal:", "proposals/")}.html`), "utf8");
    assert.match(proposalHtml, /class="ow-breadcrumb"/);
    assert.match(proposalHtml, /class="ow-article-meta"/);
    assert.match(proposalHtml, /<dt>Status<\/dt>/);
    assert.match(proposalHtml, /data-graph-mode="local"/);
    assert.match(proposalHtml, /\.\.\/graph\.json/);
    const decisionHtml = await readFile(path.join(result.outDir, `${decision.decision.id.replace("decision:", "decisions/")}.html`), "utf8");
    assert.match(decisionHtml, /class="ow-breadcrumb"/);
    assert.match(decisionHtml, /class="ow-article-meta"/);
    assert.match(decisionHtml, /<dt>Decision<\/dt>/);
    assert.match(decisionHtml, /data-graph-mode="local"/);
    assert.match(decisionHtml, /\.\.\/graph\.json/);
    const sitemap = await readFile(path.join(result.outDir, "sitemap.xml"), "utf8");
    assert.match(sitemap, /<sitemapindex/);
    assert.match(sitemap, /sitemaps\/sitemap-1\.xml/);
    const sitemapShard = await readFile(path.join(result.outDir, "sitemaps", "sitemap-1.xml"), "utf8");
    const allSitemapShards = await Promise.all(result.sitemap_files.filter((file) => file.startsWith("sitemaps/")).map((file) => readFile(path.join(result.outDir, file), "utf8")));
    assert.ok(allSitemapShards.some((body) => /concepts\/agent-memory\.html/.test(body)));
    assert.doesNotMatch(sitemapShard + allSitemapShards.join("\n"), /concepts\/agent-memory\.md/);

    const llms = await readFile(path.join(result.outDir, "llms.txt"), "utf8");
    assert.match(llms, /Agent Memory/);
    assert.match(llms, /concepts\/agent-memory\.md/);
    const exportedMarkdown = await readFile(path.join(result.outDir, "concepts", "agent-memory.md"), "utf8");
    assert.match(exportedMarkdown, /^---\nid: page:concept:agent-memory/m);
    const exportedSourceJson = JSON.parse(await readFile(path.join(result.outDir, "sources", "2026-05-21-001.json"), "utf8")) as {
      id: string;
    };
    assert.equal(exportedSourceJson.id, "source:2026-05-21-001");
    const exportedClaimJson = JSON.parse(await readFile(path.join(result.outDir, "claims", "2026-05-21-001.json"), "utf8")) as {
      id: string;
    };
    assert.equal(exportedClaimJson.id, "claim:2026-05-21-001");
    const searchIndex = JSON.parse(await readFile(path.join(result.outDir, "search-index.json"), "utf8")) as {
      visibility: string;
      records: Array<{ id: string; type: string; search_text: string }>;
    };
    assert.equal(searchIndex.visibility, "public");
    assert.ok(searchIndex.records.some((record) => record.id === "page:concept:agent-memory"));
    assert.ok(searchIndex.records.some((record) => record.id.startsWith(`fragment:${source.source.id}:`)));
    assert.ok(searchIndex.records.some((record) => record.type === "event" && /source\.ingested/.test(record.search_text)));
    const searchRecords = await readFile(path.join(result.outDir, "search-records.jsonl"), "utf8");
    assert.match(searchRecords, /Static export should expose captured public source fragments/);
    const recentChanges = await readFile(path.join(result.outDir, "recent-changes.json"), "utf8");
    assert.match(recentChanges, /is_git_repo/);
    const topicsHtml = await readFile(path.join(result.outDir, "topics.html"), "utf8");
    assert.match(topicsHtml, /id="topic-agents"/);
    assert.match(topicsHtml, /View topic in graph/);
    assert.match(topicsHtml, /graph\.html\?focus=topic%3Aagents&amp;types=page%2Ctopic/);
    assert.match(topicsHtml, /id="topic-q-a"/);
    assert.match(topicsHtml, /graph\.html\?focus=topic%3Aq-a&amp;types=page%2Ctopic/);
    assert.doesNotMatch(topicsHtml, /focus=topic%3AQ%26A/);
    assert.match(topicsHtml, /href="concepts\/agent-memory\.html"/);
    const changesHtml = await readFile(path.join(result.outDir, "changes.html"), "utf8");
    assert.match(changesHtml, /class="ow-timeline"/);
    assert.match(changesHtml, /class="ow-timeline__day"/);
    assert.match(changesHtml, /<time datetime="\d{4}-\d{2}-\d{2}">/);

    const report = JSON.parse(await readFile(path.join(result.outDir, "static-export-report.json"), "utf8")) as {
      html_mode: string;
      sitemap_files: string[];
      warnings: string[];
    };
    assert.equal(report.html_mode, "full");
    assert.ok(report.sitemap_files.includes("sitemap.xml"));
    assert.deepEqual(report.warnings, []);

    const machineOnly = await exportStaticSite({ root, outDir: "machine-public", baseUrl: "https://wiki.example.com", htmlPageCeiling: 1, llmsFullMaxBytes: 64 });
    assert.equal(machineOnly.html_mode, "machine-only");
    assert.ok(machineOnly.warnings.some((warning) => /HTML export skipped/.test(warning)));
    assert.ok(machineOnly.warnings.some((warning) => /llms-full\.txt was reduced/.test(warning)));
    assert.ok(machineOnly.files.includes("index.html"));
    assert.ok(machineOnly.files.includes("search-index.json"));
    assert.ok(machineOnly.files.includes("graph-report.json"));
    assert.ok(machineOnly.files.includes("agents/index.md"));
    assert.ok(machineOnly.files.includes("pages.jsonl"));
    assert.ok(machineOnly.files.includes("concepts/agent-memory.md"));
    assert.ok(machineOnly.files.includes("concepts/agent-memory.json"));
    assert.ok(machineOnly.files.includes("static-export-report.json"));
    assert.ok(machineOnly.files.includes("sitemap.xml"));
    assert.ok(machineOnly.files.includes("sitemaps/sitemap-1.xml"));
    assert.ok(!machineOnly.files.includes("concepts/agent-memory.html"));
    assert.ok(!machineOnly.files.includes("graph.html"));
    assert.ok(!machineOnly.files.includes("graph-report.html"));
    const machineIndex = await readFile(path.join(machineOnly.outDir, "index.html"), "utf8");
    assert.match(machineIndex, /Machine-readable export/);
    assert.doesNotMatch(machineIndex, /href="graph\.html"/);
    assert.doesNotMatch(machineIndex, /href="topics\.html"/);
    assert.doesNotMatch(machineIndex, /href="changes\.html"/);
    assert.match(machineIndex, /href="graph\.json"/);
    assert.match(machineIndex, /href="graph-report\.json"/);
    const machineLlmsFull = await readFile(path.join(machineOnly.outDir, "llms-full.txt"), "utf8");
    assert.match(machineLlmsFull, /was reduced/);
    assert.doesNotMatch(machineLlmsFull, /Static export proposals should keep graph context/);

    const manifest = await readFile(path.join(result.outDir, "mcp-manifest.json"), "utf8");
    assert.match(manifest, /wiki.ask/);
    assert.match(manifest, /wiki.get_history/);
    assert.match(manifest, /wiki.diff_versions/);
    assert.match(manifest, /wiki.list_recent_changes/);
    assert.match(manifest, /wiki.list_events/);
    assert.match(manifest, /wiki.list_runs/);
    assert.match(manifest, /wiki.run_job/);
    assert.match(manifest, /wiki.list_topics/);
    assert.match(manifest, /wiki.list_open_questions/);
    assert.match(manifest, /wiki.detect_governance/);
    assert.match(manifest, /wiki.list_proposals/);
    assert.match(manifest, /wiki.read_proposal_detail/);
    assert.match(manifest, /wiki.propose_synthesis/);
    assert.match(manifest, /wiki.create_synthesis/);
    assert.match(manifest, /wiki.propose_source/);
    assert.match(manifest, /wiki.comment_on_proposal/);
    assert.match(manifest, /wiki.ingest_source/);
    assert.match(manifest, /wiki.fetch_source/);
    assert.match(manifest, /wiki.commit_changes/);
    assert.match(manifest, /wiki.git_status/);
    assert.match(manifest, /wiki.git_pull/);
    assert.match(manifest, /wiki.git_push/);
    assert.match(manifest, /wiki.publish/);
    assert.match(manifest, /"http_endpoint": "\/mcp"/);
    assert.match(manifest, /"streamable_http"/);
    assert.match(manifest, /"session_header": "MCP-Session-Id"/);
    assert.match(manifest, /"tool_output"/);
    assert.match(manifest, /"OPENWIKI_MCP_TOOL_OUTPUT_MAX_BYTES"/);
    assert.match(manifest, /openwiki:\/\/source\/\{source_id\}/);
    assert.match(manifest, /openwiki:\/\/claim\/\{claim_id\}/);
    assert.match(manifest, /openwiki:\/\/commit\/\{sha\}/);
    assert.match(manifest, /research_topic/);
    assert.match(manifest, /compare_sources/);
    assert.match(manifest, /prepare_briefing/);
    const openapi = await readFile(path.join(result.outDir, "openapi.json"), "utf8");
    assert.match(openapi, /"\/mcp"/);
    assert.match(openapi, /\/api\/v1\/ask/);
    assert.match(openapi, /\/api\/v1\/lint/);
    assert.match(openapi, /\/api\/v1\/publish/);
    assert.match(openapi, /\/api\/v1\/commit/);
    assert.match(openapi, /\/api\/v1\/git\/status/);
    assert.match(openapi, /\/api\/v1\/git\/pull/);
    assert.match(openapi, /\/api\/v1\/git\/push/);
    assert.match(openapi, /\/api\/v1\/topics/);
    assert.match(openapi, /\/api\/v1\/open-questions/);
    assert.match(openapi, /\/api\/v1\/governance\/detectors/);
    assert.match(openapi, /\/api\/v1\/pages\/\{id\}\/history/);
    assert.match(openapi, /\/api\/v1\/pages\/\{id\}\/diff/);
    assert.match(openapi, /\/api\/v1\/sources\/\{id\}\/content/);
    assert.match(openapi, /\/api\/v1\/sources\/\{id\}\/history/);
    assert.match(openapi, /\/api\/v1\/claims\/\{id\}\/trace/);
    assert.match(openapi, /\/api\/v1\/claims\/\{id\}\/history/);
    assert.match(openapi, /\/api\/v1\/decisions\/\{id\}/);
    assert.match(openapi, /\/api\/v1\/decisions\/\{id\}\/history/);
    assert.match(openapi, /\/api\/v1\/sources\/ingest/);
    assert.match(openapi, /\/api\/v1\/sources\/propose/);
    assert.match(openapi, /\/api\/v1\/sources\/fetch/);
    assert.match(openapi, /\/api\/v1\/proposals/);
    assert.match(openapi, /\/api\/v1\/proposals\/\{id\}\/detail/);
    assert.match(openapi, /\/api\/v1\/proposals\/\{id\}\/diff/);
    assert.match(openapi, /\/api\/v1\/proposals\/\{id\}\/comments/);
    assert.match(openapi, /\/api\/v1\/synthesis/);
    assert.match(openapi, /\/api\/v1\/synthesis\/create/);
    assert.match(openapi, /\/api\/v1\/events/);
    assert.match(openapi, /\/api\/v1\/events\/stream/);
    assert.match(openapi, /\/api\/v1\/runs/);
    assert.match(openapi, /\/api\/v1\/runs\/monitor/);
    assert.match(openapi, /\/api\/v1\/runs\/\{id\}/);
    assert.match(openapi, /\/api\/v1\/webhooks\/github/);
    assert.match(openapi, /\/api\/v1\/webhooks\/gitlab/);
    const openapiDocument = JSON.parse(openapi) as {
      components?: { schemas?: Record<string, unknown> };
      paths?: Record<string, { get?: unknown; post?: unknown; delete?: unknown }>;
    };
    assert.ok(openapiDocument.components?.schemas?.SearchResponse);
    assert.ok(openapiDocument.components?.schemas?.RepositoryValidationReport);
    assert.ok(openapiDocument.components?.schemas?.CapabilitiesResponse);
    assert.ok(openapiDocument.components?.schemas?.WebhookReceiveResponse);
    assert.ok(openapiDocument.components?.schemas?.ProposalComment);
    assert.ok(openapiDocument.components?.schemas?.ProposeSourceResponse);
    assert.ok(openapiDocument.components?.schemas?.CreateSynthesisResponse);
    assert.ok(openapiDocument.components?.schemas?.PublishResponse);
    assert.ok(openapiDocument.components?.schemas?.CommitChangesResponse);
    assert.ok(openapiDocument.components?.schemas?.GitRemoteStatusResponse);
    assert.ok(openapiDocument.components?.schemas?.GitRemoteSyncResponse);
    assert.ok(openapiDocument.components?.schemas?.McpJsonRpcResponse);
    assert.ok(openapiDocument.paths?.["/mcp"]?.get);
    assert.ok(openapiDocument.paths?.["/mcp"]?.post);
    assert.ok(openapiDocument.paths?.["/mcp"]?.delete);
    assert.match(JSON.stringify(openapiDocument.paths?.["/mcp"]?.get), /text\/event-stream/);
    assert.match(JSON.stringify(openapiDocument.paths?.["/mcp"]?.post), /MCP-Protocol-Version/);
    assert.deepEqual(
      openapiDocument.paths?.["/api/v1/search"]?.get && JSON.stringify(openapiDocument.paths["/api/v1/search"].get).includes("SearchResponse"),
      true,
    );
    assert.deepEqual(
      openapiDocument.paths?.["/api/v1/lint"]?.post && JSON.stringify(openapiDocument.paths["/api/v1/lint"].post).includes("RepositoryValidationReport"),
      true,
    );
    assert.deepEqual(
      openapiDocument.paths?.["/api/v1/publish"]?.post &&
        JSON.stringify(openapiDocument.paths["/api/v1/publish"].post).includes("PublishResponse"),
      true,
    );
    assert.match(JSON.stringify(openapiDocument.paths?.["/api/v1/events/stream"]?.get), /text\/event-stream/);
    assert.match(JSON.stringify(openapiDocument.paths?.["/api/v1/git/status"]?.get), /GitRemoteStatusResponse/);
    assert.match(JSON.stringify(openapiDocument.paths?.["/api/v1/git/pull"]?.post), /GitRemoteSyncResponse/);
    assert.match(JSON.stringify(openapiDocument.paths?.["/api/v1/git/push"]?.post), /GitRemoteSyncResponse/);
    assert.match(manifest, /wiki.run_lint/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("static export rejects output paths that can escape or destroy workspace data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-static-safe-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "openwiki-static-outside-"));
  try {
    await createWorkspace(root, "Safe Static Wiki");
    await writeFile(path.join(outside, "sentinel.txt"), "must survive\n");
    await symlink(outside, path.join(root, "linked-out"));

    const unsafeOutDirs = [
      "",
      ".",
      "..",
      "../outside",
      path.join(outside, "absolute"),
      ".git/export",
      ".openwiki/export",
      "wiki/export",
      "sources/export",
      "linked-out/export",
    ];

    for (const outDir of unsafeOutDirs) {
      await assert.rejects(exportStaticSite({ root, outDir }), /Static export outDir/);
    }
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
          "export",
          "static",
          "--out-dir",
          "..",
          "--json",
        ],
        { cwd: process.cwd() },
      ),
      (error: unknown) =>
        error instanceof Error &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        /Static export outDir/.test(error.stderr),
    );
    assert.equal(await readFile(path.join(outside, "sentinel.txt"), "utf8"), "must survive\n");

    const exported = await exportStaticSite({ root, outDir: "public-safe" });
    assert.equal(exported.outDir, path.join(root, "public-safe"));
    assert.ok(exported.files.includes("search-index.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("HTTP publish writes static artifacts and a publish event", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-publish-"));
  try {
    await createWorkspace(root, "Publish Wiki");

    const denied = await routeHttpRequest(root, "POST", "/api/v1/publish", {
      out_dir: "published",
    });
    assert.equal(denied.status, 403);

    await assert.rejects(
      routeHttpRequest(
        root,
        "POST",
        "/api/v1/publish",
        { out_dir: ".." },
        { scopes: scopesForRole("maintainer") },
      ),
      /Static export outDir/,
    );

    const result = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/publish",
      {
        out_dir: "published",
        base_url: "https://wiki.example.com",
        actor_id: "actor:user:publisher",
      },
      { scopes: scopesForRole("maintainer"), actorId: "actor:user:publisher" },
    );
    assert.equal(result.status, 200);
    const body = result.body as {
      outDir: string;
      files: string[];
      event: { id: string; type: string; operation?: string; actor_id?: string; subject_paths?: string[]; data?: { file_count?: number } };
    };
    assert.match(body.outDir, /published$/);
    assert.ok(body.files.includes("events.jsonl"));
    assert.ok(body.files.includes("search-index.json"));
    assert.ok(body.files.includes("openapi.json"));
    assert.equal(body.event.type, "publish.completed");
    assert.equal(body.event.operation, "wiki.publish");
    assert.equal(body.event.actor_id, "actor:user:publisher");
    assert.deepEqual(body.event.subject_paths, ["openwiki.json"]);
    assert.equal(body.event.data?.file_count, body.files.length);

    const eventsJsonl = await readFile(path.join(root, "published", "events.jsonl"), "utf8");
    assert.match(eventsJsonl, /publish\.completed/);
    const eventsJson = await readFile(path.join(root, "published", "events.json"), "utf8");
    assert.match(eventsJson, /publish\.completed/);
    const searchIndex = JSON.parse(await readFile(path.join(root, "published", "search-index.json"), "utf8")) as {
      records: Array<{ type: string; search_text: string }>;
    };
    assert.ok(
      searchIndex.records.some(
        (record) => record.type === "event" && record.search_text.includes("publish.completed"),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
