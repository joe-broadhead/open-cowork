import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import {
  openWikiRuntimeModeFromEnvOrProfile,
  openWikiRuntimeModeFromProfile,
  openWikiRuntimeModeRequiresHostedStores,
} from "@openwiki/core";
import { appendEvent, appendRun, clearRepositoryProcessReadCache, createWorkspace, graphBacklinks, graphNeighbors, graphOrphans, graphPath, graphRelated, graphStale, listEvents, listGraphEdges, listOpenQuestions, listRuns, listTopics, loadRepository, readPage, renderPageMarkdown, traceClaim, withRepositoryReadCache } from "@openwiki/repo";
import { canReadProposalRecord } from "@openwiki/policy";
import { buildSearchIndex, searchWiki } from "@openwiki/search";
import { applyProposal, askWithCitations, proposeEdit, proposeSource, reviewProposal } from "@openwiki/workflows";

const execFileAsync = promisify(execFile);

test("explicit event and run subject paths are not inferred from payloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-explicit-subject-paths-"));
  try {
    await createWorkspace(root, "Explicit Subject Paths Wiki");
    const event = await appendEvent(root, {
      type: "subject.paths.explicit",
      actor_id: "actor:user:local",
      operation: "wiki.test",
      subject_paths: ["pages/explicit.md"],
      data: { target_path: "pages/inferred.md" },
    });
    const run = await appendRun(root, {
      run_type: "test.subject_paths",
      actor_id: "actor:user:local",
      subject_paths: ["runs/explicit.md"],
      input: { target_path: "runs/input-inferred.md" },
      output: { target_path: "runs/output-inferred.md" },
    });
    const inferred = await appendEvent(root, {
      type: "subject.paths.inferred",
      actor_id: "actor:user:local",
      operation: "wiki.test",
      data: { target_path: "pages/public.md", secret_paths: ["pages/private.md"] },
    });

    assert.deepEqual(event.subject_paths, ["pages/explicit.md"]);
    assert.deepEqual(run.subject_paths, ["runs/explicit.md"]);
    assert.deepEqual(inferred.subject_paths, ["pages/public.md", "pages/private.md"]);
    assert.deepEqual((await listEvents(root)).events.find((candidate) => candidate.id === event.id)?.subject_paths, ["pages/explicit.md"]);
    assert.deepEqual((await listRuns(root)).runs.find((candidate) => candidate.id === run.id)?.subject_paths, ["runs/explicit.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function restoreOptionalEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

test("runtime profiles resolve to deployment runtime modes", () => {
  assert.equal(openWikiRuntimeModeFromProfile(undefined), "local");
  assert.equal(openWikiRuntimeModeFromProfile("local"), "local");
  assert.equal(openWikiRuntimeModeFromProfile("static"), "local");
  assert.equal(openWikiRuntimeModeFromProfile("team"), "team");
  assert.equal(openWikiRuntimeModeFromProfile("compose"), "team");
  assert.equal(openWikiRuntimeModeFromProfile("umbrel"), "team");
  assert.equal(openWikiRuntimeModeFromProfile("hosted"), "hosted");
  assert.equal(openWikiRuntimeModeFromProfile("cloud"), "hosted");
  assert.equal(openWikiRuntimeModeFromProfile("enterprise"), "enterprise");
  assert.throws(() => openWikiRuntimeModeFromProfile("hosted-postgres"), /Invalid OpenWiki runtime profile/);
  assert.equal(openWikiRuntimeModeFromEnvOrProfile({ OPENWIKI_RUNTIME_MODE: "hosted" }, "local"), "hosted");
  assert.equal(openWikiRuntimeModeFromEnvOrProfile({ OPENWIKI_RUNTIME_MODE: " enterprise " }, "local"), "enterprise");
  assert.throws(
    () => openWikiRuntimeModeFromEnvOrProfile({ OPENWIKI_RUNTIME_MODE: "demo" }, "local"),
    /OPENWIKI_RUNTIME_MODE/,
  );
  assert.equal(openWikiRuntimeModeRequiresHostedStores("local"), false);
  assert.equal(openWikiRuntimeModeRequiresHostedStores("team"), false);
  assert.equal(openWikiRuntimeModeRequiresHostedStores("hosted"), true);
  assert.equal(openWikiRuntimeModeRequiresHostedStores("enterprise"), true);
});

test("repository read cache reuses one parsed snapshot inside a request context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-read-cache-"));
  try {
    await createWorkspace(root, "Read Cache Wiki");
    const cached = await withRepositoryReadCache(async () => {
      const first = await loadRepository(root);
      const second = await loadRepository(root);
      assert.strictEqual(second, first);
      return first;
    });
    const uncached = await loadRepository(root);
    assert.notStrictEqual(uncached, cached);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("hosted repository process cache reuses snapshots across request contexts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-hosted-read-cache-"));
  const previousMode = process.env.OPENWIKI_RUNTIME_MODE;
  const previousTtl = process.env.OPENWIKI_REPOSITORY_CACHE_TTL_MS;
  try {
    await createWorkspace(root, "Hosted Read Cache Wiki");
    process.env.OPENWIKI_RUNTIME_MODE = "hosted";
    process.env.OPENWIKI_REPOSITORY_CACHE_TTL_MS = "1000";
    const first = await loadRepository(root);
    const second = await loadRepository(root);
    assert.strictEqual(second, first);
    const event = await appendEvent(root, {
      type: "hosted.cache.changed",
      actor_id: "actor:user:local",
      operation: "wiki.test",
    });
    const changed = await loadRepository(root);
    assert.notStrictEqual(changed, first);
    assert.equal(changed.events.find((candidate) => candidate.id === event.id)?.id, event.id);
    clearRepositoryProcessReadCache(root);
    const reloaded = await loadRepository(root);
    assert.notStrictEqual(reloaded, changed);
  } finally {
    clearRepositoryProcessReadCache(root);
    restoreOptionalEnv("OPENWIKI_RUNTIME_MODE", previousMode);
    restoreOptionalEnv("OPENWIKI_REPOSITORY_CACHE_TTL_MS", previousTtl);
    await rm(root, { recursive: true, force: true });
  }
});

