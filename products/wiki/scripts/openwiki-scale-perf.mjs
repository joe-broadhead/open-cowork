#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { rebuildIndexStore } from "@openwiki/index-store";
import { startHttpApi } from "@openwiki/http-api";
import { createWorkspace } from "@openwiki/repo";
import { buildSearchIndex } from "@openwiki/search";

const OUTPUT_DIR = path.resolve("artifacts");
const MODE = process.env.OPENWIKI_SCALE_MODE === "benchmark" ? "benchmark" : "smoke";
const STAGE = process.env.OPENWIKI_SCALE_STAGE ?? "1k";
const STAGE_RECORDS = {
  "1k": 1_000,
  "10k": 10_000,
  "100k": 100_000,
  "1m": 1_000_000,
};
const PROFILE_TARGETS = {
  "v0.1": "1k pages on local CI-class hardware through SQLite search and derived graph indexes.",
  "v0.2": "10k pages on scheduled benchmark hardware with p50/p95 budgets tracked as release evidence.",
  enterprise: "100k+ records through hosted Postgres search/read backends with external storage, queues, and benchmark reports.",
};
const DEFAULT_BUDGETS = {
  smoke: {
    "1k": { recordsP95Ms: 250, searchP95Ms: 750, pageP95Ms: 400, graphP95Ms: 250 },
    "10k": { recordsP95Ms: 500, searchP95Ms: 600, pageP95Ms: 800, graphP95Ms: 500 },
    "100k": { recordsP95Ms: 1000, searchP95Ms: 1200, pageP95Ms: 1500, graphP95Ms: 1000 },
    "1m": { recordsP95Ms: 2500, searchP95Ms: 3000, pageP95Ms: 3500, graphP95Ms: 2500 },
  },
  benchmark: {
    "1k": { recordsP95Ms: 250, searchP95Ms: 750, pageP95Ms: 400, graphP95Ms: 250 },
    "10k": { recordsP95Ms: 500, searchP95Ms: 1500, pageP95Ms: 2500, graphP95Ms: 750 },
    "100k": { recordsP95Ms: 1500, searchP95Ms: 1800, pageP95Ms: 2500, graphP95Ms: 1500 },
    "1m": { recordsP95Ms: 5000, searchP95Ms: 6000, pageP95Ms: 7000, graphP95Ms: 5000 },
  },
};
const DEFAULT_RECORDS = STAGE_RECORDS[STAGE] ?? STAGE_RECORDS["1k"];
const RECORDS = boundedInteger(process.env.OPENWIKI_SCALE_RECORDS, DEFAULT_RECORDS, 100, 1_000_000);
const ITERATIONS = boundedInteger(process.env.OPENWIKI_SCALE_ITERATIONS, MODE === "smoke" ? 8 : 20, 5, 100);
const REPORT_PATH = path.join(OUTPUT_DIR, `openwiki-scale-perf-${MODE}-${STAGE}.json`);
const LEGACY_REPORT_PATH = path.join(OUTPUT_DIR, "openwiki-scale-perf.json");
const DEFAULT_LIMITS = DEFAULT_BUDGETS[MODE][STAGE] ?? DEFAULT_BUDGETS[MODE]["1k"];
const LIMITS = {
  recordsP95Ms: boundedInteger(process.env.OPENWIKI_SCALE_RECORDS_P95_MS, DEFAULT_LIMITS.recordsP95Ms, 1, 10_000),
  searchP95Ms: boundedInteger(process.env.OPENWIKI_SCALE_SEARCH_P95_MS, DEFAULT_LIMITS.searchP95Ms, 1, 10_000),
  pageP95Ms: boundedInteger(process.env.OPENWIKI_SCALE_PAGE_P95_MS, DEFAULT_LIMITS.pageP95Ms, 1, 10_000),
  graphP95Ms: boundedInteger(process.env.OPENWIKI_SCALE_GRAPH_P95_MS, DEFAULT_LIMITS.graphP95Ms, 1, 10_000),
};
const ENFORCE_BUDGETS = process.env.OPENWIKI_SCALE_ENFORCE === "1" || MODE === "smoke";

process.env.OPENWIKI_INDEX_STORE_ALLOW_UNCOMMITTED = "1";

