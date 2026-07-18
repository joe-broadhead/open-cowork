#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { exportStaticSite } from "@openwiki/static-export";
import { renderGraphMount, renderShell } from "@openwiki/web";
import { generateEnterpriseDemoWiki } from "./openwiki-enterprise-demo.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_ROOT = path.join(REPO_ROOT, "examples", "basic-wiki");
const WEB_ROOT = path.join(REPO_ROOT, "packages", "web");
const OUTPUT_DIR = path.join(REPO_ROOT, "artifacts");
const REPORT_PATH = path.join(OUTPUT_DIR, "openwiki-ui-quality.json");
const UI_FIXTURE = process.env.OPENWIKI_UI_FIXTURE === "enterprise-demo" ? "enterprise-demo" : "basic";

const VIEWPORTS = [
  { name: "mobile", width: 360, height: 760 },
  { name: "tablet", width: 768, height: 900 },
  { name: "desktop", width: 1280, height: 900 },
  { name: "wide", width: 1920, height: 1080 },
];

const LIMITS = {
  domContentLoadedMs: 2000,
  loadMs: 2500,
  cls: 0.05,
  largeGraphReadyMs: 3000,
  largeGraphWheelMs: 750,
};

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-ui-quality-"));
  const staticWiki = path.join(tempRoot, "wiki");
  const staticOut = path.join(staticWiki, "public");
  let staticServer;
  let previewServer;
  let browser;
  try {
    await prepareUiQualityFixture(staticWiki);
    await exportStaticSite({
      root: staticWiki,
      outDir: "public",
      baseUrl: "https://example.github.io/open-wiki",
    });
    await writeLargeGraphFixture(staticOut);
    staticServer = await startStaticServer(staticOut);
    previewServer = await startStaticServer(WEB_ROOT);
    browser = await launchBrowser();
    const report = {
      generated_at: new Date().toISOString(),
      limits: LIMITS,
      views: [],
    };

    for (const viewport of VIEWPORTS) {
      for (const view of views()) {
        report.views.push(await auditView(browser, staticServer.url, { ...view, viewport }));
      }
    }
    report.views.push(await auditLargeGraph(browser, staticServer.url));
    report.views.push(await auditView(browser, previewServer.url, { name: "component-preview", path: "/preview/index.html", graph: true }));

    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
    console.log(`OpenWiki UI quality report written to ${REPORT_PATH}`);
  } finally {
    await browser?.close();
    await closeServer(previewServer?.server);
    await closeServer(staticServer?.server);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function prepareUiQualityFixture(root) {
  if (UI_FIXTURE === "enterprise-demo") {
    await generateEnterpriseDemoWiki({ root, force: true, withDerived: true });
    return;
  }
  await cp(EXAMPLE_ROOT, root, { recursive: true });
}

function views() {
  return [
    { name: "home", path: "/index.html", graph: true },
    { name: "page", path: UI_FIXTURE === "enterprise-demo" ? "/publics/company-handbook.html" : "/concepts/agent-memory.html", graph: true },
    { name: "graph", path: "/graph.html", graph: true },
    { name: "topics", path: "/topics.html", graph: false },
    { name: "changes", path: "/changes.html", graph: false },
  ];
}

async function newAuditPage(browser, viewport) {
  const page = await browser.newPage({ colorScheme: "dark", viewport: { width: viewport.width, height: viewport.height } });
  await page.addInitScript(() => {
    window.__openWikiCls = 0;
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            window.__openWikiCls += entry.value;
          }
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      window.__openWikiCls = 0;
    }
  });
  return page;
}

