import { createWorkspace } from "@openwiki/repo";
import { buildSearchIndex, searchWiki } from "@openwiki/search";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("local vector retriever is opt-in and can recover synonym matches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-vector-search-"));
  try {
    await createWorkspace(root, "Vector Search Wiki");
    const configPath = path.join(root, "openwiki.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.search = {
      ...((config.search as Record<string, unknown> | undefined) ?? {}),
      embedding: {
        enabled: true,
        provider: "local",
        model: "openwiki-local-sparse-v1",
        dimensions: 128,
        max_chunk_characters: 600,
        chunk_overlap_characters: 60,
        batch_size: 32,
        rebuild: "index",
      },
      enabled_retrievers: {
        exact: true,
        bm25: true,
        ngram: false,
        fuzzy: false,
        graph: false,
        vector: true,
      },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
    await writeFile(
      path.join(root, "wiki", "concepts", "semantic-vehicle.md"),
      [
        "---",
        "id: page:concept:semantic-vehicle",
        "title: Semantic Vehicle",
        "type: concept",
        "summary: Offline vector retrieval fixture",
        "topics:",
        "  - retrieval",
        "status: draft",
        "created_at: 2026-06-13T00:00:00.000Z",
        "updated_at: 2026-06-13T00:00:00.000Z",
        "---",
        "",
        "# Semantic Vehicle",
        "",
        "The archive describes an automobile maintenance notebook without using the shorter synonym.",
      ].join("\n"),
    );

    await buildSearchIndex(root);

    const lexical = await searchWiki(root, { query: "car", types: ["page"], mode: "lexical", limit: 10, include_explain: true });
    assert.ok(!lexical.results.some((result) => result.id === "page:concept:semantic-vehicle"));
    assert.ok(lexical.explain?.diagnostics?.disabled_retrievers?.includes("vector"));

    const hybrid = await searchWiki(root, { query: "car", types: ["page"], mode: "hybrid", limit: 10, include_explain: true });
    assert.equal(hybrid.results[0]?.id, "page:concept:semantic-vehicle");
    assert.ok(hybrid.explain?.retrievers_used.includes("vector"));
    assert.equal(hybrid.explain?.diagnostics?.embedding_provider, "local");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite vector retriever avoids arbitrary capped-prefix ranking", async () => {
  const source = await readFile(path.join(process.cwd(), "packages", "search", "src", "sqlite.ts"), "utf8");
  assert.match(source, /eligibleEmbeddingCount > SQLITE_SEARCH_SCAN_CAP/);
  assert.match(source, /disabledRetrievers: \["vector"\]/);
  assert.match(source, /while \(offset < eligibleEmbeddingCount\)/);
  assert.match(source, /sqliteVectorRows\([^)]*batchLimit, offset\)/);
  assert.match(source, /ORDER BY e\.record_id ASC, e\.chunk_id ASC/);
  assert.match(source, /LIMIT \?\s+OFFSET \?/);
});

test("SQLite vector retriever reports capped relation when visible vector rows exceed fetch limit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-vector-pagination-"));
  try {
    await createWorkspace(root, "Vector Pagination Wiki");
    const configPath = path.join(root, "openwiki.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.search = {
      ...((config.search as Record<string, unknown> | undefined) ?? {}),
      overfetch: 3,
      embedding: {
        enabled: true,
        provider: "local",
        model: "openwiki-local-sparse-v1",
        dimensions: 128,
        max_chunk_characters: 600,
        chunk_overlap_characters: 60,
        batch_size: 32,
        rebuild: "index",
      },
      enabled_retrievers: {
        exact: false,
        bm25: false,
        ngram: false,
        fuzzy: false,
        graph: false,
        vector: true,
      },
    };
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    await mkdir(path.join(root, "wiki", "concepts"), { recursive: true });

    for (let index = 1; index <= 4; index += 1) {
      await writeFile(
        path.join(root, "wiki", "concepts", `vector-pagination-${index}.md`),
        [
          "---",
          `id: page:concept:vector-pagination-${index}`,
          `title: Vector Pagination ${index}`,
          "type: concept",
          "summary: Offline vector pagination fixture",
          "topics:",
          "  - retrieval",
          "status: draft",
          "created_at: 2026-06-13T00:00:00.000Z",
          "updated_at: 2026-06-13T00:00:00.000Z",
          "---",
          "",
          `# Vector Pagination ${index}`,
          "",
          "The archive describes an automobile maintenance notebook without using the shorter synonym.",
        ].join("\n"),
      );
    }

    await buildSearchIndex(root);

    const response = await searchWiki(root, { query: "car", types: ["page"], mode: "hybrid", limit: 1, include_explain: true });
    assert.equal(response.results.length, 1);
    assert.equal(response.total, 3);
    assert.equal(response.total_relation, "capped");
    assert.equal(response.facets_relation, "capped");
    assert.equal(response.truncated, true);
    assert.ok(response.next_cursor);
    assert.ok(response.explain?.retrievers_used.includes("vector"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
