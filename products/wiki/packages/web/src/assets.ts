import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { GraphIndexResponse } from "@openwiki/core";

import { renderDiff } from "./diff.ts";
import { renderArticleMeta, renderBadge, renderBreadcrumb, renderButtonLink, renderFormActions, renderGraphMount, renderMetric, renderPanel, renderRecordList, renderSelect, renderTextInput, renderTextarea } from "./components.ts";
import { renderMarkdown, renderToc } from "./markdown.ts";
import { graphTextFallback } from "./routes.ts";
import { renderShell } from "./shell.ts";
import type { WebAssetManifest } from "./types.ts";

const DEFAULT_WEB_ROOT = resolveWebRoot();
const STYLE_FILES = ["tokens.css", "base.css", "components.css", "markdown.css", "graph.css", "print.css"];
const CLIENT_MODULE_FILES = [
  "diff-controls.js",
  "dom-utils.js",
  "graph/detail.js",
  "graph/fetch.js",
  "graph/index.js",
  "graph/layout.js",
  "graph/node-list.js",
  "graph/renderer.js",
  "graph/utils.js",
  "markdown.js",
  "palette.js",
  "sidebar.js",
  "theme.js",
  "theme-bootstrap.js",
  "toc.js",
];

export interface WebAssetRootOptions {
  root?: string;
}

export interface WebAssetReadResult {
  body: Buffer;
  contentType: string;
  immutable: boolean;
}

export interface WebAssetReader {
  read(name: string): Promise<WebAssetReadResult | undefined>;
}

function resolveWebRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, ".."),
    moduleDir,
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "assets", "assets-manifest.json")) || existsSync(path.join(candidate, "src", "styles"))) {
      return candidate;
    }
  }
  return candidates[0] ?? moduleDir;
}

export async function copyWebAssets(outDir: string, files: string[], relativeDir = "assets", options: WebAssetRootOptions = {}): Promise<WebAssetManifest> {
  const manifest = await buildWebAssets(options);
  const webRoot = currentWebRoot(options);
  const targetDir = path.join(outDir, relativeDir);
  await fs.mkdir(targetDir, { recursive: true });
  for (const file of [manifest.css, manifest.js, "assets-manifest.json", ...CLIENT_MODULE_FILES]) {
    await fs.mkdir(path.dirname(path.join(targetDir, file)), { recursive: true });
    await fs.copyFile(path.join(webRoot, "assets", file), path.join(targetDir, file));
    files.push(path.posix.join(relativeDir, file));
  }
  return manifest;
}

export async function ensureWebAssets(options: WebAssetRootOptions = {}): Promise<void> {
  if (await readBuiltWebAssetManifest(options) === undefined) {
    await buildWebAssets(options);
  }
}

export async function readWebAssetManifest(options: WebAssetRootOptions = {}): Promise<WebAssetManifest> {
  const raw = await fs.readFile(path.join(currentWebRoot(options), "assets", "assets-manifest.json"), "utf8");
  return parseWebAssetManifest(JSON.parse(raw) as unknown);
}

export async function readBuiltWebAssetManifest(options: WebAssetRootOptions = {}): Promise<WebAssetManifest | undefined> {
  try {
    return await readWebAssetManifest(options);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function parseWebAssetManifest(value: unknown): WebAssetManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected web asset manifest object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.css !== "string" || typeof record.js !== "string") {
    throw new Error("Expected web asset manifest css and js entries");
  }
  return { css: record.css, js: record.js };
}

export async function readWebAsset(name: string, options: WebAssetRootOptions = {}): Promise<WebAssetReadResult | undefined> {
  if (!isSafeWebAssetName(name)) {
    return undefined;
  }
  const normalized = path.posix.normalize(name);
  if (await readBuiltWebAssetManifest(options) === undefined) {
    return undefined;
  }
  const assetPath = path.join(currentWebRoot(options), "assets", normalized);
  try {
    const body = await fs.readFile(assetPath);
    return {
      body,
      contentType: webAssetContentType(name),
      immutable: /\.[a-f0-9]{10}\.(?:css|js|svg|woff2)$/.test(name),
    };
  } catch {
    return undefined;
  }
}

export async function resolveWebAsset(name: string, options: WebAssetRootOptions = {}): Promise<WebAssetReadResult | undefined> {
  if (!isSafeWebAssetName(name)) {
    return undefined;
  }
  await ensureWebAssets(options);
  return readWebAsset(name, options);
}