async function auditView(browser, baseUrl, view) {
  const viewport = view.viewport ?? { name: "desktop", width: 1280, height: 900 };
  const auditName = `${view.name}-${viewport.name}`;
  const page = await newAuditPage(browser, viewport);
  const consoleErrors = [];
  const pageErrors = [];
  const thirdPartyRequests = [];
  const onConsole = (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  };
  const onPageError = (error) => pageErrors.push(error.message);
  const onRequest = (request) => {
    const requestUrl = request.url();
    if (requestUrl.startsWith("data:") || requestUrl.startsWith("blob:")) {
      return;
    }
    if (new URL(requestUrl).origin !== baseUrl) {
      thirdPartyRequests.push(requestUrl);
    }
  };

  try {
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("request", onRequest);

    await page.goto(baseUrl + view.path, { waitUntil: "networkidle" });
    await page.waitForTimeout(200);

    const metrics = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    return {
      domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
      loadMs: Math.round(navigation.loadEventEnd),
      cls: Number(window.__openWikiCls || 0),
      scrollOverflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      hasMain: document.querySelector("main") !== null,
      hasNav: document.querySelector("nav") !== null,
      hasFooter: document.querySelector("footer") !== null,
      hasH1: document.querySelector("h1") !== null,
      sidebarCount: document.querySelectorAll("[data-openwiki-sidebar]").length,
      sidebarToggleCount: document.querySelectorAll("[data-openwiki-sidebar-toggle]").length,
      unnamedButtons: Array.from(document.querySelectorAll("button")).filter((button) => !button.textContent?.trim() && !button.getAttribute("aria-label")).length,
      unnamedInputs: Array.from(document.querySelectorAll("input, select, textarea")).filter((control) => {
        const id = control.getAttribute("id");
        const hasLabel = id !== null && document.querySelector(`label[for="${CSS.escape(id)}"]`) !== null;
        return !hasLabel && !control.closest("label") && !control.getAttribute("aria-label") && !control.getAttribute("placeholder");
      }).length,
      graphCanvasCount: document.querySelectorAll("[data-openwiki-graph-canvas]").length,
      graphAccessibleCanvasCount: Array.from(document.querySelectorAll("[data-openwiki-graph-canvas]")).filter((canvas) =>
        canvas.getAttribute("role") === "img" &&
        canvas.getAttribute("tabindex") === "0" &&
        /OpenWiki .* graph/.test(canvas.getAttribute("aria-label") || ""),
      ).length,
      graphTextAlternativeCount: document.querySelectorAll(".ow-graph__fallback li, .ow-graph__fallback p").length,
      contrastRatios: Array.from(document.querySelectorAll("[data-preview-theme]")).flatMap((surface) => {
        const styles = getComputedStyle(surface);
        const bg = parseColor(styles.getPropertyValue("--ow-bg"));
        const tokens = [
          { token: "--ow-text", minimum: 4.5 },
          { token: "--ow-text-muted", minimum: 4.5 },
          { token: "--ow-accent", minimum: 4.5 },
          { token: "--ow-page", minimum: 4.5 },
          { token: "--ow-source", minimum: 4.5 },
          { token: "--ow-claim", minimum: 4.5 },
          { token: "--ow-topic", minimum: 4.5 },
          { token: "--ow-section", minimum: 4.5 },
          { token: "--ow-proposal", minimum: 4.5 },
          { token: "--ow-decision", minimum: 4.5 },
          { token: "--ow-success", minimum: 4.5 },
          { token: "--ow-danger", minimum: 4.5 },
        ];
        if (!bg) return [];
        return tokens.map(({ token, minimum }) => {
          const fg = parseColor(styles.getPropertyValue(token));
          return { theme: surface.getAttribute("data-preview-theme") || "", token, minimum, ratio: fg ? contrastRatio(fg, bg) : 0 };
        });
      }),
    };

    function parseColor(value) {
      const color = String(value || "").trim();
      const hex = /^#([0-9a-f]{6})$/i.exec(color);
      if (hex) {
        const raw = hex[1];
        return [Number.parseInt(raw.slice(0, 2), 16), Number.parseInt(raw.slice(2, 4), 16), Number.parseInt(raw.slice(4, 6), 16)];
      }
      const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/i.exec(color);
      return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined;
    }

    function contrastRatio(foreground, background) {
      const fg = relativeLuminance(foreground);
      const bg = relativeLuminance(background);
      const light = Math.max(fg, bg);
      const dark = Math.min(fg, bg);
      return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
    }

    function relativeLuminance(rgb) {
      const [r, g, b] = rgb.map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    });

    assert.ok(metrics.domContentLoadedMs <= LIMITS.domContentLoadedMs, `${auditName} DOMContentLoaded ${metrics.domContentLoadedMs}ms exceeded ${LIMITS.domContentLoadedMs}ms`);
  assert.ok(metrics.loadMs <= LIMITS.loadMs, `${auditName} load ${metrics.loadMs}ms exceeded ${LIMITS.loadMs}ms`);
  assert.ok(metrics.cls <= LIMITS.cls, `${auditName} CLS ${metrics.cls} exceeded ${LIMITS.cls}`);
  assert.ok(metrics.scrollOverflowPx <= 2, `${auditName} has horizontal overflow of ${metrics.scrollOverflowPx}px`);
  assert.equal(metrics.hasMain, true, `${auditName} is missing <main>`);
  assert.equal(metrics.hasNav, true, `${auditName} is missing navigation`);
  assert.equal(metrics.hasFooter, true, `${auditName} is missing footer`);
  assert.equal(metrics.hasH1, true, `${auditName} is missing h1`);
  assert.equal(metrics.unnamedButtons, 0, `${auditName} has unnamed buttons`);
  assert.equal(metrics.unnamedInputs, 0, `${auditName} has unnamed form controls`);
  assert.deepEqual(consoleErrors, [], `${auditName} emitted console errors`);
  assert.deepEqual(pageErrors, [], `${auditName} emitted page errors`);
  assert.deepEqual(thirdPartyRequests, [], `${auditName} made third-party requests`);
  for (const contrast of metrics.contrastRatios) {
    assert.ok(contrast.ratio >= contrast.minimum, `${auditName} ${contrast.theme} ${contrast.token} contrast ${contrast.ratio} is below ${contrast.minimum}`);
  }
  if (view.graph) {
    assert.ok(metrics.graphCanvasCount > 0, `${auditName} is missing graph canvas`);
    assert.equal(metrics.graphAccessibleCanvasCount, metrics.graphCanvasCount, `${auditName} has graph canvases without role, focus, or aria-label`);
    assert.ok(metrics.graphTextAlternativeCount > 0, `${auditName} is missing graph text alternative`);
    await assertGraphCanvasPainted(page, auditName);
    if (view.name === "graph" && viewport.width >= 1280) {
      await assertGraphControls(page, auditName);
      if (UI_FIXTURE === "basic") {
        await assertGraphPinning(page, auditName);
      }
    }
  }
  if (view.name === "home" && viewport.width >= 768) {
    await assertPaletteSearch(page, auditName);
  }
  if (view.name === "component-preview") {
    await assertDiffControls(page, auditName);
    await assertPreviewFormKeyboard(page, auditName);
  }
    if (viewport.width <= 980 && metrics.sidebarCount > 0) {
      assert.equal(metrics.sidebarToggleCount, 1, `${auditName} is missing mobile sidebar toggle`);
      await assertMobileSidebar(page, auditName);
    }

    return { name: view.name, path: view.path, viewport, metrics };
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("request", onRequest);
    await page.close();
  }
}