const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-scale-"));
let server;
try {
  console.log(`Creating OpenWiki scale fixture with ${RECORDS} pages (${STAGE} ${MODE} stage)...`);
  await createScaleWorkspace(root, RECORDS);
  console.log("Building search and derived index stores...");
  const searchIndex = await buildSearchIndex(root);
  const derivedIndex = await rebuildIndexStore(root);
  server = await startHttpApi({ root, port: 0, defaultPolicy: { role: "admin" } });

  const report = {
    generated_at: new Date().toISOString(),
    mode: MODE,
    stage: STAGE,
    records: RECORDS,
    iterations: ITERATIONS,
    limits: LIMITS,
    enforced: ENFORCE_BUDGETS,
    profile_targets: PROFILE_TARGETS,
    indexes: {
      search_records: searchIndex.recordCount,
      derived_records: derivedIndex.recordCount,
      derived_edges: derivedIndex.edgeCount,
    },
    checks: [],
  };

  report.checks.push(await measureEndpoint("records", server.url, recordsPath, ITERATIONS, LIMITS.recordsP95Ms));
  report.checks.push(await measureEndpoint("search", server.url, searchPath, ITERATIONS, LIMITS.searchP95Ms));
  report.checks.push(await measureEndpoint("page", server.url, pagePath, ITERATIONS, LIMITS.pageP95Ms));
  report.checks.push(await measureEndpoint("graph-neighbors", server.url, graphPath, ITERATIONS, LIMITS.graphP95Ms));

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  await writeFile(LEGACY_REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  if (ENFORCE_BUDGETS) {
    assert.equal(report.checks.every((check) => check.pass), true, JSON.stringify(report.checks, null, 2));
  } else if (!report.checks.every((check) => check.pass)) {
    console.warn("OpenWiki scale benchmark exceeded a non-blocking budget:");
    console.warn(JSON.stringify(report.checks.filter((check) => !check.pass), null, 2));
  }
  console.log(`OpenWiki scale performance report written to ${REPORT_PATH}`);
} finally {
  await closeServer(server?.server);
  await rm(root, { recursive: true, force: true });
}

async function createScaleWorkspace(root, pageCount) {
  await createWorkspace(root, { template: "basic", title: "OpenWiki Scale Fixture" });
  const conceptsDir = path.join(root, "wiki", "concepts");
  await mkdir(conceptsDir, { recursive: true });
  const now = "2026-05-27T00:00:00.000Z";
  const batchSize = 250;
  for (let start = 0; start < pageCount; start += batchSize) {
    const writes = [];
    const end = Math.min(start + batchSize, pageCount);
    for (let index = start; index < end; index += 1) {
      const ordinal = String(index + 1).padStart(6, "0");
      const department = `department-${String(index % 50).padStart(2, "0")}`;
      const domain = `domain-${String(index % 200).padStart(3, "0")}`;
      const id = `page:concept:scale-${ordinal}`;
      const title = `Scale Knowledge ${ordinal}`;
      const body = [
        "---",
        `id: ${id}`,
        "type: concept",
        `title: ${title}`,
        `summary: Synthetic ${department} ${domain} page for OpenWiki scale fixtures.`,
        "status: published",
        "topics:",
        `  - ${department}`,
        `  - ${domain}`,
        "source_ids:",
        "  - source:2026-05-21-001",
        "claim_ids: []",
        `created_at: ${now}`,
        `updated_at: ${now}`,
        "---",
        "",
        `# ${title}`,
        "",
        `This scale knowledge page belongs to ${department} and ${domain}.`,
        "It exercises OpenWiki search, sidebar navigation, page rendering, and graph neighbors without changing the agent protocol.",
        "",
        `Related synthetic records mention scale-fixture-${ordinal} and shared scale knowledge terms.`,
        "",
      ].join("\n");
      writes.push(writeFile(path.join(conceptsDir, `scale-${ordinal}.md`), body));
    }
    await Promise.all(writes);
  }
}

async function measureEndpoint(name, baseUrl, pathForIteration, iterations, limitMs) {
  const durations = [];
  for (let index = 0; index < iterations; index += 1) {
    const target = baseUrl + pathForIteration(index);
    const started = performance.now();
    const response = await fetch(target);
    const text = await response.text();
    const duration = performance.now() - started;
    assert.equal(response.status, 200, `${name} returned ${response.status}: ${text.slice(0, 200)}`);
    assert.ok(text.length > 0, `${name} returned an empty response`);
    durations.push(duration);
  }
  durations.sort((left, right) => left - right);
  const p95 = percentile(durations, 0.95);
  return {
    name,
    pass: p95 <= limitMs,
    p50_ms: round(percentile(durations, 0.5)),
    p95_ms: round(p95),
    max_ms: round(durations[durations.length - 1] ?? 0),
    limit_ms: limitMs,
  };
}

function recordsPath(index) {
  const cursor = index === 0 ? "" : `&cursor=${encodeURIComponent(`offset:${index * 40}`)}`;
  return `/api/v1/records?type=page&group_by=page_type&limit=40${cursor}`;
}

function searchPath(index) {
  const department = `department-${String(index % 50).padStart(2, "0")}`;
  return `/api/v1/search?q=${encodeURIComponent(`scale knowledge ${department}`)}&type=page&limit=10`;
}

function pagePath(index) {
  const ordinal = String((index % RECORDS) + 1).padStart(6, "0");
  return `/pages/${encodeURIComponent(`page:concept:scale-${ordinal}`)}`;
}

function graphPath(index) {
  const ordinal = String((index % RECORDS) + 1).padStart(6, "0");
  return `/api/v1/graph/${encodeURIComponent(`page:concept:scale-${ordinal}`)}/neighbors?limit=32`;
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const index = Math.ceil(values.length * quantile) - 1;
  return values[Math.min(Math.max(index, 0), values.length - 1)] ?? 0;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

async function closeServer(instance) {
  if (!instance) return;
  await new Promise((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve())));
}