export function webAssetReader(options: WebAssetRootOptions = {}): WebAssetReader {
  return {
    read(name) {
      return resolveWebAsset(name, options);
    },
  };
}

export function isSafeWebAssetName(name: string): boolean {
  const normalized = path.posix.normalize(name);
  return !normalized.startsWith("../") && !normalized.startsWith("/") && normalized === name && /^[A-Za-z0-9._/-]+$/.test(name);
}

function webAssetContentType(name: string): string {
  if (name.endsWith(".css")) return "text/css; charset=utf-8";
  if (name.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (name.endsWith(".svg")) return "image/svg+xml";
  if (name.endsWith(".woff2")) return "font/woff2";
  if (name.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

export async function buildWebAssets(options: WebAssetRootOptions = {}): Promise<WebAssetManifest> {
  const webRoot = currentWebRoot(options);
  const assetsDir = path.join(webRoot, "assets");
  const sourceStylesDir = path.join(webRoot, "src", "styles");
  const sourceClientEntry = path.join(webRoot, "src", "client", "main.js");
  if (!existsSync(sourceStylesDir) || !existsSync(sourceClientEntry)) {
    const packagedManifest = await readBuiltWebAssetManifest(options);
    if (packagedManifest !== undefined) {
      return packagedManifest;
    }
    throw new Error(`OpenWiki web source assets are missing under ${webRoot}`);
  }
  await fs.mkdir(assetsDir, { recursive: true });
  const css = (await Promise.all(STYLE_FILES.map((file) => fs.readFile(path.join(sourceStylesDir, file), "utf8")))).join("\n");
  const js = await fs.readFile(sourceClientEntry, "utf8");
  for (const file of CLIENT_MODULE_FILES) {
    const source = path.join(webRoot, "src", "client", file);
    const target = path.join(assetsDir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
  }
  const cssName = `openwiki.${hash(css)}.css`;
  const jsName = `openwiki.${hash(js)}.js`;
  await fs.writeFile(path.join(assetsDir, cssName), css);
  await fs.writeFile(path.join(assetsDir, jsName), js);
  await fs.writeFile(path.join(assetsDir, "openwiki.css"), css);
  await fs.writeFile(path.join(assetsDir, "openwiki.js"), js);
  const manifest = { css: cssName, js: jsName };
  await writeAssetManifest(assetsDir, manifest);
  await cleanupStaleWebAssets(assetsDir, new Set([cssName, jsName]));
  await writeWebAssetPreview(manifest, options);
  return manifest;
}

async function writeAssetManifest(assetsDir: string, manifest: WebAssetManifest): Promise<void> {
  const manifestPath = path.join(assetsDir, "assets-manifest.json");
  const tempPath = `${manifestPath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.rename(tempPath, manifestPath);
}

export async function cleanupStaleWebAssets(assetsDir: string, keepNames: Set<string>): Promise<void> {
  const entries = await fs.readdir(assetsDir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw error;
  });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && /^openwiki\.[0-9a-f]{10}\.(?:css|js)$/.test(entry.name) && !keepNames.has(entry.name))
    .map((entry) => fs.rm(path.join(assetsDir, entry.name), { force: true })));
}

export async function writeWebAssetPreview(manifest: WebAssetManifest, options: WebAssetRootOptions = {}): Promise<void> {
  const previewDir = path.join(currentWebRoot(options), "preview");
  await fs.mkdir(previewDir, { recursive: true });
  const componentGallery = renderComponentGallery();
  const preview = renderShell({
    title: "OpenWiki Component Preview",
    workspaceTitle: "Preview",
    assetBase: "../assets/",
    assetManifest: manifest,
    searchIndexHref: "",
    main: `<section class="ow-hero"><p class="ow-eyebrow">Design system</p><h1>OpenWiki Web</h1><p>Light-first components for human wiki navigation.</p></section>
      <section class="ow-preview-grid" data-openwiki-component-gallery>
        <div class="ow-preview-surface" data-theme="dark" data-preview-theme="dark">${componentGallery}</div>
        <div class="ow-preview-surface" data-theme="light" data-preview-theme="light">${componentGallery}</div>
      </section>`,
  });
  await fs.writeFile(path.join(previewDir, "index.html"), preview);
}

function currentWebRoot(options: WebAssetRootOptions = {}): string {
  return options.root ?? DEFAULT_WEB_ROOT;
}

function renderComponentGallery(): string {
  const markdown = renderMarkdown([
    "## Article Preview",
    "",
    "Rendered markdown supports **strong text**, `inline code`, [links](https://example.com), and [[Missing Page]].",
    "",
    "- [x] Static export",
    "- [ ] Visual review",
    "",
    "| Area | State |",
    "| --- | --- |",
    "| Graph | ready |",
    "",
    "```ts",
    "const page = 'openwiki';",
    "```",
  ].join("\n")).html;
  const sampleGraph: GraphIndexResponse = {
    nodes: [
      { id: "page:concept:agent-memory", uri: "openwiki://page/concept/agent-memory", record_type: "page", title: "Agent Memory", summary: "A sample page." },
      { id: "source:2026-05-21-001", uri: "openwiki://source/2026-05-21-001", record_type: "source", title: "Protocol Source" },
      { id: "claim:2026-05-21-001", uri: "openwiki://claim/2026-05-21-001", record_type: "claim", title: "Traceable Claim" },
    ],
    edges: [
      { id: "edge:preview:1", uri: "openwiki://edge/preview/1", type: "edge", workspace_id: "workspace:preview", from_id: "page:concept:agent-memory", to_id: "source:2026-05-21-001", edge_type: "page_source", weight: 1, created_at: "2026-05-27T00:00:00Z" },
      { id: "edge:preview:2", uri: "openwiki://edge/preview/2", type: "edge", workspace_id: "workspace:preview", from_id: "page:concept:agent-memory", to_id: "claim:2026-05-21-001", edge_type: "page_claim", weight: 1, created_at: "2026-05-27T00:00:00Z" },
    ],
  };
  return [
    `<section class="ow-metrics">${renderMetric("Pages", 42)}${renderMetric("Sources", 18)}${renderMetric("Claims", 91)}${renderMetric("Topics", 7)}</section>`,
    renderPanel(
      "Breadcrumb",
      renderBreadcrumb([
        { label: "Home", href: "#" },
        { label: "Concepts", href: "#" },
        { label: "Agent Memory" },
      ]),
      { eyebrow: "Navigation" },
    ),
    renderPanel(
      "Article Metadata",
      renderArticleMeta([
        { label: "Status", value: "draft", kind: "badge", variant: "draft" },
        { label: "Type", value: "Concept" },
        { label: "Updated", value: "2026-05-27T10:00:00Z" },
        { label: "Source", value: "Markdown", href: "#", kind: "link" },
        { label: "Data", value: "JSON", href: "#", kind: "link" },
      ]),
      { eyebrow: "Navigation" },
    ),
    renderPanel(
      "Badges And Actions",
      `<div class="ow-chip-list">${["page", "source", "claim", "proposal", "decision", "accepted", "failed"].map((badge) => renderBadge(badge, badge)).join("")}</div>
       <p>${renderButtonLink("Primary Link", "#", "primary")} ${renderButtonLink("Secondary Link", "#", "secondary")}</p>`,
      { eyebrow: "Components" },
    ),
    renderPanel(
      "Records",
      renderRecordList([
        { title: "Agent Memory", href: "#", type: "page", status: "draft", summary: "A sample OpenWiki page." },
        { title: "Protocol Source", href: "#", type: "source", status: "applied", summary: "A source manifest record." },
      ]),
    ),
    renderPanel(
      "Forms",
      `<form class="ow-stacked-form">${renderTextInput("title", "Title", "Agent Memory")}${renderSelect("status", "Status", [{ value: "draft", label: "draft", selected: true }, { value: "accepted", label: "accepted" }])}${renderTextarea("body", "Body", "Markdown body", { rows: 4 })}${renderFormActions("Save Preview")}</form>`,
    ),
    renderPanel("Diff", renderDiff("- old memory note\n+ new memory note\n@@ context @@")),
    renderPanel("Markdown", `<article class="ow-prose">${markdown}</article>`),
    renderPanel("Table Of Contents", renderToc([{ id: "article-preview", level: 2, text: "Article Preview" }])),
    renderPanel(
      "Graph",
      renderGraphMount({
        src: "data:application/json," + encodeURIComponent(JSON.stringify(sampleGraph)),
        mode: "preview",
        title: "Preview Graph",
        height: "260px",
        fallback: graphTextFallback(sampleGraph, 3),
      }),
    ),
  ].join("\n");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}