async function assertMobileSidebar(page, name) {
  const toggle = page.locator("[data-openwiki-sidebar-toggle]");
  await expectVisible(toggle, `${name} sidebar toggle is hidden`);
  await toggle.click();
  await page.waitForTimeout(50);
  assert.equal(await page.locator("html.is-sidebar-open").count(), 1, `${name} sidebar drawer did not open`);
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", `${name} sidebar toggle aria-expanded did not update`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(50);
  assert.equal(await page.locator("html.is-sidebar-open").count(), 0, `${name} sidebar drawer did not close on Escape`);
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", `${name} sidebar toggle aria-expanded did not reset`);
}

async function expectVisible(locator, message) {
  assert.equal(await locator.count(), 1, message);
  assert.equal(await locator.isVisible(), true, message);
}

async function assertPaletteSearch(page, name) {
  await page.locator("[data-openwiki-search-trigger]").first().click();
  const palette = page.locator("[data-openwiki-palette]");
  await palette.locator(".ow-palette__empty").waitFor({ state: "visible", timeout: 1500 });
  assert.equal(await palette.locator(".ow-palette__empty").count(), 1, `${name} palette did not render an empty state`);
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await page.evaluate(() => Boolean(document.querySelector("[data-openwiki-palette]")?.contains(document.activeElement))),
    true,
    `${name} palette focus trap allowed focus to leave the dialog`,
  );
  await palette.locator("[data-openwiki-palette-input]").fill(paletteSearchQuery());
  await page.waitForFunction(
    () => document.querySelectorAll("[data-openwiki-palette-facet]").length >= 5,
    undefined,
    { timeout: 1500 },
  );
  assert.ok(await palette.locator("[data-openwiki-palette-facet]").count() >= 5, `${name} palette did not render result type facets`);
  await palette.locator("[data-openwiki-palette-facet='page']").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".ow-palette__group-title").length > 0 &&
      document.querySelectorAll(".ow-palette__result mark").length > 0 &&
      document.querySelectorAll(".ow-palette__result").length > 0,
    undefined,
    { timeout: 1500 },
  );
  assert.ok(await palette.locator(".ow-palette__group-title").count() > 0, `${name} palette did not group search results`);
  assert.ok(await palette.locator(".ow-palette__result mark").count() > 0, `${name} palette did not highlight matched terms`);
  assert.ok(await palette.locator(".ow-palette__result").count() > 0, `${name} palette returned no results`);
  await palette.locator("[data-openwiki-palette-input]").focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(paletteTargetUrlPattern(), { timeout: 1500 });
}

