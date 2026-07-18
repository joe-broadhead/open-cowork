import assert from "node:assert/strict";
import test from "node:test";
import {
  openWikiSearchFacetsFromItems,
  openWikiSearchResponse,
  openWikiVisibleSearchResponse,
  type SearchResponse,
  type SearchResult,
} from "../src/index.ts";

test("search response builder owns exact totals, facets, and cursor fields", () => {
  const result = searchResult("page:public", "page", "wiki/public.md");
  const response = openWikiSearchResponse({
    serving_layer: "sqlite",
    results: [result],
    total: 3,
    total_relation: "exact",
    truncated: true,
    persona: "default",
    next_cursor: "offset:1",
    facets: openWikiSearchFacetsFromItems([{ id: result.id, type: result.type, status: "published", topics: ["public"] }]),
    facets_relation: "exact",
  });

  assert.equal(response.count, 1);
  assert.equal(response.total, 3);
  assert.equal(response.total_relation, "exact");
  assert.equal(response.truncated, true);
  assert.equal(response.next_cursor, "offset:1");
  assert.deepEqual(response.facets, { types: { page: 1 }, status: { published: 1 }, topics: { public: 1 } });
  assert.equal(response.facets_relation, "exact");
});

test("search facet builder deduplicates repeated records", () => {
  assert.deepEqual(openWikiSearchFacetsFromItems([
    { id: "page:public", type: "page", status: "published", topics: ["public"] },
    { id: "page:public", type: "page", status: "published", topics: ["public"] },
    { id: "source:public", type: "source", status: "active", topics: [] },
  ]), { types: { page: 1, source: 1 }, status: { published: 1, active: 1 }, topics: { public: 1 } });
});

test("visible search response caps totals and facets without leaking hidden records", () => {
  const publicResult = searchResult("page:public", "page", "wiki/public.md");
  const privateResult = searchResult("page:private", "page", "private/secret.md");
  const response: SearchResponse = {
    results: [publicResult, privateResult],
    count: 2,
    total: 10,
    total_relation: "exact",
    truncated: true,
    persona: "default",
    next_cursor: "offset:2",
    facets: { types: { page: 10 }, status: { published: 9, private: 1 }, topics: { public: 9, secret: 1 } },
    facets_relation: "exact",
  };

  const visible = openWikiVisibleSearchResponse({
    response,
    visibleResults: [publicResult],
    facets: openWikiSearchFacetsFromItems([{ id: publicResult.id, type: publicResult.type, status: "published", topics: ["public"] }]),
  });

  assert.equal(visible.count, 1);
  assert.equal(visible.total, 1);
  assert.equal(visible.total_relation, "capped");
  assert.equal(visible.truncated, false);
  assert.equal(visible.next_cursor, undefined);
  assert.deepEqual(visible.facets, { types: { page: 1 }, status: { published: 1 }, topics: { public: 1 } });
  assert.equal(visible.facets_relation, "capped");
});

test("visible no-result response preserves capped relation without cursor", () => {
  const response = openWikiSearchResponse({
    results: [searchResult("page:private", "page", "private/secret.md")],
    total: 1,
    total_relation: "capped",
    truncated: true,
    persona: "default",
    next_cursor: "offset:1",
    facets: { types: { page: 1 }, status: { private: 1 }, topics: { secret: 1 } },
    facets_relation: "capped",
  });

  const visible = openWikiVisibleSearchResponse({ response, visibleResults: [], facets: openWikiSearchFacetsFromItems([]) });

  assert.equal(visible.count, 0);
  assert.equal(visible.total, 0);
  assert.equal(visible.total_relation, "capped");
  assert.equal(visible.truncated, false);
  assert.equal(visible.next_cursor, undefined);
  assert.deepEqual(visible.facets, { types: {}, status: {}, topics: {} });
  assert.equal(visible.facets_relation, "capped");
});

function searchResult(id: string, type: string, repoPath: string): SearchResult {
  return {
    id,
    type,
    title: id,
    uri: `openwiki://${id.replace(":", "/")}`,
    path: repoPath,
    score: 1,
    matched_fields: ["title"],
    citations: [],
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}