test("initializes, indexes, searches, and reads a local OpenWiki", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-"));
  try {
    const config = await createWorkspace(root, "Test Wiki");
    assert.equal(config.protocol_version, "0.1");
    assert.equal(config.runtime?.profile, "local");
    assert.equal(config.search?.default_persona, "default");

    const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
    assert.match(gitignore, /\.openwiki\/index\//);
    assert.match(gitignore, /\.openwiki\/objects\//);
    assert.match(gitignore, /\.openwiki\/locks\//);

    const repo = await loadRepository(root);
    assert.equal(repo.pages.length, 1);
    assert.equal(repo.sources.length, 1);
    assert.equal(repo.claims.length, 1);

    const index = await buildSearchIndex(root);
    assert.equal(index.recordCount, 3);
    const db = new DatabaseSync(index.dbPath);
    try {
      const recordColumns = db.prepare("PRAGMA table_info(records)").all() as Array<{ name: string }>;
      assert.ok(recordColumns.some((column) => column.name === "status"));
      const topicIndex = db.prepare("PRAGMA index_list(record_topics)").all() as Array<{ name: string }>;
      assert.ok(topicIndex.some((entry) => entry.name === "record_topics_topic_idx"));
      const topicRows = db.prepare("SELECT topic FROM record_topics WHERE record_id = ?").all("page:concept:agent-memory") as Array<{ topic: string }>;
      assert.ok(topicRows.some((row) => row.topic === "agents"));
    } finally {
      db.close();
    }

    const response = await searchWiki(root, {
      query: "agent memory",
      include_explain: true,
      limit: 5,
    });
    assert.equal(response.count >= 1, true);
    assert.equal(response.results[0]?.id, "page:concept:agent-memory");
    assert.ok(response.results[0]?.explain);
    assert.ok(response.explain?.retrievers_used.includes("bm25"));
    assert.equal(response.explain?.rrf.k, 60);
    assert.equal(response.explain?.retriever_stats.bm25?.enabled, true);
    assert.equal(response.explain?.diagnostics?.capabilities?.backend, "sqlite");
    assert.deepEqual(response.explain?.diagnostics?.capabilities?.unsupported_retrievers, []);
    assert.equal(response.explain?.diagnostics?.capabilities?.fuzzy, true);
    assert.equal(response.explain?.diagnostics?.capabilities?.max_offset, 10000);
    const resultExplain = response.results[0]?.explain as
      | { ranking_signals?: { citation_density?: number; source_reliability?: number } }
      | undefined;
    assert.ok((resultExplain?.ranking_signals?.citation_density ?? 0) > 1);
    assert.equal(resultExplain?.ranking_signals?.source_reliability, 1);

    const highlighted = await searchWiki(root, {
      query: "agent memory",
      include_highlights: true,
      limit: 1,
    });
    assert.match(highlighted.results[0]?.highlights?.title?.[0] ?? "", /Agent Memory/);
    assert.match(highlighted.results[0]?.highlights?.body?.[0] ?? "", /Agent memory/);
    assert.equal(highlighted.next_cursor, "offset:1");

    const offsetResponse = await searchWiki(root, {
      query: "agent memory",
      limit: 1,
      offset: 1,
    });
    assert.equal(offsetResponse.count, 1);
    assert.notEqual(offsetResponse.results[0]?.id, response.results[0]?.id);

    const fuzzyResponse = await searchWiki(root, {
      query: "agnt memry",
      types: ["page"],
      fuzzy: true,
      include_explain: true,
      limit: 5,
      filters: { topics: ["agents"], status: ["draft"] },
    });
    assert.equal(fuzzyResponse.results[0]?.id, "page:concept:agent-memory");
    const fuzzyExplain = fuzzyResponse.results[0]?.explain as
      | { retrieval?: { retrievers?: Record<string, unknown> } }
      | undefined;
    assert.ok(fuzzyExplain?.retrieval?.retrievers?.fuzzy);
    assert.ok(fuzzyResponse.explain?.retrievers_used.includes("fuzzy"));

    const filteredOut = await searchWiki(root, {
      query: "agent memory",
      types: ["page"],
      limit: 5,
      filters: { status: ["published"] },
    });
    assert.equal(filteredOut.count, 0);

    const page = await readPage(root, "page:concept:agent-memory");
    assert.equal(page.title, "Agent Memory");

    const topics = await listTopics(root);
    assert.equal(topics.topics[0]?.topic, "agents");
    assert.equal(topics.topics[0]?.page_count, 1);

    const questions = await listOpenQuestions(root);
    assert.equal(questions.open_questions[0]?.question, "How should OpenWiki rank disputed claims?");
    assert.equal(questions.open_questions[0]?.page_id, "page:concept:agent-memory");

    const claimTrace = await traceClaim(root, "claim:2026-05-21-001");
    assert.equal(claimTrace.claim.id, "claim:2026-05-21-001");
    assert.equal(claimTrace.page?.id, "page:concept:agent-memory");
    assert.equal(claimTrace.sources[0]?.id, "source:2026-05-21-001");
    assert.equal(claimTrace.evidence_summary.source_count, 1);
    await appendEvent(root, {
      type: "agent.memory.operational.noise",
      actor_id: "actor:user:local",
      operation: "wiki.test",
      record_id: "artifact:agent-memory-noise",
      record_type: "artifact",
      data: {
        title: "Agent memory operational event should not dominate ask citations",
        summary: "agent memory agent memory agent memory",
      },
    });

    const answer = await askWithCitations({
      root,
      question: "How does OpenWiki store agent memory?",
      limit: 3,
    });
    assert.match(answer.answer, /OpenWiki found/);
    assert.ok(answer.evidence.some((evidence) => evidence.id === "page:concept:agent-memory"));
    assert.equal(answer.evidence.some((evidence) => evidence.type === "event"), false);
    assert.equal(answer.search.results.some((result) => result.type === "event"), false);
    assert.equal(answer.citations[0]?.id, "source:2026-05-21-001");

    await Promise.all([
      buildSearchIndex(root),
      askWithCitations({ root, question: "agent memory", limit: 2 }),
      buildSearchIndex(root),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("YAML writers quote values that would otherwise be typed scalars", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-yaml-scalars-"));
  try {
    await createWorkspace(root, "YAML Scalars Wiki");
    const repo = await loadRepository(root);
    const page = repo.pages[0];
    assert.ok(page);
    await writeFile(
      path.join(root, page.path),
      renderPageMarkdown({
        ...page,
        title: "true",
        summary: "123",
        topics: ["false", "null"],
      }),
    );
    const sourceProposal = await proposeSource({
      root,
      title: "false",
      sourceType: "manual",
      actorId: "actor:user:local",
    });
    assert.match(await readFile(path.join(root, sourceProposal.proposal.snapshot_path ?? ""), "utf8"), /title: "false"/);

    const reparsed = await loadRepository(root);
    const reparsedPage = reparsed.pages.find((candidate) => candidate.id === page.id);
    assert.equal(reparsedPage?.title, "true");
    assert.equal(reparsedPage?.summary, "123");
    assert.deepEqual(reparsedPage?.topics, ["false", "null"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proposal apply refuses a stale base commit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-proposal-stale-base-"));
  try {
    await createWorkspace(root, "Stale Base Wiki");
    await execFileAsync("git", ["-C", root, "init", "--initial-branch", "master"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "OpenWiki Test"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "openwiki@example.com"]);
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "Initial wiki"]);

    const proposed = await proposeEdit({
      root,
      pageId: "page:concept:agent-memory",
      body: "# Agent Memory\n\nA proposed edit based on the initial commit.",
      actorId: "actor:user:editor",
    });
    await reviewProposal({
      root,
      proposalId: proposed.proposal.id,
      decision: "accepted",
      actorId: "actor:user:reviewer",
      rationale: "Accepted for stale-base test.",
    });

    await writeFile(
      path.join(root, "wiki", "concepts", "agent-memory.md"),
      "# Agent Memory\n\nA conflicting committed edit landed first.\n",
    );
    await execFileAsync("git", ["-C", root, "add", "wiki/concepts/agent-memory.md"]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "Conflicting edit"]);

    await assert.rejects(
      applyProposal({
        root,
        proposalId: proposed.proposal.id,
        actorId: "actor:user:maintainer",
      }),
      /stale snapshot/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proposal apply allows committed proposal metadata when target content is unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-proposal-metadata-commit-"));
  try {
    await createWorkspace(root, "Proposal Metadata Commit Wiki");
    await execFileAsync("git", ["-C", root, "init", "--initial-branch", "master"]);
    await execFileAsync("git", ["-C", root, "config", "user.name", "OpenWiki Test"]);
    await execFileAsync("git", ["-C", root, "config", "user.email", "openwiki@example.com"]);
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "Initial wiki"]);

    const proposed = await proposeEdit({
      root,
      pageId: "page:concept:agent-memory",
      body: "# Agent Memory\n\nA governed proposal can be applied after metadata commits.",
      actorId: "actor:user:editor",
    });
    await reviewProposal({
      root,
      proposalId: proposed.proposal.id,
      decision: "accepted",
      actorId: "actor:user:reviewer",
      rationale: "Accepted for metadata commit test.",
    });
    await execFileAsync("git", ["-C", root, "add", "."]);
    await execFileAsync("git", ["-C", root, "commit", "-m", "Record proposal review metadata"]);

    const applied = await applyProposal({
      root,
      proposalId: proposed.proposal.id,
      actorId: "actor:user:maintainer",
    });
    assert.equal(applied.proposal.status, "applied");
    assert.match(
      await readFile(path.join(root, "wiki", "concepts", "agent-memory.md"), "utf8"),
      /governed proposal can be applied after metadata commits/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proposal visibility requires access to every explicit target id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-proposal-visibility-"));
  try {
    await createWorkspace(root, "Proposal Visibility Wiki");
    const repo = await loadRepository(root);
    const basePage = repo.pages[0]!;
    const publicPage = {
      ...basePage,
      id: "page:concept:public-note",
      uri: "openwiki://page/concept/public-note",
      title: "Public Note",
      path: "wiki/public-note.md",
    };
    const privatePage = {
      ...basePage,
      id: "page:concept:private-note",
      uri: "openwiki://page/concept/private-note",
      title: "Private Note",
      path: "wiki/private/private-note.md",
    };
    const mixedProposal = {
      id: "proposal:2026-05-28-001",
      uri: "openwiki://proposal/2026-05-28-001",
      type: "proposal" as const,
      title: "Mixed Visibility Proposal",
      status: "open" as const,
      actor_id: "actor:user:editor",
      target_ids: [publicPage.id, privatePage.id],
      diff: {
        format: "unified" as const,
        path: "proposals/diffs/proposal.diff",
      },
      created_at: "2026-05-28T00:00:00.000Z",
      path: "proposals/proposal.yaml",
    };
    const visibilityRepo = {
      ...repo,
      policy: {
        sections: [
          { id: "section:public", title: "Public", paths: ["wiki/**"], visibility: "public" as const },
          { id: "section:private", title: "Private", paths: ["wiki/private/**"], visibility: "private" as const },
        ],
        grants: [{ principal: "group:all-users", section: "section:public", role: "viewer" as const }],
        approval_rules: [],
      },
      pages: [publicPage, privatePage],
      proposals: [mixedProposal],
    };

    assert.equal(canReadProposalRecord(visibilityRepo, { scopes: ["wiki:read"] }, mixedProposal), false);
    assert.equal(
      canReadProposalRecord(
        visibilityRepo,
        { scopes: ["wiki:read"], principals: ["actor:user:private-viewer"] },
        {
          ...mixedProposal,
          target_ids: [publicPage.id],
        },
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("derives an OpenWiki knowledge graph from pages, evidence, topics, policy, and governance records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-graph-"));
  try {
    await createWorkspace(root, "Graph Wiki");
    const now = "2026-05-26T10:00:00.000Z";
    await writeFile(
      path.join(root, "policy", "sections.json"),
      JSON.stringify(
        [
          {
            id: "section:all",
            title: "All Workspace Content",
            paths: ["**"],
            visibility: "public",
          },
          {
            id: "section:wiki-markdown",
            title: "Wiki Markdown",
            paths: ["wiki/**/*.md"],
            visibility: "public",
          },
        ],
        null,
        2,
      ),
    );
    await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
    await writeFile(
      path.join(root, "wiki", "concepts", "retrieval.md"),
      [
        "---",
        "id: page:concept:retrieval",
        "type: concept",
        "title: Retrieval",
        "summary: Retrieval notes linked to agent memory.",
        "status: draft",
        "topics:",
        "  - agents",
        "source_ids:",
        "  - source:2026-05-21-001",
        "claim_ids: []",
        "created_at: " + now,
        "updated_at: " + now,
        "---",
        "",
        "# Retrieval",
        "",
        "Retrieval links to [[Agent Memory]] and [the same page](agent-memory.md).",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "wiki", "concepts", "ranking.md"),
      [
        "---",
        "id: page:concept:ranking",
        "title: Ranking",
        "page_type: concept",
        "summary: Ranking shares the agents topic without a direct page link.",
        "sensitivity: internal",
        "topics:",
        "  - agents",
        "source_ids:",
        "  - source:2026-05-21-001",
        "claim_ids: []",
        "---",
        "",
        "# Ranking",
        "",
        "Ranking is related to agent memory through their shared agents topic.",
        "",
      ].join("\n"),
    );

    const graph = await listGraphEdges(root);
    assert.ok(graph.nodes.some((node) => node.id === "page:concept:agent-memory"));
    assert.ok(graph.nodes.some((node) => node.id === "topic:agents"));
    assert.ok(graph.nodes.some((node) => node.id === "section:all"));
    assert.ok(graph.nodes.some((node) => node.id === "section:wiki-markdown"));
    assert.ok(graph.edges.some((edge) => edge.edge_type === "page_link" && edge.from_id === "page:concept:retrieval" && edge.to_id === "page:concept:agent-memory"));
    assert.ok(graph.edges.some((edge) => edge.edge_type === "page_source" && edge.to_id === "source:2026-05-21-001"));
    assert.ok(graph.edges.some((edge) => edge.edge_type === "page_claim" && edge.to_id === "claim:2026-05-21-001"));
    assert.ok(graph.edges.some((edge) => edge.edge_type === "claim_source" && edge.from_id === "claim:2026-05-21-001"));
    assert.ok(graph.edges.some((edge) => edge.edge_type === "page_topic" && edge.to_id === "topic:agents"));
    assert.ok(graph.edges.some((edge) => edge.edge_type === "page_section" && edge.to_id === "section:all"));
    assert.ok(graph.edges.some((edge) => edge.edge_type === "page_section" && edge.to_id === "section:wiki-markdown"));

    const backlinks = await graphBacklinks(root, "page:concept:agent-memory");
    assert.ok(backlinks.edges.some((edge) => edge.from_id === "page:concept:retrieval"));

    const neighbors = await graphNeighbors(root, "page:concept:agent-memory", { depth: 2 });
    assert.equal(new Set(neighbors.edges.map((edge) => edge.id)).size, neighbors.edges.length);

    const related = await graphRelated(root, "page:concept:agent-memory");
    assert.ok(related.nodes.some((node) => node.id === "topic:agents"));
    assert.ok(related.nodes.some((node) => node.id === "source:2026-05-21-001"));
    assert.ok(related.nodes.some((node) => node.id === "page:concept:ranking"));

    const pathResult = await graphPath(root, "page:concept:retrieval", "source:2026-05-21-001");
    assert.equal(pathResult.found, true);
    assert.equal(pathResult.nodes[0]?.id, "page:concept:retrieval");
    assert.equal(pathResult.nodes.at(-1)?.id, "source:2026-05-21-001");
    const reverseBacklinkPath = await graphPath(root, "page:concept:agent-memory", "page:concept:retrieval");
    assert.equal(reverseBacklinkPath.found, true);
    assert.deepEqual(reverseBacklinkPath.nodes.map((node) => node.id), ["page:concept:agent-memory", "page:concept:retrieval"]);
    const sharedTopicPath = await graphPath(root, "page:concept:agent-memory", "page:concept:ranking");
    assert.equal(sharedTopicPath.found, true);
    assert.equal(sharedTopicPath.nodes[0]?.id, "page:concept:agent-memory");
    assert.equal(sharedTopicPath.nodes.at(-1)?.id, "page:concept:ranking");
    assert.ok(
      sharedTopicPath.nodes.some((node) => node.id === "topic:agents" || node.id === "section:all") ||
        sharedTopicPath.edges.some((edge) => edge.edge_type === "page_typed_link" && edge.metadata?.link_kind === "derived"),
    );
    const missingPath = await graphPath(root, "page:concept:agent-memory", "page:missing");
    assert.deepEqual(missingPath, {
      from_id: "page:concept:agent-memory",
      to_id: "page:missing",
      found: false,
      nodes: [],
      edges: [],
    });

    const orphans = await graphOrphans(root);
    assert.equal(orphans.pages.some((page) => page.id === "page:concept:retrieval"), false);

    const stale = await graphStale(root);
    assert.equal(stale.total, 0);

    const page = await readPage(root, "page:concept:agent-memory");
    page.claim_ids = [...page.claim_ids, "claim:detached-stale"];
    await writeFile(path.join(root, page.path), renderPageMarkdown(page));
    const claimIndexPath = path.join(root, "claims", "claim-index.jsonl");
    await writeFile(
      claimIndexPath,
      `${await readFile(claimIndexPath, "utf8")}${JSON.stringify({
        id: "claim:detached-stale",
        uri: "openwiki://claim/detached-stale",
        type: "claim",
        text: "A stale claim linked only from page.claim_ids should still mark the page stale.",
        page_id: "page:concept:other-page",
        source_ids: [],
        status: "stale",
        confidence: "low",
        path: "claims/detached-stale.json",
        created_at: "2026-05-31T00:00:00.000Z",
        updated_at: "2026-05-31T00:00:00.000Z",
      })}\n`,
    );
    const staleByClaimId = await graphStale(root);
    assert.ok(staleByClaimId.pages.some((candidate) => candidate.id === "page:concept:agent-memory" && candidate.reasons.includes("stale_claim")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("initializes named OpenWiki workspace templates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-templates-"));
  try {
    const cases = [
      {
        template: "team-wiki",
        pageId: "page:organization:team-knowledge-base",
        pageCount: 2,
        profile: "local",
      },
      {
        template: "personal-wiki",
        pageId: "page:concept:personal-knowledge-base",
        pageCount: 6,
        profile: "local",
      },
      {
        template: "company-wiki",
        pageId: "page:organization:team-knowledge-base",
        pageCount: 2,
        profile: "local",
      },
      {
        template: "public-encyclopedia",
        pageId: "page:reference:citation-guidelines",
        pageCount: 2,
        profile: "local",
      },
      {
        template: "github-pages",
        pageId: "page:guide:publishing-with-github-pages",
        pageCount: 1,
        profile: "static",
      },
    ] as const;

    for (const item of cases) {
      const target = path.join(root, item.template);
      const config = await createWorkspace(target, {
        title: `Template ${item.template}`,
        template: item.template,
      });
      assert.equal(config.runtime?.profile, item.profile);
      const repo = await loadRepository(target);
      assert.equal(repo.pages.length, item.pageCount);
      assert.equal(repo.sources.length, 1);
      assert.equal(repo.claims.length, item.pageCount);
      assert.ok(repo.pages.some((page) => page.id === item.pageId));
      assert.equal(repo.pages.every((page) => page.source_ids.length === 1), true);
      assert.equal(repo.claims.every((claim) => claim.source_ids.length === 1), true);
      if (item.template === "team-wiki" || item.template === "company-wiki") {
        assert.ok(repo.policy.sections.some((section) => section.id === "section:team-knowledge" && section.visibility === "internal"));
        assert.ok(repo.policy.sections.some((section) => section.id === "section:governance" && section.visibility === "private"));
        assert.ok(repo.policy.grants.some((grant) => grant.principal === "group:knowledge-reviewers" && grant.role === "reviewer"));
        assert.ok(repo.policy.approval_rules.some((rule) => rule.id === "approval:team-default" && rule.require_separate_actor === true));
      }
    }

    for (const template of ["team-wiki", "basic", "personal-wiki", "company-wiki", "public-encyclopedia", "github-pages"]) {
      const templateReadme = await readFile(path.join(process.cwd(), "templates", template, "README.md"), "utf8");
      assert.match(templateReadme, /Template/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI init supports workspace templates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-cli-template-"));
  try {
    const target = path.join(root, "company");
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "init",
        target,
        "--title",
        "CLI Template Wiki",
        "--template",
        "company-wiki",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const result = JSON.parse(stdout) as { template: string; config: { workspace_id: string } };
    assert.equal(result.template, "company-wiki");
    assert.equal(result.config.workspace_id, "workspace:cli-template-wiki");

    const repo = await loadRepository(target);
    assert.ok(repo.pages.some((page) => page.id === "page:organization:team-knowledge-base"));

    const defaultTarget = path.join(root, "default");
    const { stdout: defaultStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "init",
        defaultTarget,
        "--title",
        "CLI Default Wiki",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const defaultResult = JSON.parse(defaultStdout) as { template: string };
    assert.equal(defaultResult.template, "team-wiki");
    const defaultRepo = await loadRepository(defaultTarget);
    assert.ok(defaultRepo.policy.sections.some((section) => section.id === "section:team-knowledge" && section.visibility === "internal"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("search honors workspace search configuration overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-search-config-"));
  try {
    await createWorkspace(root, "Search Config Wiki");
    const configPath = path.join(root, "openwiki.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.search = {
      default_persona: "governance",
      default_limit: 5,
      max_limit: 20,
      max_query_length: 2000,
      overfetch: 4,
      rrf_k: 10,
      ngram_min: 3,
      fuzzy_min_length: 4,
      fuzzy_mid_length: 7,
      fuzzy_max_distance: 2,
      enabled_retrievers: {
        exact: true,
        bm25: true,
        ngram: false,
        fuzzy: true,
        graph: true,
      },
      persona_weights: {
        governance: {
          fuzzy: 2,
          graph: 1.3,
        },
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const response = await searchWiki(root, {
      query: "agnt memry",
      types: ["page"],
      fuzzy: true,
      include_explain: true,
      filters: { topics: ["agents"], status: ["draft"] },
    });
    assert.equal(response.persona, "governance");
    assert.equal(response.results[0]?.id, "page:concept:agent-memory");
    const explain = response.results[0]?.explain as
      | { retrieval?: { retrievers?: Record<string, unknown> }; settings?: { enabled_retrievers?: string[]; rrf_k?: number } }
      | undefined;
    assert.ok(explain?.retrieval?.retrievers?.fuzzy);
    assert.equal(explain?.retrieval?.retrievers?.ngram, undefined);
    assert.deepEqual(explain?.settings?.enabled_retrievers?.includes("ngram"), false);
    assert.equal(explain?.settings?.rrf_k, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
