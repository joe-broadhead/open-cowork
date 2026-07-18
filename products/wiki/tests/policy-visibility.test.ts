import assert from "node:assert/strict";
import test from "node:test";
import type { EventRecord, OpenWikiPolicyBundle, PageRecord, RunRecord, SearchResponse, SourceRecord } from "@openwiki/core";
import { authorizeOperation, canReadEventRecord, canReadRecordId, canReadRunRecord, filterSearchResponseByVisibility, mergePolicyBounds, pathAllowedByContextBounds, type PolicyContext } from "@openwiki/policy";

test("visibility-filtered search recomputes facets from visible results", () => {
  const repo = {
    policy: testPolicy(),
    pages: [
      pageRecord("page:public", "Public", "wiki/public.md", ["public"]),
      pageRecord("page:private", "Private", "private/secret.md", ["secret"]),
    ],
    sources: [],
    claims: [],
    facts: [],
    takes: [],
    inbox: [],
    proposals: [],
    comments: [],
    decisions: [],
    events: [],
    runs: [],
  };
  const response: SearchResponse = {
    results: [
      searchResult("page:public", "Public", "wiki/public.md"),
      searchResult("page:private", "Private", "private/secret.md"),
    ],
    count: 2,
    total: 2,
    total_relation: "exact",
    truncated: false,
    persona: "default",
    facets: {
      types: { page: 2 },
      status: { published: 1, private: 1 },
      topics: { public: 1, secret: 1 },
    },
    facets_relation: "exact",
  };

  const filtered = filterSearchResponseByVisibility(repo, { scopes: [], actorId: "actor:user:reader" }, response);

  assert.deepEqual(filtered.results.map((result) => result.id), ["page:public"]);
  assert.deepEqual(filtered.facets, { types: { page: 1 }, status: { published: 1 }, topics: { public: 1 } });
  assert.equal(filtered.facets_relation, "capped");
});

test("source-scoped contexts cannot discover out-of-scope records through search facets or explain", () => {
  const repo = {
    policy: testPolicy(),
    pages: [
      pageRecord("page:allowed", "Allowed", "wiki/allowed.md", ["allowed"], ["source:allowed"]),
      pageRecord("page:secret", "Secret", "wiki/secret.md", ["secret"], ["source:secret"]),
    ],
    sources: [
      sourceRecord("source:allowed", "Allowed Source", "sources/manifests/allowed.json"),
      sourceRecord("source:secret", "Secret Source", "sources/manifests/secret.json"),
    ],
    claims: [],
    facts: [],
    takes: [],
    inbox: [],
    proposals: [],
    comments: [],
    decisions: [],
    events: [],
    runs: [],
  };
  const response: SearchResponse = {
    results: [
      searchResult("page:allowed", "Allowed", "wiki/allowed.md", ["source:allowed"]),
      searchResult("page:secret", "Secret", "wiki/secret.md", ["source:secret"]),
      searchResult("source:secret", "Secret Source", "sources/manifests/secret.json", ["source:secret"], "source"),
    ],
    count: 3,
    total: 3,
    total_relation: "exact",
    truncated: false,
    persona: "default",
    facets: {
      types: { page: 2, source: 1 },
      status: { published: 2, active: 1 },
      topics: { allowed: 1, secret: 1 },
    },
    facets_relation: "exact",
    explain: {
      query_tokens: ["welcome"],
      mode: "lexical",
      fuzzy: false,
      rrf: { enabled: false, k: 60, overfetch: 1, fetch_limit: 3 },
      retrievers_used: ["exact"],
      retriever_stats: {},
      ranking_signals: [],
      reranker: { enabled: false, applied: false, top_n: 0 },
      diagnostics: {
        backend: "sqlite",
        candidate_strategy: "test_fixture",
        candidate_ids: 3,
        record_json_reads: 3,
        scanned_rows: 3,
      },
    },
  };
  const context: PolicyContext = {
    scopes: ["wiki:read", "wiki:search"],
    actorId: "actor:agent:bounded",
    bounds: {
      sourceIds: ["source:allowed"],
      pathPrefixes: ["wiki/allowed.md"],
      operations: ["wiki.search"],
    },
  };

  const filtered = filterSearchResponseByVisibility(repo, context, response);

  assert.deepEqual(filtered.results.map((result) => result.id), ["page:allowed"]);
  assert.deepEqual(filtered.facets, { types: { page: 1 }, status: { published: 1 }, topics: { allowed: 1 } });
  assert.equal(filtered.explain, undefined);
  assert.equal(canReadRecordId(repo, context, "source:secret"), false);
  assert.equal(canReadRecordId(repo, context, "page:secret"), false);
});