function paletteSearchQuery() {
  return UI_FIXTURE === "enterprise-demo" ? "enterprise demo" : "agent memory";
}

function paletteTargetUrlPattern() {
  return UI_FIXTURE === "enterprise-demo" ? /company-handbook\.html/ : /agent-memory\.html/;
}

function graphSearchTerm() {
  return UI_FIXTURE === "enterprise-demo" ? "company" : "agent";
}

async function assertDiffControls(page, name) {
  const diff = page.locator(".ow-diff").first();
  assert.equal(await diff.count(), 1, `${name} is missing the diff component`);
  const split = diff.locator("[data-openwiki-diff-mode='split']");
  const unified = diff.locator("[data-openwiki-diff-mode='unified']");
  await split.focus();
  await page.keyboard.press("Enter");
  assert.equal(await diff.getAttribute("data-mode"), "split", `${name} diff split keyboard toggle did not change mode`);
  assert.equal(await split.getAttribute("aria-pressed"), "true", `${name} diff split toggle aria-pressed did not update`);
  assert.equal(await unified.getAttribute("aria-pressed"), "false", `${name} diff unified toggle aria-pressed did not update`);
  assert.match(page.url(), /[?&]diff=split/, `${name} diff split mode did not persist in the URL`);

  await unified.focus();
  await page.keyboard.press("Space");
  assert.equal(await diff.getAttribute("data-mode"), "unified", `${name} diff unified keyboard toggle did not change mode`);
  assert.equal(await unified.getAttribute("aria-pressed"), "true", `${name} diff unified toggle aria-pressed did not reset`);
}

async function assertPreviewFormKeyboard(page, name) {
  const form = page.locator("form.ow-stacked-form").first();
  assert.equal(await form.count(), 1, `${name} is missing the preview form`);
  await form.locator("input[name='title']").focus();
  assert.equal(await activeControlName(page), "title", `${name} could not focus the title field`);
  await page.keyboard.press("Tab");
  assert.equal(await activeControlName(page), "status", `${name} form tab order did not reach the status field`);
  await page.keyboard.press("Tab");
  assert.equal(await activeControlName(page), "body", `${name} form tab order did not reach the body field`);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), "BUTTON", `${name} form tab order did not reach the submit button`);
}

async function activeControlName(page) {
  return page.evaluate(() => document.activeElement?.getAttribute("name") || "");
}

