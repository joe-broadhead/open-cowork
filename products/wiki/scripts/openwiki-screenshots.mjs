#!/usr/bin/env node
import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startHttpApi } from "@openwiki/http-api";
import { exportStaticSite } from "@openwiki/static-export";
import { proposeEdit } from "@openwiki/workflows";
import { generateEnterpriseDemoWiki } from "./openwiki-enterprise-demo.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_ROOT = path.join(REPO_ROOT, "examples", "basic-wiki");
const WEB_ROOT = path.join(REPO_ROOT, "packages", "web");
const OUTPUT_DIR = path.join(REPO_ROOT, "artifacts", "openwiki-screenshots");
const SCREENSHOT_FIXTURE = process.env.OPENWIKI_SCREENSHOT_FIXTURE === "enterprise-demo" ? "enterprise-demo" : "basic";

const VIEWPORTS = [
  { name: "mobile", width: 360, height: 760 },
  { name: "tablet", width: 768, height: 960 },
  { name: "desktop", width: 1280, height: 900 },
  { name: "wide", width: 1920, height: 1080 },
];

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openwiki-screenshots-"));
  const staticWiki = path.join(tempRoot, "static-wiki");
  const staticOut = path.join(staticWiki, "public");
  const serverWiki = path.join(tempRoot, "wiki");
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  let staticServer;
  let previewServer;
  let apiServer;
  let browser;
  try {
    await prepareScreenshotWiki(staticWiki);
    await exportStaticSite({
      root: staticWiki,
      outDir: "public",
      baseUrl: "https://example.github.io/open-wiki",
    });
    await prepareScreenshotWiki(serverWiki);
    const proposal = await proposeEdit({
      root: serverWiki,
      pageId: screenshotPageId(),
      body: screenshotProposalBody(),
      actorId: "actor:user:visual-qa",
      rationale: "Create a proposal detail page for screenshot QA.",
    });

    staticServer = await startStaticServer(staticOut);
    previewServer = await startStaticServer(WEB_ROOT);
    apiServer = await startHttpApi({ root: serverWiki, port: 0, defaultPolicy: { role: "admin" } });
    browser = await launchBrowser();
    const page = await browser.newPage({ colorScheme: "dark" });

    const serverViews = [
      { name: "server-dashboard", url: apiServer.url + "/" },
      { name: "server-page", url: apiServer.url + "/pages/" + encodeURIComponent(screenshotPageId()), graph: true },
      { name: "server-edit", url: apiServer.url + "/pages/" + encodeURIComponent(screenshotPageId()) + "/edit" },
      { name: "server-graph", url: apiServer.url + "/graph", graph: true },
      { name: "server-proposal", url: apiServer.url + "/proposals/" + encodeURIComponent(proposal.proposal.id) },
      { name: "server-admin", url: apiServer.url + "/admin" },
      { name: "server-spaces", url: apiServer.url + "/spaces" },
    ];
    const previewViews = [
      { name: "web-preview", url: previewServer.url + "/preview/index.html", graph: true },
    ];

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const view of staticViews()) {
        await capture(page, { ...view, url: staticServer.url + view.path, viewport });
      }
      for (const view of previewViews) {
        await capture(page, { ...view, viewport });
      }
      for (const view of serverViews) {
        await capture(page, { ...view, viewport });
      }
    }

    const manifest = {
      generated_at: new Date().toISOString(),
      output_dir: OUTPUT_DIR,
      viewport_count: VIEWPORTS.length,
      screenshots: VIEWPORTS.flatMap((viewport) =>
        [...staticViews().map((view) => view.name), ...previewViews.map((view) => view.name), ...serverViews.map((view) => view.name)].map((name) => `${name}-${viewport.name}.png`),
      ),
      fixture: SCREENSHOT_FIXTURE,
    };
    await writeFile(path.join(OUTPUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`OpenWiki screenshots written to ${OUTPUT_DIR}`);
  } finally {
    await browser?.close();
    await closeServer(apiServer?.server);
    await closeServer(previewServer?.server);
    await closeServer(staticServer?.server);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function prepareScreenshotWiki(root) {
  if (SCREENSHOT_FIXTURE === "enterprise-demo") {
    await generateEnterpriseDemoWiki({ root, force: true, withDerived: true });
    return;
  }
  await cp(EXAMPLE_ROOT, root, { recursive: true });
}

function staticViews() {
  return [
    { name: "static-home", path: "/index.html", graph: true },
    { name: "static-page", path: SCREENSHOT_FIXTURE === "enterprise-demo" ? "/publics/company-handbook.html" : "/concepts/agent-memory.html", graph: true },
    { name: "static-graph", path: "/graph.html", graph: true },
  ];
}

function screenshotPageId() {
  return SCREENSHOT_FIXTURE === "enterprise-demo" ? "page:public:company-handbook" : "page:concept:agent-memory";
}

function screenshotProposalBody() {
  if (SCREENSHOT_FIXTURE === "enterprise-demo") {
    return "# Company Handbook\n\nScreenshot QA proposal for the OpenWiki enterprise demo human UI.";
  }
  return "# Agent Memory\n\nScreenshot QA proposal for the OpenWiki human UI.";
}

async function capture(page, view) {
  await page.goto(view.url, { waitUntil: "networkidle" });
  await page.waitForTimeout(150);
  await assertNoHorizontalOverflow(page, view.name);
  if (view.graph) {
    await assertGraphCanvasPainted(page, view.name);
  }
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${view.name}-${view.viewport.name}.png`),
    fullPage: true,
  });
}

async function assertNoHorizontalOverflow(page, name) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 2, `${name} has horizontal overflow of ${overflow}px`);
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
