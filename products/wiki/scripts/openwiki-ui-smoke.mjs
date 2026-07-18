#!/usr/bin/env node
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exportStaticSite } from "@openwiki/static-export";
import { startHttpApi } from "@openwiki/http-api";
import { generateEnterpriseDemoWiki } from "./openwiki-enterprise-demo.mjs";

const sourceRoot = path.resolve("examples/basic-wiki");
const UI_FIXTURE = process.env.OPENWIKI_UI_FIXTURE === "enterprise-demo" ? "enterprise-demo" : "basic";
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-ui-"));
const root = path.join(tempRoot, "wiki");

try {
  await prepareUiFixture(root);
  const result = await exportStaticSite({
    root,
    outDir: "public",
    baseUrl: "https://example.github.io/open-wiki",
  });
  const outDir = result.outDir;
  assert.ok(result.files.includes("index.html"));
  assert.ok(result.files.includes("graph.html"));
  assert.ok(result.files.includes(staticPagePath()));
  assert.ok(result.files.some((file) => /^assets\/openwiki\.[a-f0-9]+\.css$/.test(file)));
  assert.ok(result.files.some((file) => /^assets\/openwiki\.[a-f0-9]+\.js$/.test(file)));
  assert.ok(result.files.includes("assets/graph/fetch.js"));

  const indexHtml = await readFile(path.join(outDir, "index.html"), "utf8");
  assert.match(indexHtml, /class="ow-topbar"/);
  assert.match(indexHtml, /data-search-index="search-index\.json"/);
  assert.match(indexHtml, /data-openwiki-palette-form/);
  assert.match(indexHtml, /data-openwiki-palette/);
  assert.match(indexHtml, new RegExp(`href="${escapeRegExp(staticPagePath())}"`));
  assert.doesNotMatch(indexHtml, /href="\/assets\//);

  const pageHtml = await readFile(path.join(outDir, staticPagePath()), "utf8");
  assert.match(pageHtml, /class="ow-prose"/);
  assert.match(pageHtml, /data-graph-mode="local"/);
  assert.match(pageHtml, /class="ow-graph__fallback"/);
  assert.match(pageHtml, /href="\.\.\/assets\/openwiki\.[a-f0-9]+\.css"/);

  const graphHtml = await readFile(path.join(outDir, "graph.html"), "utf8");
  assert.match(graphHtml, /data-openwiki-graph/);
  assert.match(graphHtml, /data-graph-src="graph\.json"/);
  assert.match(graphHtml, /class="ow-graph__fallback"/);
  assert.match(graphHtml, /data-openwiki-graph-search/);
  assert.match(graphHtml, /data-openwiki-graph-search-results/);
  assert.match(graphHtml, /data-openwiki-graph-node-legend/);
  assert.match(graphHtml, /data-openwiki-graph-edge-legend/);
  assert.match(graphHtml, /data-openwiki-graph-fit/);

  const server = await startHttpApi({ root, port: 0 });
  try {
    const home = await fetch(server.url + "/");
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.match(homeHtml, /data-search-api="\/api\/v1\/search"/);
    assert.match(homeHtml, /href="\/_assets\/openwiki\.css"/);

    const homeHead = await fetch(server.url + "/", { method: "HEAD" });
    assert.equal(homeHead.status, 200);
    assert.match(homeHead.headers.get("content-type") ?? "", /text\/html/);
    assert.match(homeHead.headers.get("etag") ?? "", /^"sha256-/);
    assert.equal(homeHead.headers.get("cache-control"), "no-cache");

    const pageJson = await fetch(server.url + "/api/v1/pages/" + encodeURIComponent(expectedPageId()), { method: "HEAD" });
    assert.equal(pageJson.status, 200);
    assert.match(pageJson.headers.get("content-type") ?? "", /application\/json/);
    assert.match(pageJson.headers.get("etag") ?? "", /^"sha256-/);

    const css = await fetch(server.url + "/_assets/openwiki.css", { method: "HEAD" });
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    const graph = await fetch(server.url + "/graph");
    assert.equal(graph.status, 200);
    const graphBody = await graph.text();
    assert.match(graphBody, /data-graph-src="\/api\/v1\/graph\?seed=top&amp;limit=1500"/);
    assert.match(graphBody, /data-openwiki-graph-search/);
    assert.match(graphBody, /data-openwiki-graph-search-results/);
    assert.match(graphBody, /data-openwiki-graph-node-legend/);

    const search = await fetch(server.url + `/api/v1/search?q=${encodeURIComponent(searchQuery())}&type=page&limit=1`);
    assert.equal(search.status, 200);
    const searchBody = await search.json();
    assert.equal(searchBody.results?.[0]?.id, expectedPageId());

    const pagedSearch = await fetch(server.url + `/api/v1/search?q=${encodeURIComponent(pagedSearchQuery())}&limit=1`);
    assert.equal(pagedSearch.status, 200);
    const pagedSearchBody = await pagedSearch.json();
    assert.ok(pagedSearchBody.next_cursor);
    const nextSearch = await fetch(server.url + `/api/v1/search?q=${encodeURIComponent(pagedSearchQuery())}&limit=1&cursor=${encodeURIComponent(pagedSearchBody.next_cursor)}`);
    assert.equal(nextSearch.status, 200);
    const nextSearchBody = await nextSearch.json();
    assert.notEqual(nextSearchBody.results?.[0]?.id, pagedSearchBody.results?.[0]?.id);
  } finally {
    await new Promise((resolve, reject) => server.server.close((error) => (error ? reject(error) : resolve())));
  }

  console.log("OpenWiki UI smoke checks passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function prepareUiFixture(root) {
  if (UI_FIXTURE === "enterprise-demo") {
    await generateEnterpriseDemoWiki({ root, force: true, withDerived: true });
    return;
  }
  await cp(sourceRoot, root, { recursive: true });
}

function staticPagePath() {
  return UI_FIXTURE === "enterprise-demo" ? "publics/company-handbook.html" : "concepts/agent-memory.html";
}

function expectedPageId() {
  return UI_FIXTURE === "enterprise-demo" ? "page:public:company-handbook" : "page:concept:agent-memory";
}

function searchQuery() {
  return UI_FIXTURE === "enterprise-demo" ? "enterprise-demo-public-knowledge-alpha" : "agent memory";
}

function pagedSearchQuery() {
  return UI_FIXTURE === "enterprise-demo" ? "enterprise demo" : "agent";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
