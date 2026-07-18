import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { analyzeGraph, idToUri, type GraphEdgeRecord, type GraphIndexResponse } from "@openwiki/core";
import { createWorkspace } from "@openwiki/repo";

const execFileAsync = promisify(execFile);

test("analyzeGraph returns deterministic hubs, gaps, components, stale hubs, and questions", () => {
  const graph: GraphIndexResponse = {
    nodes: [
      node("page:concept:agent-memory", "page", "Agent Memory"),
      node("page:concept:retrieval", "page", "Retrieval"),
      node("page:concept:ranking", "page", "Ranking"),
      node("page:concept:orphan-note", "page", "Orphan Note"),
      node("source:manual:agent-memory", "source", "Agent Memory Source"),
      node("claim:agent-memory-stale", "claim", "Agent memory claim", "stale"),
      node("topic:agents", "topic", "agents"),
    ],
    edges: [
      edge("page_link", "page:concept:agent-memory", "page:concept:retrieval"),
      edge("page_topic", "page:concept:agent-memory", "topic:agents"),
      edge("page_topic", "page:concept:retrieval", "topic:agents"),
      edge("page_topic", "page:concept:ranking", "topic:agents"),
      edge("page_source", "page:concept:agent-memory", "source:manual:agent-memory"),
      edge("page_source", "page:concept:retrieval", "source:manual:agent-memory"),
      edge("page_claim", "page:concept:agent-memory", "claim:agent-memory-stale"),
    ],
  };

  const report = analyzeGraph(graph, { limit: 5 });

  assert.equal(report.schema_version, "openwiki-graph-analysis-v1");
  assert.equal(report.node_count, 7);
  assert.equal(report.edge_count, 7);
  assert.ok(report.node_metrics.some((metric) => metric.id === "page:concept:agent-memory" && metric.degree === 4));
  assert.equal(report.hub_nodes[0]?.id, "page:concept:agent-memory");
  assert.ok(report.components.some((component) => component.node_count === 6));
  assert.ok(report.orphan_components.some((component) => component.page_ids.includes("page:concept:orphan-note")));
  assert.ok(report.candidate_missing_links.some((candidate) => candidate.from_id === "page:concept:agent-memory" && candidate.to_id === "page:concept:ranking" && candidate.reason_codes.includes("shared_topic")));
  assert.ok(report.stale_hubs.some((hub) => hub.id === "page:concept:agent-memory" && hub.stale_claim_ids.includes("claim:agent-memory-stale")));
  assert.ok(report.source_coverage_gaps.some((gap) => gap.topic_id === "topic:agents" && gap.page_count === 3 && gap.source_count === 1));
  assert.ok(report.suggested_questions.some((question) => /central to this wiki/u.test(question.question)));

  const invalidLimitReport = analyzeGraph(graph, { limit: Number.NaN, maxPeersPerSharedNode: Number.NaN });
  assert.ok(invalidLimitReport.hub_nodes.length > 0);
  assert.ok(invalidLimitReport.node_metrics.length > 0);
});

test("openwiki graph report prints human output and stable JSON", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-graph-report-cli-"));
  try {
    await createWorkspace(root, "Graph Report CLI Wiki");
    const cli = path.join(process.cwd(), "packages", "cli", "src", "main.ts");
    const json = await execFileAsync(process.execPath, ["--no-warnings", "--import", "tsx", cli, "--root", root, "graph", "report", "--json", "--limit", "3"]);
    const report = JSON.parse(json.stdout) as { schema_version: string; hub_nodes: unknown[]; suggested_questions: unknown[] };
    assert.equal(report.schema_version, "openwiki-graph-analysis-v1");
    assert.ok(report.hub_nodes.length > 0);
    assert.ok(report.suggested_questions.length > 0);

    const human = await execFileAsync(process.execPath, ["--no-warnings", "--import", "tsx", cli, "--root", root, "graph", "report", "--limit", "3"]);
    assert.match(human.stdout, /Graph report:/);
    assert.match(human.stdout, /Hub nodes/);
    assert.match(human.stdout, /Suggested questions/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function node(id: string, recordType: string, title: string, status?: string) {
  return {
    id,
    uri: idToUri(id),
    record_type: recordType,
    title,
    ...(status === undefined ? {} : { status }),
  };
}

function edge(edgeType: GraphEdgeRecord["edge_type"], fromId: string, toId: string): GraphEdgeRecord {
  const id = `edge:${edgeType}:${fromId}:${toId}`;
  return {
    id,
    uri: idToUri(id),
    type: "edge",
    workspace_id: "workspace:test",
    from_id: fromId,
    to_id: toId,
    edge_type: edgeType,
    weight: 1,
    created_at: "2026-06-02T00:00:00.000Z",
  };
}
