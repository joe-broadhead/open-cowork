import { escapeHtml } from "./html.ts";
import type { PaletteSuggestion, ShellNavItem, ShellOptions, WebAssetManifest } from "./types.ts";
import { DEFAULT_WEB_ASSET_MANIFEST } from "./types.ts";
import { escapeAttribute } from "./utils.ts";

function renderAssetTags(assetBase = "assets/", manifest: WebAssetManifest = DEFAULT_WEB_ASSET_MANIFEST): string {
  const base = assetBase.endsWith("/") ? assetBase : assetBase + "/";
  return [
    `<script src="${escapeAttribute(base + "theme-bootstrap.js")}"></script>`,
    `<link rel="stylesheet" href="${escapeAttribute(base + manifest.css)}">`,
    `<script type="module" src="${escapeAttribute(base + manifest.js)}"></script>`,
  ].join("\n  ");
}

export function renderShell(options: ShellOptions): string {
  const manifest = options.assetManifest ?? DEFAULT_WEB_ASSET_MANIFEST;
  const nav = options.navItems ?? defaultNavItems(options.active);
  const identity =
    options.identityLabel === undefined
      ? ""
      : `<span class="ow-identity-chip" title="${escapeAttribute(options.identityTitle ?? options.identityLabel)}">${escapeHtml(options.identityLabel)}</span>`;
  const hasSidebar = options.sidebar !== undefined;
  const sidebar = options.sidebar === undefined ? "" : `<aside id="openwiki-sidebar" class="ow-sidebar" data-openwiki-sidebar>${options.sidebar}</aside>`;
  const sidebarToggle = hasSidebar
    ? `<button class="ow-icon-button ow-sidebar-toggle" type="button" data-openwiki-sidebar-toggle aria-label="Open page navigation" aria-controls="openwiki-sidebar" aria-expanded="false">☰</button>`
    : "";
  const sidebarBackdrop = hasSidebar ? `<button class="ow-sidebar-backdrop" type="button" data-openwiki-sidebar-close aria-label="Close page navigation"></button>` : "";
  const rightRail = options.rightRail === undefined ? "" : `<aside class="ow-rightrail">${options.rightRail}</aside>`;
  const footer =
    options.footer ??
    `<a href="${navHref(nav, "API") ?? "openapi.json"}">API</a><a href="llms.txt">llms.txt</a><a href="sitemap.xml">Sitemap</a>`;
  const bodyClass = options.bodyClass === undefined ? "" : ` ${escapeAttribute(options.bodyClass)}`;
  const paletteSuggestions = renderPaletteSuggestions(options.paletteSuggestions ?? []);
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>${escapeHtml(options.title)} - OpenWiki</title>
  ${renderAssetTags(options.assetBase, manifest)}
</head>
<body class="ow-app${bodyClass}" data-openwiki-base="${escapeAttribute(options.basePrefix ?? "")}" data-search-index="${escapeAttribute(options.searchIndexHref ?? "search-index.json")}" data-search-api="${escapeAttribute(options.searchApiHref ?? "")}" data-graph-href="${escapeAttribute(options.graphHref ?? "graph.html")}">
  <a class="ow-skip" href="#main">Skip to content</a>
  <header class="ow-topbar">
    <div class="ow-brand">
      <a class="ow-wordmark" href="${escapeAttribute(navHref(nav, "Home") ?? navHref(nav, "Dashboard") ?? "index.html")}">OpenWiki</a>
      <span class="ow-workspace">${escapeHtml(options.workspaceTitle)}</span>
      ${identity}
    </div>
    ${sidebarToggle}
    <button class="ow-search-trigger" type="button" data-openwiki-search-trigger aria-haspopup="dialog" aria-expanded="false" aria-controls="openwiki-command-palette" aria-keyshortcuts="Control+K Meta+K /">
      <span>Search wiki</span><kbd>⌘K</kbd>
    </button>
    <nav class="ow-nav" aria-label="Primary">
      ${nav
        .map((item) => `<a${item.active ? ` aria-current="page"` : ""} class="${item.active ? "is-active" : ""}" href="${escapeAttribute(item.href)}">${escapeHtml(item.label)}</a>`)
        .join("")}
    </nav>
    <button class="ow-icon-button" type="button" data-openwiki-theme-toggle aria-label="Toggle theme">◐</button>
  </header>
  <div class="ow-frame">
    ${sidebar}
    <main id="main" class="ow-main">${options.main}</main>
    ${rightRail}
  </div>
  ${sidebarBackdrop}
  <footer class="ow-footer">${footer}</footer>
  <div id="openwiki-command-palette" class="ow-palette" data-openwiki-palette hidden>
    <div class="ow-palette__dialog" role="dialog" aria-modal="true" aria-label="OpenWiki command palette">
      <input class="ow-palette__input" data-openwiki-palette-input placeholder="Search pages, sources, claims, and commands" autocomplete="off" role="combobox" aria-autocomplete="list" aria-controls="openwiki-command-palette-results" aria-expanded="false">
      <div id="openwiki-command-palette-results" class="ow-palette__results" data-openwiki-palette-results role="listbox"></div>
    </div>
  </div>
  ${paletteSuggestions}
</body>
</html>
`;
}

function renderPaletteSuggestions(suggestions: PaletteSuggestion[]): string {
  if (suggestions.length === 0) {
    return "";
  }
  const payload = suggestions.slice(0, 20).map((suggestion) => ({
    title: suggestion.title,
    href: suggestion.href,
    ...(suggestion.type === undefined ? {} : { type: suggestion.type }),
    ...(suggestion.summary === undefined ? {} : { summary: suggestion.summary }),
  }));
  return `<template data-openwiki-palette-suggestions>${escapeHtml(JSON.stringify(payload))}</template>`;
}

function defaultNavItems(active?: string, prefix = ""): ShellNavItem[] {
  return [
    { label: "Home", href: `${prefix}index.html`, active: active === "home" },
    { label: "Graph", href: `${prefix}graph.html`, active: active === "graph" },
    { label: "Pages", href: `${prefix}index.html#pages`, active: active === "pages" },
    { label: "Topics", href: `${prefix}topics.html`, active: active === "topics" },
    { label: "Changes", href: `${prefix}changes.html`, active: active === "changes" },
    { label: "API", href: `${prefix}openapi.json`, active: active === "api" },
  ];
}

export function navWithPrefix(active: string, prefix: string): ShellNavItem[] {
  return defaultNavItems(active, prefix);
}

function navHref(nav: ShellNavItem[], label: string): string | undefined {
  return nav.find((item) => item.label === label)?.href;
}
