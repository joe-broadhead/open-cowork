import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import {
  checkIndexStoreIntegrity,
  graphCurrentIndexStoreNeighbors,
  graphCurrentIndexStoreOrphans,
  graphCurrentIndexStorePath,
  graphCurrentIndexStoreRelated,
  graphCurrentIndexStoreStale,
  listIndexStoreEdges,
  listCurrentIndexStoreProposals,
  listIndexStoreRecords,
  readCurrentIndexStoreGraph,
  readCurrentIndexStoreWorkspaceIndex,
  readCurrentIndexStoreWorkspaceRegistry,
  readIndexStoreSummary,
  rebuildIndexStore,
} from "@openwiki/index-store";
import { routeHttpRequest } from "@openwiki/http-api";
import { createWorkspace } from "@openwiki/repo";
import { proposeEdit } from "@openwiki/workflows";

const execFileAsync = promisify(execFile);

test("SQLite index-store count queries use static table names", async () => {
  const source = await readFile("packages/index-store/src/queries.ts", "utf8");
  const types = await readFile("packages/index-store/src/types.ts", "utf8");
  assert.doesNotMatch(source, /SELECT COUNT\(\*\) AS count FROM \$\{table\}/);
  assert.match(types, /type IndexStoreCountTable/);
});

test("SQLite index-store rebuilds derived records, graph edges, permissions, and integrity metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-index-store-"));
  try {
    await createWorkspace(root, { template: "personal-wiki", title: "Index Store Wiki" });

    const rebuilt = await rebuildIndexStore(root);
    assert.equal(rebuilt.schemaVersion, "0.1.1");
    assert.equal(rebuilt.recordCount, rebuilt.searchDocumentCount);
    assert.ok(rebuilt.recordCount > 8);
    assert.ok(rebuilt.edgeCount > 0);
    assert.equal(rebuilt.effectivePermissionCount, 1);

    const summary = await readIndexStoreSummary(root);
    assert.equal(summary.recordCount, rebuilt.recordCount);
    assert.equal(summary.edgeCount, rebuilt.edgeCount);
    assert.equal(summary.sourceCommit, "uncommitted");
    assert.equal(summary.contentHash, rebuilt.contentHash);

    const pages = await listIndexStoreRecords(root, { type: "page" });
    assert.ok(pages.records.some((record) => record.record_id === "page:concept:personal-knowledge-base"));
    assert.ok(pages.records.every((record) => record.sensitivity === "public"));
    assert.ok(pages.records.some((record) => record.record_group === "concept"));
    assert.ok(pages.records.some((record) => record.record_group === "meeting"));
    assert.ok(pages.records.some((record) => record.record_group === "person"));
    assert.ok(pages.records.some((record) => record.record_group === "organization"));
    assert.ok(pages.records.some((record) => record.record_group === "topic"));
    const allowedPersonalGroups = new Set(["concept", "project", "meeting", "person", "organization", "topic"]);
    assert.ok(pages.records.every((record) => allowedPersonalGroups.has(record.record_group)));

    const edges = await listIndexStoreEdges(root, { type: "page_source" });
    assert.ok(
      edges.edges.some(
        (edge) =>
          edge.from_id === "page:concept:personal-knowledge-base" &&
          edge.to_id === "source:2026-05-21-001" &&
          edge.edge_type === "page_source",
      ),
    );

    const current = await checkIndexStoreIntegrity(root);
    assert.equal(current.ok, true);
    assert.deepEqual(current.issues, []);

    await appendFile(
      path.join(root, "wiki", "concepts", "personal-knowledge-base.md"),
      "\n\nThis local edit should make the derived index-store stale.\n",
    );
    const stale = await checkIndexStoreIntegrity(root);
    assert.equal(stale.ok, false);
    assert.ok(stale.issues.some((issue) => issue.includes("content hash mismatch")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("current SQLite index-store serves workspace, proposal, graph, and HTTP index reads when Git commit matches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-index-store-current-"));
  try {
    await createWorkspace(root, { template: "personal-wiki", title: "Current Index Store Wiki" });
    const configPath = path.join(root, "openwiki.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      runtime?: { git?: { remote?: string; branch?: string; remote_url?: string; credential_ref?: string } };
    };
    config.runtime = {
      ...(config.runtime ?? {}),
      git: {
        remote: "origin",
        branch: "master",
        remote_url: "https://user:secret@example.com/org/wiki.git",
        credential_ref: "cred:index-store-git",
      },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "OpenWiki Test"]);
    await git(root, ["config", "user.email", "openwiki@example.com"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial wiki"]);
    await rebuildIndexStore(root);

    const workspace = await readCurrentIndexStoreWorkspaceIndex(root);
    assert.equal(workspace?.source, "index-store");
    assert.equal(workspace?.counts.pages, 6);
    assert.equal(workspace?.counts.sources, 1);
    const registry = await readCurrentIndexStoreWorkspaceRegistry(root);
    assert.equal(registry?.source, "index-store");
    assert.equal(registry?.workspaces[0]?.id, "workspace:current-index-store-wiki");
    assert.equal(registry?.workspaces[0]?.config.runtime?.git?.remote_url, "https://***@example.com/org/wiki.git");
    assert.equal(registry?.repos[0]?.repo_id, "repo:default");
    assert.equal(registry?.repos[0]?.remote_url, "https://***@example.com/org/wiki.git");
    assert.equal(registry?.repos[0]?.credential_ref, "cred:index-store-git");

    const graph = await readCurrentIndexStoreGraph(root);
    assert.ok(graph?.edges.some((edge) => edge.edge_type === "page_source"));
    const neighbors = await graphCurrentIndexStoreNeighbors(root, "page:concept:personal-knowledge-base", { depth: 2 });
    assert.ok(neighbors?.nodes.some((node) => node.id === "source:2026-05-21-001"));
    assert.equal(new Set((neighbors?.edges ?? []).map((edge) => edge.id)).size, neighbors?.edges.length ?? 0);
    const related = await graphCurrentIndexStoreRelated(root, "page:concept:personal-knowledge-base");
    assert.ok(related?.edges.some((edge) => edge.edge_type === "page_source"));
    const pathResult = await graphCurrentIndexStorePath(root, "page:concept:personal-knowledge-base", "source:2026-05-21-001");
    assert.equal(pathResult?.found, true);
    const orphans = await graphCurrentIndexStoreOrphans(root);
    assert.ok(Array.isArray(orphans?.pages));
    const stale = await graphCurrentIndexStoreStale(root);
    assert.ok(Array.isArray(stale?.pages));
    assert.ok(Array.isArray(stale?.claims));

    await appendFile(
      path.join(root, "wiki", "concepts", "personal-knowledge-base.md"),
      "\n\nDirty worktree changes should bypass stale SQLite index-store reads until the index is rebuilt.\n",
    );
    assert.equal(await readCurrentIndexStoreWorkspaceIndex(root), undefined);
    await rebuildIndexStore(root);
    assert.equal((await readCurrentIndexStoreWorkspaceIndex(root))?.source, "index-store");

    const proposal = await proposeEdit({
      root,
      pageId: "page:concept:personal-knowledge-base",
      actorId: "actor:user:index-store",
      rationale: "Exercise proposal queue reads from SQLite.",
      body: "# Personal Knowledge Base\n\nSQLite-backed proposal queue reads keep local serving paths close to hosted mode.",
    });

    const proposals = await listCurrentIndexStoreProposals(root, {
      statuses: ["open"],
      actorId: "actor:user:index-store",
      targetId: "page:concept:personal-knowledge-base",
      sectionId: "section:all",
    });
    assert.equal(proposals?.source, "index-store");
    assert.equal(proposals?.total, 1);
    assert.equal(proposals?.proposals[0]?.id, proposal.proposal.id);

    const httpRelated = await routeHttpRequest(root, "GET", "/api/v1/graph/" + encodeURIComponent("page:concept:personal-knowledge-base") + "/related");
    assert.equal(httpRelated.status, 200);
    assert.ok((httpRelated.body as { edges: Array<{ edge_type: string }> }).edges.some((edge) => edge.edge_type === "page_source"));

    const httpIndex = await routeHttpRequest(root, "GET", "/api/v1/index", undefined, { role: "admin" });
    assert.equal(httpIndex.status, 200);
    assert.equal((httpIndex.body as { serving_layer?: string }).serving_layer, "index-store");
    assert.equal((httpIndex.body as { counts: { proposals: number } }).counts.proposals, 1);
    assert.doesNotMatch(JSON.stringify(httpIndex.body), /user:secret/);
    assert.match(JSON.stringify(httpIndex.body), /https:\/\/\*\*\*@example\.com\/org\/wiki\.git/);

    const httpWorkspaces = await routeHttpRequest(root, "GET", "/api/v1/workspaces", undefined, { role: "admin" });
    assert.equal(httpWorkspaces.status, 200);
    assert.doesNotMatch(JSON.stringify(httpWorkspaces.body), /user:secret/);
    assert.match(JSON.stringify(httpWorkspaces.body), /https:\/\/\*\*\*@example\.com\/org\/wiki\.git/);

    const httpRecords = await routeHttpRequest(root, "GET", "/api/v1/records?type=page&group_by=page_type&limit=1", undefined, { role: "admin" });
    assert.equal(httpRecords.status, 200);
    const recordsBody = httpRecords.body as { groups?: Array<{ id: string; count: number }>; records: Array<{ group: string }>; next_cursor?: string };
    assert.ok(recordsBody.groups?.some((group) => group.id === "concept" && group.count >= 1));
    assert.ok(["concept", "project"].includes(recordsBody.records[0]?.group ?? ""));
    assert.ok(recordsBody.next_cursor);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: root });
  return result.stdout.trim();
}
