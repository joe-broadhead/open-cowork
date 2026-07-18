import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import test from "node:test";
import { routeHttpRequest } from "@openwiki/http-api";
import { createWorkspace } from "@openwiki/repo";
import { buildSearchIndex, searchWiki } from "@openwiki/search";
import { readSearchIndexMetadata } from "../packages/search/src/cache.ts";
import { SEARCH_INDEX_METADATA_CACHE } from "../packages/search/src/types.ts";

test("SQLite search parses only indexed lexical candidates for basic queries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-search-scale-"));
  try {
    await createWorkspace(root, { template: "basic", title: "Search Scale Wiki" });
    const conceptsDir = path.join(root, "wiki", "concepts");
    await mkdir(conceptsDir, { recursive: true });
    const now = "2026-05-29T00:00:00.000Z";
    for (let index = 0; index < 80; index += 1) {
      const ordinal = String(index).padStart(3, "0");
      const needle = `uniqueindexedneedle${ordinal}`;
      await writeFile(
        path.join(conceptsDir, `indexed-${ordinal}.md`),
        [
          "---",
          `id: page:concept:indexed-${ordinal}`,
          "type: concept",
          `title: Indexed Search ${ordinal}`,
          `summary: Indexed search fixture for ${needle}.`,
          "status: published",
          "topics:",
          "  - indexed-scale",
          "source_ids:",
          "  - source:2026-05-21-001",
          "claim_ids: []",
          `created_at: ${now}`,
          `updated_at: ${now}`,
          "---",
          "",
          `# Indexed Search ${ordinal}`,
          "",
          `This page contains ${needle} for indexed lexical retrieval.`,
          "",
        ].join("\n"),
      );
    }

    await buildSearchIndex(root);
    const direct = await searchWiki(root, {
      query: "uniqueindexedneedle042",
      types: ["page"],
      limit: 5,
      include_explain: true,
    });
    assert.equal(direct.results[0]?.id, "page:concept:indexed-042");
    assert.equal(direct.total_relation, "exact");
    assert.equal(direct.facets_relation, "exact");
    assert.equal(direct.explain?.diagnostics?.candidate_strategy, "indexed_lexical");
    assert.ok((direct.explain?.diagnostics?.index_record_count ?? 0) > 50);
    assert.ok(
      (direct.explain?.diagnostics?.record_json_reads ?? Number.POSITIVE_INFINITY) <
        (direct.explain?.diagnostics?.index_record_count ?? 0),
    );

    const http = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/search?q=uniqueindexedneedle042&type=page&limit=5&explain=true",
      undefined,
      { role: "admin" },
    );
    assert.equal(http.status, 200);
    const body = http.body as { results: Array<{ id: string }>; explain?: { diagnostics?: { record_json_reads?: number; index_record_count?: number } } };
    assert.equal(body.results[0]?.id, "page:concept:indexed-042");
    assert.ok((body.explain?.diagnostics?.record_json_reads ?? Number.POSITIVE_INFINITY) < (body.explain?.diagnostics?.index_record_count ?? 0));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite search metadata cache is bounded and invalidated after rebuild", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-search-metadata-cache-"));
  try {
    await createWorkspace(root, { template: "basic", title: "Search Metadata Cache Wiki" });
    const first = await buildSearchIndex(root);
    const db = new DatabaseSync(first.dbPath);
    try {
      await readSearchIndexMetadata(db, first.dbPath);
    } finally {
      db.close();
    }
    assert.ok([...SEARCH_INDEX_METADATA_CACHE.keys()].some((key) => key.startsWith(`${first.dbPath}:`)));

    await writeFile(
      path.join(root, "wiki", "concepts", "metadata-cache.md"),
      [
        "---",
        "id: page:concept:metadata-cache",
        "type: concept",
        "title: Metadata Cache",
        "summary: Search metadata cache invalidation fixture.",
        "status: published",
        "topics: []",
        "source_ids: []",
        "claim_ids: []",
        "created_at: 2026-05-31T00:00:00.000Z",
        "updated_at: 2026-05-31T00:00:00.000Z",
        "---",
        "",
        "# Metadata Cache",
        "",
        "Rebuilding the search index must clear stale metadata entries.",
        "",
      ].join("\n"),
    );
    const rebuilt = await buildSearchIndex(root);
    assert.equal(rebuilt.dbPath, first.dbPath);
    assert.equal([...SEARCH_INDEX_METADATA_CACHE.keys()].some((key) => key.startsWith(`${first.dbPath}:`)), false);

    for (let index = 0; index < 40; index += 1) {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-search-metadata-cache-extra-"));
      const dbPath = path.join(tempRoot, "index.sqlite");
      const extraDb = new DatabaseSync(dbPath);
      try {
        extraDb.exec("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE records (id TEXT PRIMARY KEY)");
        extraDb.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run("schema_version", "test");
        extraDb.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)").run("record_count", "0");
        await readSearchIndexMetadata(extraDb, dbPath);
      } finally {
        extraDb.close();
        await rm(tempRoot, { recursive: true, force: true });
      }
    }
    assert.ok(SEARCH_INDEX_METADATA_CACHE.size <= 32);
  } finally {
    SEARCH_INDEX_METADATA_CACHE.clear();
    await rm(root, { recursive: true, force: true });
  }
});

test("hosted runtime mode disables request-path search rebuilds unless explicitly overridden", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-search-hosted-"));
  const oldRuntimeMode = process.env.OPENWIKI_RUNTIME_MODE;
  const oldRuntimeBackend = process.env.OPENWIKI_RUNTIME_BACKEND;
  const oldSearchBackend = process.env.OPENWIKI_SEARCH_BACKEND;
  const oldDatabase = process.env.DATABASE_URL;
  const oldOpenWikiDatabase = process.env.OPENWIKI_DATABASE_URL;
  try {
    await createWorkspace(root, { template: "basic", title: "Hosted Search Wiki" });
    process.env.OPENWIKI_RUNTIME_MODE = "hosted";
    delete process.env.OPENWIKI_RUNTIME_BACKEND;
    delete process.env.OPENWIKI_SEARCH_BACKEND;
    delete process.env.DATABASE_URL;
    delete process.env.OPENWIKI_DATABASE_URL;

    await assert.rejects(
      searchWiki(root, {
        query: "agent memory",
        limit: 1,
      }),
      /request-path rebuilds are disabled in hosted runtime mode/,
    );

    const diagnostic = await searchWiki(
      root,
      {
        query: "agent memory",
        limit: 1,
      },
      {
        allowIndexBuild: true,
        allowFullScanFallback: true,
      },
    );
    assert.equal(diagnostic.results[0]?.id, "page:concept:agent-memory");
  } finally {
    restoreEnv("OPENWIKI_RUNTIME_MODE", oldRuntimeMode);
    restoreEnv("OPENWIKI_RUNTIME_BACKEND", oldRuntimeBackend);
    restoreEnv("OPENWIKI_SEARCH_BACKEND", oldSearchBackend);
    restoreEnv("DATABASE_URL", oldDatabase);
    restoreEnv("OPENWIKI_DATABASE_URL", oldOpenWikiDatabase);
    await rm(root, { recursive: true, force: true });
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