async function auditLargeGraph(browser, baseUrl) {
  const page = await newAuditPage(browser, { name: "desktop", width: 1280, height: 900 });
  try {
    const start = Date.now();
    await page.goto(baseUrl + "/large-graph.html", { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector("[data-openwiki-graph-count]")?.textContent?.includes("1500 of 1500"), undefined, { timeout: LIMITS.largeGraphReadyMs });
    const readyMs = Date.now() - start;
    assert.ok(readyMs <= LIMITS.largeGraphReadyMs, `large graph ready ${readyMs}ms exceeded ${LIMITS.largeGraphReadyMs}ms`);
    await assertGraphCanvasPainted(page, "large graph");

    const wheelStart = Date.now();
    const canvas = page.locator("[data-openwiki-graph-canvas]").first();
    const box = await canvas.boundingBox();
    assert.ok(box, "large graph canvas has no bounding box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -240);
    const wheelMs = Date.now() - wheelStart;
    assert.ok(wheelMs <= LIMITS.largeGraphWheelMs, `large graph wheel interaction ${wheelMs}ms exceeded ${LIMITS.largeGraphWheelMs}ms`);

    return {
      name: "large-graph",
      path: "/large-graph.html",
      metrics: {
        readyMs,
        wheelMs,
        visibleNodes: await page.locator("[data-openwiki-graph-count]").textContent(),
      },
    };
  } finally {
    await page.close();
  }
}

async function assertGraphControls(page, name) {
  const graph = page.locator("[data-openwiki-graph]").first();
  const search = graph.locator("[data-openwiki-graph-search]");
  await search.fill(graphSearchTerm());
  const matches = graph.locator("[data-openwiki-graph-match]");
  assert.ok(await matches.count() > 0, `${name} graph search did not show locate matches`);
  await matches.first().click();
  await page.waitForTimeout(50);
  assert.match(page.url(), /[?&]focus=/, `${name} graph search did not focus a selected node`);

  const nodeChips = graph.locator("[data-openwiki-graph-chip][data-graph-filter-kind='node']");
  assert.ok(await nodeChips.count() > 1, `${name} graph node legend did not render filter chips`);
  const sourceChip = graph.locator("[data-openwiki-graph-chip][data-graph-filter-kind='node'][data-graph-filter-value='source']");
  if (await sourceChip.count() > 0) {
    await sourceChip.first().click();
    await page.waitForTimeout(50);
    assert.match(page.url(), /[?&]types=/, `${name} graph node chip did not persist filter state`);
    assert.doesNotMatch(page.url(), /node_type=/, `${name} graph kept the legacy node_type URL state`);
  }
}

async function assertGraphPinning(page, name) {
  const fit = page.locator("[data-openwiki-graph-fit]").first();
  if (await fit.count() > 0) {
    await fit.click();
    await page.waitForTimeout(80);
  }
  const canvas = page.locator("[data-openwiki-graph-canvas]").first();
  const target = await canvas.evaluate((element) => {
    const state = element.__openWikiGraphState;
    const node = state?.nodes?.find((candidate) => candidate.id === state.selectedNodeId) || state?.nodes?.[0];
    if (!state || !node) return undefined;
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + state.tx + node.x * state.scale,
      y: rect.top + state.ty + node.y * state.scale,
    };
  });
  assert.ok(target, `${name} graph could not find a rendered node for pinning`);
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x + 72, target.y + 36, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(80);
  const pinnedAfterDrag = await canvas.evaluate((element) => element.dataset.pinnedCount || "0");
  assert.equal(pinnedAfterDrag, "1", `${name} graph drag did not pin a node`);

  const pinnedTarget = await canvas.evaluate((element) => {
    const state = element.__openWikiGraphState;
    const pinnedId = Array.from(state?.pinnedNodeIds || [])[0];
    const node = state?.nodes?.find((candidate) => candidate.id === pinnedId);
    if (!state || !node) return undefined;
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + state.tx + node.x * state.scale,
      y: rect.top + state.ty + node.y * state.scale,
    };
  });
  assert.ok(pinnedTarget, `${name} graph could not find the pinned node for release`);
  await page.mouse.dblclick(pinnedTarget.x, pinnedTarget.y);
  await page.waitForTimeout(80);
  const pinnedAfterRelease = await canvas.evaluate((element) => element.dataset.pinnedCount || "0");
  assert.equal(pinnedAfterRelease, "0", `${name} graph double-click did not release the pinned node`);
}

