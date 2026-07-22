import assert from "node:assert/strict";
import test from "node:test";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { buildWebAssets, renderDiff, renderGraphMount, renderMarkdown, renderShell } from "@openwiki/web";
import { graphIndexForQuery } from "../packages/http-api/src/renderers/graph.ts";

const webSourceRoot = path.resolve("packages/web");

test("graph mount uses data-graph-height instead of style attributes (JOE-980)", () => {
  const html = renderGraphMount({
    src: "graph.json",
    mode: "global",
    height: "620px",
    title: "Public Graph",
  });
  assert.match(html, /data-graph-height="620px"/);
  assert.doesNotMatch(html, /\sstyle=/);
  assert.doesNotMatch(html, /--ow-graph-height/);
});

test("web markdown renderer escapes raw HTML and keeps safe inline syntax", () => {
  const rendered = renderMarkdown([
    "# Agent Memory",
    "",
    "Raw <script>alert('x')</script> stays inert with **strong** text, `code`, [docs](https://example.com), and [protocol relative](//evil.example/path).",
    "",
    "[[Known Page|Known]] and [[Missing Page]]",
  ].join("\n"), {
    resolveWikiLink: (target) => target === "Known Page" ? "concepts/known-page.html" : undefined,
  });

  assert.equal(rendered.toc[0]?.id, "agent-memory");
  assert.match(rendered.html, /&lt;script&gt;alert\('x'\)&lt;\/script&gt;/);
  assert.doesNotMatch(rendered.html, /<script>/);
  assert.match(rendered.html, /<strong>strong<\/strong>/);
  assert.match(rendered.html, /<code>code<\/code>/);
  assert.match(rendered.html, /href="https:\/\/example\.com"/);
  assert.match(rendered.html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(rendered.html, /href="\/\/evil\.example/);
  assert.match(rendered.html, /protocol relative/);
  assert.match(rendered.html, /class="ow-link ow-link--wiki" href="concepts\/known-page\.html"/);
  assert.match(rendered.html, /class="ow-link ow-link--unresolved">Missing Page<\/span>/);
});

test("HTTP graph renderer bounds default index responses", () => {
  const nodes = Array.from({ length: 600 }, (_, index) => ({
    id: `page:test:${String(index).padStart(3, "0")}`,
    uri: `openwiki://page/test/${index}`,
    record_type: "page",
    title: `Page ${index}`,
    path: `wiki/test/page-${index}.md`,
  }));
  const edges = nodes.slice(1).map((node, index) => ({
    id: `edge:test:${index}`,
    uri: `openwiki://edge/test/${index}`,
    type: "edge" as const,
    workspace_id: "workspace:test",
    from_id: nodes[0]?.id ?? "page:test:000",
    to_id: node.id,
    edge_type: "page_link" as const,
    weight: 1,
    created_at: "2026-06-02T00:00:00.000Z",
  }));

  const response = graphIndexForQuery({ nodes, edges }, new URL("http://openwiki.test/api/v1/graph"), {
    defaultLimit: 500,
    maxLimit: 500,
  });
  assert.equal(response.nodes.length, 500);
  assert.ok(response.edges.every((edge) => response.nodes.some((node) => node.id === edge.from_id) && response.nodes.some((node) => node.id === edge.to_id)));
});

test("web asset build writes a two-theme component preview gallery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-web-assets-"));
  try {
    await cp(path.join(webSourceRoot, "src", "styles"), path.join(root, "src", "styles"), { recursive: true });
    await cp(path.join(webSourceRoot, "src", "client"), path.join(root, "src", "client"), { recursive: true });
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(root, "assets", "openwiki.0000000000.css"), "stale");
    const manifest = await buildWebAssets({ root });
    assert.match(manifest.css, /^openwiki\.[a-f0-9]+\.css$/);
    assert.match(manifest.js, /^openwiki\.[a-f0-9]+\.js$/);
    await assert.rejects(access(path.join(root, "assets", "openwiki.0000000000.css")), /ENOENT/);

    const preview = await readFile(path.join(root, "preview", "index.html"), "utf8");
    assert.match(preview, /data-openwiki-component-gallery/);
    assert.match(preview, /data-preview-theme="dark"/);
    assert.match(preview, /data-preview-theme="light"/);
    assert.match(preview, /class="ow-breadcrumb"/);
    assert.match(preview, /aria-label="Breadcrumb"/);
    assert.match(preview, /Article Metadata/);
    assert.match(preview, /class="ow-article-meta"/);
    assert.match(preview, /<dt>Source<\/dt><dd><a href="#">Markdown<\/a><\/dd>/);
    assert.match(preview, /Badges And Actions/);
    assert.match(preview, /class="ow-metric"/);
    assert.match(preview, /class="ow-record-list"/);
    assert.match(preview, /class="ow-stacked-form"/);
    assert.match(preview, /class="ow-diff"/);
    assert.match(preview, /data-openwiki-diff-mode="split"/);
    assert.match(preview, /data-openwiki-copy-diff/);
    assert.match(preview, /class="ow-prose"/);
    assert.match(preview, /data-openwiki-copy-code/);
    assert.match(preview, /class="ow-toc"/);
    assert.match(preview, /data-openwiki-graph/);
    assert.match(preview, /data-openwiki-graph-canvas role="img" tabindex="0"/);
    assert.match(preview, /aria-label="OpenWiki loading graph visualization\."/);
    assert.match(preview, /data-openwiki-graph-fullscreen/);
    assert.match(preview, /data-openwiki-graph-scope="neighborhood"/);
    assert.match(preview, /data-openwiki-graph-zoom="in"/);
    assert.match(preview, /data-openwiki-graph-reset/);
    assert.match(preview, /data-openwiki-graph-search-results/);
    assert.match(preview, /data-openwiki-graph-node-list[^>]+role="listbox"/);
    assert.match(preview, /data-openwiki-graph-node-legend/);
    assert.match(preview, /data-openwiki-graph-edge-legend/);
    assert.match(preview, /aria-controls="openwiki-command-palette"/);
    assert.match(preview, /aria-expanded="false"/);
    assert.match(preview, /role="combobox"/);
    assert.match(preview, /aria-controls="openwiki-command-palette-results"/);
    assert.match(preview, /id="openwiki-command-palette-results"[^>]+role="listbox"/);
    assert.match(preview, /theme-bootstrap\.js/);
    assert.doesNotMatch(preview, /<script>\(function/);

    const shellWithSuggestions = renderShell({
      title: "Suggestion Smoke",
      workspaceTitle: "Preview",
      main: "<p>Body</p>",
      paletteSuggestions: [{ title: "Agent Memory", href: "pages/agent-memory.html", type: "page" }],
    });
    assert.match(shellWithSuggestions, /<template data-openwiki-palette-suggestions>/);
    assert.doesNotMatch(shellWithSuggestions, /script type="application\/json" data-openwiki-palette-suggestions/);

    const client = await readFile(path.join(root, "assets", manifest.js), "utf8");
    assert.match(client, /ow-enhanced/);
    assert.match(client, /initPalette/);
    assert.match(client, /initSidebar/);
    assert.match(client, /initDiffEnhancements/);

    const paletteClient = await readFile(path.join(root, "assets", "palette.js"), "utf8");
    assert.match(paletteClient, /aria-expanded/);
    assert.match(paletteClient, /aria-activedescendant/);
    assert.match(paletteClient, /openwiki-palette-option-\$\{itemIndex\}/);
    assert.match(paletteClient, /template\[data-openwiki-palette-suggestions\]/);
    assert.match(paletteClient, /focusablePaletteElements/);
    assert.match(paletteClient, /event\.metaKey \|\| event\.ctrlKey/);
    assert.match(paletteClient, /groupedResultItems/);
    assert.match(paletteClient, /highlightText/);

    const sidebarClient = await readFile(path.join(root, "assets", "sidebar.js"), "utf8");
    assert.match(sidebarClient, /is-sidebar-open/);

    const tocClient = await readFile(path.join(root, "assets", "toc.js"), "utf8");
    assert.match(tocClient, /IntersectionObserver/);
    assert.match(tocClient, /aria-current/);

    const diffClient = await readFile(path.join(root, "assets", "diff-controls.js"), "utf8");
    assert.match(diffClient, /openwiki-diff-mode/);

    const markdownClient = await readFile(path.join(root, "assets", "markdown.js"), "utf8");
    assert.match(markdownClient, /data-openwiki-copy-citation/);

    const graphClient = await readFile(path.join(root, "assets", "graph", "index.js"), "utf8");
    assert.match(graphClient, /export function initGraphs/);
    assert.match(graphClient, /applyGraphHeightFromDataset/);
    assert.match(graphClient, /applyChipColorsFromDataset/);
    assert.match(graphClient, /data-chip-color/);
    assert.doesNotMatch(graphClient, /style="--ow-chip-color/);
    assert.match(graphClient, /ArrowLeft/);
    assert.match(graphClient, /graphScopeFromParams/);
    assert.match(graphClient, /graphScope === "neighborhood"/);
    assert.match(graphClient, /setOptionalParam\(url, "scope"/);
    assert.match(graphClient, /setOptionalParam\(url, "depth"/);
    assert.match(graphClient, /setOptionalParam\(url, "types"/);
    assert.match(graphClient, /data-openwiki-graph-chip/);
    assert.match(graphClient, /data-openwiki-graph-match/);
    assert.match(graphClient, /return 1500/);
    assert.match(graphClient, /pinnedNodeIds/);
    assert.match(graphClient, /handleGraphDoubleClick/);
    assert.match(graphClient, /expandGraphNode/);
    assert.match(graphClient, /neighborSrcTemplate/);
    assert.match(graphClient, /updateGraphAccessibleLabel/);
    assert.match(graphClient, /arrow keys to pan/);
    assert.match(graphClient, /Graph could not be loaded/);
    assert.match(graphClient, /aria-live/);
    assert.match(graphClient, /updateGraphNodeList/);
    assert.match(graphClient, /handleGraphNodeListKeydown/);

    const graphNodeListClient = await readFile(path.join(root, "assets", "graph", "node-list.js"), "utf8");
    assert.match(graphNodeListClient, /data-openwiki-graph-node-option/);
    assert.match(graphNodeListClient, /handleGraphNodeListKeydown/);
    assert.match(graphNodeListClient, /aria-selected/);

    const graphRendererClient = await readFile(path.join(root, "assets", "graph", "renderer.js"), "utf8");
    assert.match(graphRendererClient, /resetGraphView/);
    assert.match(graphRendererClient, /zoomGraphAt/);

    const graphLayoutClient = await readFile(path.join(root, "assets", "graph", "layout.js"), "utf8");
    assert.match(graphLayoutClient, /cellSize = nodes\.length > 900/);

    const graphDetailClient = await readFile(path.join(root, "assets", "graph", "detail.js"), "utf8");
    assert.match(graphDetailClient, /Focus neighborhood/);
    assert.match(graphDetailClient, /updateGraphDetail/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("web diff renderer emits word-level unified and split views", () => {
  const diff = renderDiff({
    before: "# Agent Memory\n\nOld durable memory note.",
    after: "# Agent Memory\n\nNew durable memory note with citations.",
    beforeLabel: "current",
    afterLabel: "proposed",
  });

  assert.match(diff, /class="ow-diff"/);
  assert.match(diff, /data-mode="unified"/);
  assert.match(diff, /data-openwiki-diff-mode="unified" aria-pressed="true"/);
  assert.match(diff, /data-openwiki-diff-mode="split" aria-pressed="false"/);
  assert.match(diff, /data-openwiki-copy-diff/);
  assert.match(diff, /class="ow-diff__view ow-diff__view--unified"/);
  assert.match(diff, /class="ow-diff__view ow-diff__view--split"/);
  assert.match(diff, /<del class="ow-diff__del">Old<\/del>/);
  assert.match(diff, /<ins class="ow-diff__ins">New<\/ins>/);
  assert.match(diff, /<ins class="ow-diff__ins">with<\/ins>/);
  assert.match(diff, /<ins class="ow-diff__ins">citations<\/ins>/);
  assert.match(diff, /<template data-openwiki-diff-patch>/);
});

test("web diff renderer folds large context and labels Markdown hunks", () => {
  const context = Array.from({ length: 14 }, (_, index) => `Context line ${index + 1}`).join("\n");
  const diff = renderDiff({
    before: `# Agent Memory\n\n${context}\nOld durable memory note.`,
    after: `# Agent Memory\n\n${context}\nNew durable memory note.`,
    contextLines: 2,
  });

  assert.match(diff, /@@ -1,17 \+1,17 @@ \/ Agent Memory/);
  assert.match(diff, /class="ow-diff__row ow-diff__row--fold"/);
  assert.match(diff, /12 unchanged lines/);
  assert.match(diff, /<del class="ow-diff__del">Old<\/del>/);
  assert.match(diff, /<ins class="ow-diff__ins">New<\/ins>/);
});

test("web client maps palette records to safe exported and API routes", async () => {
  const client = (await readFile(path.join(process.cwd(), "packages", "web", "src", "client", "palette.js"), "utf8"))
    .replace(/^import .+ from "\.\/dom-utils\.js";\n\n/, "")
    .replace(/\nexport \{ initPalette \};\n$/, "");
  const classList = { add() {}, remove() {}, toggle() { return false; } };
  const context = {
    URL,
    document: {
      body: { dataset: {}, classList },
      documentElement: { classList, dataset: {} },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener() {},
    },
  } as {
    URL: typeof URL;
    document: {
      body: { dataset: Record<string, string>; classList: typeof classList };
      documentElement: { dataset: Record<string, string>; classList: typeof classList };
      querySelector: () => null;
      querySelectorAll: () => unknown[];
      addEventListener: () => void;
    };
    recordHref?: (record: { id: string; type: string; url?: string }) => string;
    safePaletteHref?: (value: string) => string;
  };

  vm.runInNewContext(client, context);
  const recordHref = context.recordHref;
  assert.ok(recordHref);
  const safePaletteHref = context.safePaletteHref;
  assert.ok(safePaletteHref);

  assert.equal(
    recordHref({ id: "fragment:source:2026-05-21-001:0001", type: "source_fragment", url: "javascript:alert(1)" }),
    "sources/2026-05-21-001.html",
  );
  assert.equal(recordHref({ id: "topic:q-a", type: "topic" }), "topics.html#topic-q-a");
  assert.equal(recordHref({ id: "section:hr", type: "section" }), "#");
  assert.equal(recordHref({ id: "event:2026-05-21-001", type: "event" }), "changes.html");
  assert.equal(recordHref({ id: "commit:abc123", type: "recent_change" }), "changes.html");
  assert.equal(recordHref({ id: "custom:unsafe", type: "custom", url: "javascript:alert(1)" }), "#");
  assert.equal(recordHref({ id: "custom:safe", type: "custom", url: "https://example.com/path" }), "https://example.com/path");
  assert.equal(safePaletteHref("//evil.example/path"), "#");
  assert.equal(safePaletteHref("/pages/page%3Aconcept%3Aagent-memory"), "/pages/page%3Aconcept%3Aagent-memory");
  assert.equal(safePaletteHref("./concepts/agent-memory.html#overview"), "./concepts/agent-memory.html#overview");

  context.document.body.dataset.searchApi = "/api/v1/search";
  assert.equal(
    recordHref({ id: "fragment:source:2026-05-21-001:0001", type: "source_fragment", url: "javascript:alert(1)" }),
    "/sources/source%3A2026-05-21-001",
  );
  assert.equal(recordHref({ id: "event:2026-05-21-001", type: "event" }), "/api/v1/events");
  assert.equal(recordHref({ id: "commit:abc123", type: "recent_change" }), "/api/v1/recent-changes");
  assert.equal(recordHref({ id: "custom:unsafe", type: "custom", url: "javascript:alert(1)" }), "#");
});

test("web markdown renderer supports task lists, tables, horizontal rules, and code fences", () => {
  const rendered = renderMarkdown([
    "- [x] Validate static export",
    "  - Confirm nested item",
    "- [ ] Review graph",
    "1. First ordered item",
    "   1. Nested ordered item",
    "",
    "| Area | Status |",
    "| --- | --- |",
    "| Static | **ready** |",
    "| Server | pending |",
    "",
    "---",
    "",
    "```ts",
    "const unsafe = '<tag>';",
    "```",
    "",
    "Autolink <https://example.com/openwiki>, citation [1], and ~~stale text~~.",
  ].join("\n"));

  assert.match(rendered.html, /class="contains-task-list"/);
  assert.match(rendered.html, /type="checkbox" aria-label="Validate static export" disabled checked/);
  assert.match(rendered.html, /<li>Confirm nested item<\/li>/);
  assert.match(rendered.html, /type="checkbox" aria-label="Review graph" disabled>/);
  assert.match(rendered.html, /<ol><li>First ordered item<ol><li>Nested ordered item<\/li><\/ol><\/li><\/ol>/);
  assert.match(rendered.html, /<table><thead><tr><th>Area<\/th><th>Status<\/th><\/tr><\/thead><tbody>/);
  assert.match(rendered.html, /<td><strong>ready<\/strong><\/td>/);
  assert.match(rendered.html, /<hr>/);
  assert.match(rendered.html, /data-language="ts"/);
  assert.match(rendered.html, /data-openwiki-copy-code/);
  assert.match(rendered.html, /aria-label="Copy code"/);
  assert.match(rendered.html, /&lt;tag&gt;/);
  assert.match(rendered.html, /href="https:\/\/example\.com\/openwiki"/);
  assert.match(rendered.html, /class="ow-citation"><a href="#ref-1">\[1\]<\/a><\/sup>/);
  assert.match(rendered.html, /<del>stale text<\/del>/);
});
