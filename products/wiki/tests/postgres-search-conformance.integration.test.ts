import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import type { SearchRequest } from "@openwiki/core";
import { migratePostgresRuntime, rebuildPostgresRuntimeIndex, searchCurrentPostgresRuntime } from "@openwiki/postgres-runtime";
import { createWorkspace, renderPageMarkdown } from "@openwiki/repo";
import { buildSearchIndex, searchWiki } from "@openwiki/search";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.OPENWIKI_POSTGRES_TEST_DATABASE_URL ?? process.env.OPENWIKI_DATABASE_URL ?? process.env.DATABASE_URL;

test("Postgres search conforms to SQLite for filtered visible result windows", { skip: databaseUrl === undefined ? "DATABASE_URL is not configured" : false }, async () => {
  assert.ok(databaseUrl);
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-postgres-search-conformance-"));
  const env = snapshotEnv(["OPENWIKI_DATABASE_URL", "DATABASE_URL", "OPENWIKI_SEARCH_BACKEND", "OPENWIKI_RUNTIME_BACKEND"]);
  try {
    await createWorkspace(root, { template: "personal-wiki", title: `Postgres Search Conformance ${Date.now()}` });
    await writeFilteredSearchFixturePages(root);
    await git(root, ["init"]);
    await git(root, ["config", "user.name", "OpenWiki Postgres Search Test"]);
    await git(root, ["config", "user.email", "openwiki-postgres-search@example.com"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "Initial wiki"]);

    process.env.OPENWIKI_DATABASE_URL = databaseUrl;
    process.env.DATABASE_URL = databaseUrl;
    await migratePostgresRuntime({ databaseUrl });
    await rebuildPostgresRuntimeIndex(root, { databaseUrl });
    await buildSearchIndex(root);

    const request: SearchRequest = {
      query: "postgres filtered parity marker",
      limit: 5,
      types: ["page"],
      filters: { status: ["draft"], topics: ["postgres-filtered-parity"] },
    };
    delete process.env.OPENWIKI_RUNTIME_BACKEND;
    delete process.env.OPENWIKI_SEARCH_BACKEND;
    const sqliteSearch = await searchWiki(root, request);
    process.env.OPENWIKI_SEARCH_BACKEND = "postgres";
    const postgresSearch = await searchCurrentPostgresRuntime(root, request);

    assert.ok(postgresSearch);
    assert.ok(sqliteSearch.facets);
    assert.ok(postgresSearch.facets);
    assert.deepEqual(
      postgresSearch.results.map((result) => result.id),
      sqliteSearch.results.map((result) => result.id),
    );
    assert.equal(postgresSearch.facets.types.page, sqliteSearch.facets.types.page);
    assert.equal(postgresSearch.facets.status.draft, sqliteSearch.facets.status.draft);
    assert.equal(postgresSearch.facets.topics["postgres-filtered-parity"], sqliteSearch.facets.topics["postgres-filtered-parity"]);
  } finally {
    restoreEnv(env);
    await rm(root, { recursive: true, force: true });
  }
});

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd: root });
  return result.stdout.trim();
}

async function writeFilteredSearchFixturePages(root: string): Promise<void> {
  await mkdir(path.join(root, "wiki", "postgres-filtered"), { recursive: true });
  for (let index = 0; index < 12; index += 1) {
    const padded = String(index).padStart(3, "0");
    await writeFilteredSearchFixturePage(root, `match-${padded}`, `Postgres Filtered Match ${padded}`, "draft", ["postgres-filtered-parity"]);
  }
  await writeFilteredSearchFixturePage(root, "wrong-status", "Postgres Filtered Wrong Status", "published", ["postgres-filtered-parity"]);
  await writeFilteredSearchFixturePage(root, "wrong-topic", "Postgres Filtered Wrong Topic", "draft", ["postgres-filtered-other"]);
}

async function writeFilteredSearchFixturePage(root: string, slug: string, title: string, status: "draft" | "published", topics: string[]): Promise<void> {
  await writeFile(
    path.join(root, "wiki", "postgres-filtered", `${slug}.md`),
    renderPageMarkdown({
      id: `page:postgres-filtered:${slug}`,
      uri: `openwiki://page/postgres-filtered/${slug}`,
      type: "page",
      page_type: "note",
      title,
      summary: "postgres filtered parity marker page.",
      body_format: "markdown",
      body: `# ${title}\n\npostgres filtered parity marker page.`,
      path: `wiki/postgres-filtered/${slug}.md`,
      source_ids: [],
      claim_ids: [],
      status,
      topics,
      created_at: "2026-06-16T00:00:00.000Z",
      updated_at: "2026-06-16T00:00:00.000Z",
    }),
  );
}

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(values: Map<string, string | undefined>): void {
  for (const [key, value] of values) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