async function assertGraphCanvasPainted(page, name) {
  const painted = await page.locator("[data-openwiki-graph-canvas]").first().evaluate((canvas) => {
    if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0 || canvas.height === 0) {
      return false;
    }
    const context = canvas.getContext("2d");
    if (!context) {
      return false;
    }
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 0) {
        return true;
      }
    }
    return false;
  });
  assert.equal(painted, true, `${name} graph canvas is blank`);
}

async function writeLargeGraphFixture(staticOut) {
  const graph = createLargeGraph(1500);
  const manifest = JSON.parse(await readFile(path.join(staticOut, "assets", "assets-manifest.json"), "utf8"));
  await writeFile(path.join(staticOut, "large-graph.json"), JSON.stringify(graph));
  await writeFile(
    path.join(staticOut, "large-graph.html"),
    renderShell({
      title: "Large Graph",
      workspaceTitle: "OpenWiki QA",
      assetBase: "assets/",
      assetManifest: manifest,
      searchIndexHref: "search-index.json",
      graphHref: "graph.html",
      navItems: [
        { label: "Home", href: "index.html" },
        { label: "Graph", href: "graph.html", active: true },
        { label: "API", href: "openapi.json" },
      ],
      main: `<section class="ow-hero"><p class="ow-eyebrow">Performance fixture</p><h1>Large Graph</h1><p>Exercises the 1,500-node graph rendering budget.</p></section>
        ${renderGraphMount({ src: "large-graph.json", mode: "global", maxNodes: 1500, height: "620px", title: "1,500-node graph", fallback: "<p>Large graph text alternative.</p>" })}`,
    }),
  );
}

function createLargeGraph(count) {
  const nodes = Array.from({ length: count }, (_, index) => {
    const recordType = index % 11 === 0 ? "source" : index % 7 === 0 ? "claim" : index % 5 === 0 ? "topic" : "page";
    const id = `${recordType}:large:${index}`;
    return {
      id,
      uri: `openwiki://${recordType}/large/${index}`,
      record_type: recordType,
      title: `Large ${recordType} ${index}`,
      summary: `Synthetic large graph node ${index}.`,
    };
  });
  const edges = [];
  for (let index = 1; index < count; index += 1) {
    edges.push({
      id: `edge:large:${index}:parent`,
      from_id: nodes[index].id,
      to_id: nodes[Math.max(0, Math.floor((index - 1) / 2))].id,
      edge_type: index % 11 === 0 ? "page_source" : index % 7 === 0 ? "page_claim" : index % 5 === 0 ? "page_topic" : "page_link",
      weight: 1 + (index % 3),
      created_at: "2026-05-27T00:00:00.000Z",
    });
    if (index > 12 && index % 4 === 0) {
      edges.push({
        id: `edge:large:${index}:cross`,
        from_id: nodes[index].id,
        to_id: nodes[(index * 13) % count].id,
        edge_type: "page_link",
        weight: 1,
        created_at: "2026-05-27T00:00:00.000Z",
      });
    }
  }
  return { nodes, edges };
}

async function launchBrowser() {
  const executablePath = await findLocalChrome();
  try {
    return await chromium.launch({
      ...(executablePath === undefined ? {} : { executablePath }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nInstall a browser with 'pnpm exec playwright install chromium' or set PLAYWRIGHT_CHROMIUM_EXECUTABLE.`);
  }
}

async function findLocalChrome() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Try the next common browser location.
    }
  }
  return undefined;
}

async function startStaticServer(root) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://openwiki.local");
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const filePath = safeStaticPath(root, pathname);
    if (filePath === undefined) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }
    try {
      const body = await readFile(filePath);
      response.writeHead(200, { "content-type": contentType(filePath) });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object", "Expected static server TCP address");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function safeStaticPath(root, pathname) {
  if (pathname.includes("\0")) {
    return undefined;
  }
  const resolved = path.resolve(root, "." + pathname);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return resolved;
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

async function closeServer(server) {
  if (!server) {
    return;
  }
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

await main();