test("policy bound intersections stay restrictive when credential layers are disjoint", () => {
  const policy = testPolicy();
  const disjointOperations = mergePolicyBounds(
    { operations: ["wiki.search"] },
    { operations: ["wiki.list_recent_changes"] },
  );
  assert.deepEqual(disjointOperations, { operations: [] });
  assert.deepEqual(mergePolicyBounds(disjointOperations, { operations: ["wiki.search"] }), { operations: [] });
  assert.equal(authorizeOperation("wiki.search", { scopes: ["wiki:search"], bounds: disjointOperations }).allowed, false);

  const narrowedPath = mergePolicyBounds(
    { pathPrefixes: ["wiki"] },
    { pathPrefixes: ["wiki/allowed"] },
  );
  assert.deepEqual(narrowedPath, { pathPrefixes: ["wiki/allowed"] });
  assert.equal(pathAllowedByContextBounds(policy, { scopes: ["wiki:read"], bounds: narrowedPath }, "wiki/allowed/page.md"), true);
  assert.equal(pathAllowedByContextBounds(policy, { scopes: ["wiki:read"], bounds: narrowedPath }, "wiki/other/page.md"), false);

  const disjointPaths = mergePolicyBounds(
    { pathPrefixes: ["wiki/allowed"] },
    { pathPrefixes: ["private"] },
  );
  assert.deepEqual(disjointPaths, { pathPrefixes: [] });
  assert.deepEqual(mergePolicyBounds(disjointPaths, { pathPrefixes: ["wiki/allowed"] }), { pathPrefixes: [] });
  assert.equal(pathAllowedByContextBounds(policy, { scopes: ["wiki:read"], bounds: disjointPaths }, "wiki/allowed/page.md"), false);
});

test("disjoint source bound intersections hide source-backed records", () => {
  const repo = {
    policy: testPolicy(),
    pages: [pageRecord("page:allowed", "Allowed", "wiki/allowed.md", ["allowed"], ["source:allowed"])],
    sources: [sourceRecord("source:allowed", "Allowed Source", "sources/manifests/allowed.json")],
    claims: [],
    facts: [],
    takes: [],
    inbox: [],
    proposals: [],
    comments: [],
    decisions: [],
    events: [],
    runs: [],
  };
  const bounds = mergePolicyBounds({ sourceIds: ["source:allowed"] }, { sourceIds: ["source:other"] });

  assert.deepEqual(bounds, { sourceIds: [] });
  assert.deepEqual(mergePolicyBounds(bounds, { sourceIds: ["source:allowed"] }), { sourceIds: [] });
  assert.equal(canReadRecordId(repo, { scopes: ["wiki:read"], bounds }, "page:allowed"), false);
  assert.equal(canReadRecordId(repo, { scopes: ["wiki:read"], bounds }, "source:allowed"), false);
});

test("event and run visibility checks sensitive fallback paths with public ids", () => {
  const repo = {
    policy: testPolicy(),
    pages: [pageRecord("page:public", "Public", "wiki/public.md", ["public"])],
    sources: [],
    claims: [],
    facts: [],
    takes: [],
    inbox: [],
    proposals: [],
    comments: [],
    decisions: [],
    events: [],
    runs: [],
  };
  const context = { scopes: [], actorId: "actor:user:reader" };
  const event: EventRecord = {
    id: "event:2026-01-01-001",
    uri: "openwiki://event/2026-01-01-001",
    type: "audit.secret",
    workspace_id: "workspace:test",
    occurred_at: "2026-01-01T00:00:00.000Z",
    path: "events/events.jsonl",
    record_id: "page:public",
    data: { secret_paths: ["private/secret.md"] },
  };
  const run: RunRecord = {
    id: "run:2026-01-01-001",
    uri: "openwiki://run/2026-01-01-001",
    type: "run",
    run_type: "test",
    status: "succeeded",
    actor_id: "actor:user:local",
    workspace_id: "workspace:test",
    created_at: "2026-01-01T00:00:00.000Z",
    subject_ids: ["page:public"],
    input: { token_path: "private/secret.md" },
    path: "runs/runs.jsonl",
  };

  assert.equal(canReadEventRecord(repo, context, event), false);
  assert.equal(canReadRunRecord(repo, context, run), false);
});

function testPolicy(): OpenWikiPolicyBundle {
  return {
    sections: [
      { id: "public", title: "Public", paths: ["wiki/**"], visibility: "public" },
      { id: "private", title: "Private", paths: ["private/**"], visibility: "private" },
    ],
    grants: [
      { principal: "group:all-users", section: "public", role: "viewer" },
    ],
    approval_rules: [],
  };
}

function pageRecord(id: string, title: string, repoPath: string, topics: string[], sourceIds: string[] = []): PageRecord {
  return {
    id,
    uri: `openwiki://${id.replace(":", "/")}`,
    type: "page",
    page_type: "concept",
    title,
    body_format: "markdown",
    body: title,
    path: repoPath,
    source_ids: sourceIds,
    claim_ids: [],
    status: "published",
    topics,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

function sourceRecord(id: string, title: string, repoPath: string): SourceRecord {
  return {
    id,
    uri: `openwiki://${id.replace(":", "/")}`,
    type: "source",
    title,
    source_type: "document",
    retrieved_at: "2026-01-01T00:00:00.000Z",
    path: repoPath,
  };
}

function searchResult(id: string, title: string, repoPath: string, sourceIds: string[] = [], type: SearchResponse["results"][number]["type"] = "page"): SearchResponse["results"][number] {
  return {
    id,
    type,
    title,
    uri: `openwiki://${id.replace(":", "/")}`,
    path: repoPath,
    score: 1,
    matched_fields: ["title"],
    citations: sourceIds.map((sourceId) => ({ source_id: sourceId, title: "source", url: undefined })),
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}
