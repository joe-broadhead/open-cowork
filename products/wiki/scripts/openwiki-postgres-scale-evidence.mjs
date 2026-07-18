#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openWikiGitArgs, openWikiGitEnv } from "@openwiki/core";
import { startHttpApi } from "@openwiki/http-api";
import { MCP_PROTOCOL_VERSION } from "@openwiki/mcp-server";
import {
  closePostgresSqlPools,
  rebuildPostgresRuntimeIndex,
  syncPostgresRuntimeIndex,
} from "@openwiki/postgres-runtime";
import { createWorkspace } from "@openwiki/repo";
import { createServiceAccountToken } from "@openwiki/workflows";

const execFile = promisify(execFileCallback);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ARTIFACTS_DIR = path.join(REPO_ROOT, "artifacts");
const STAGE_RECORDS = {
  "10k": 10_000,
  "100k": 100_000,
};
const DEFAULT_BUDGETS = {
  "10k": {
    fullSyncMs: 5 * 60 * 1000,
    incrementalSyncMs: 10 * 1000,
    readyP95Ms: 1000,
    searchP95Ms: 1500,
    pageP95Ms: 2500,
    graphP95Ms: 750,
    mcpP95Ms: 2000,
  },
  "100k": {
    fullSyncMs: 15 * 60 * 1000,
    incrementalSyncMs: 30 * 1000,
    readyP95Ms: 1500,
    searchP95Ms: 2500,
    pageP95Ms: 3500,
    graphP95Ms: 1500,
    mcpP95Ms: 3000,
  },
};

const options = parseArgs(process.argv.slice(2));
const stage = options.stage ?? "10k";
const records = boundedInteger(options.records, STAGE_RECORDS[stage] ?? STAGE_RECORDS["10k"], 100, 1_000_000);
const iterations = boundedInteger(options.iterations, stage === "100k" ? 12 : 8, 3, 100);
const outputPath = path.resolve(options.out ?? path.join(ARTIFACTS_DIR, "openwiki-postgres-scale-evidence.json"));
const sourceGit = await sourceGitMetadata();

if (options.dryRun) {
  const report = baseReport("not_checked", undefined, {
    root: options.root,
    records,
    iterations,
    checks: dryRunChecks(),
  });
  await writeReport(outputPath, report, options.json);
  process.exit(0);
}

const database = databaseUrlFromEnv();
if (database === undefined) {
  throw new Error("Set OPENWIKI_DATABASE_URL or DATABASE_URL to run hosted Postgres scale evidence");
}

const envSnapshot = snapshotEnv(hostedEnvKeys());
const root = options.root === undefined
  ? await fs.mkdtemp(path.join(os.tmpdir(), "openwiki-postgres-scale-"))
  : path.resolve(options.root);
let server;
let keepRoot = options.keepRoot || options.root !== undefined;

try {
  applyHostedEnv(database.value);
  await createScaleWorkspace(root, records);
  const token = await createServiceAccountToken({
    root,
    profile: "hosted-readonly-agent",
    id: "service:postgres-scale-evidence",
    actorId: "actor:agent:postgres-scale-evidence",
    auditActorId: "actor:release:postgres-scale-evidence",
    description: "Temporary hosted Postgres scale evidence reader.",
    tokenDescription: "Temporary hosted Postgres scale evidence token.",
  });
  await gitCommitAll(root, "Create hosted Postgres scale fixture");

  const fullSync = await timed("postgres_full_sync", () => rebuildPostgresRuntimeIndex(root, { databaseUrl: database.value }));
  server = await startHttpApi({ root, port: 0 });
  const httpChecks = [];
  httpChecks.push(await measureHttp("readyz", server.url, "/readyz", iterations, budgets().readyP95Ms, token.token.value));
  httpChecks.push(await measureHttp("search", server.url, searchPath, iterations, budgets().searchP95Ms, token.token.value));
  httpChecks.push(await measureHttp("page", server.url, pagePath, iterations, budgets().pageP95Ms, token.token.value));
  httpChecks.push(await measureHttp("graph-neighbors", server.url, graphPath, iterations, budgets().graphP95Ms, token.token.value));
  httpChecks.push(await measureMcp(server.url, iterations, budgets().mcpP95Ms, token.token.value));

  await appendFixtureEdit(root);
  await gitCommitAll(root, "Update hosted Postgres scale fixture page");
  const incrementalSync = await timed("postgres_incremental_sync", () => syncPostgresRuntimeIndex(root, { databaseUrl: database.value }));

  const checks = [
    syncCheck(fullSync, budgets().fullSyncMs),
    syncCheck(incrementalSync, budgets().incrementalSyncMs),
    ...httpChecks,
  ];
  const report = baseReport(checks.every((check) => check.pass) ? "passed" : "failed", database.envName, {
    root: keepRoot ? root : undefined,
    records,
    iterations,
    checks,
    full_sync: fullSync.result,
    incremental_sync: incrementalSync.result,
    observations: observations(),
  });
  await writeReport(outputPath, report, options.json);
  if (!checks.every((check) => check.pass) && options.enforce) {
    process.exitCode = 1;
  }
} finally {
  await server?.close({ timeoutMs: 1000 });
  await closePostgresSqlPools();
  restoreEnv(envSnapshot);
  if (!keepRoot) {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function baseReport(status, databaseUrlEnv, extra) {
  return {
    schema_version: "openwiki-postgres-scale-evidence-v1",
    generated_at: new Date().toISOString(),
    status,
    dry_run: options.dryRun,
    git: sourceGit,
    stage,
    database_url_env: databaseUrlEnv,
    provider: envValue("OPENWIKI_POSTGRES_SCALE_PROVIDER"),
    region: envValue("OPENWIKI_POSTGRES_SCALE_REGION"),
    database_class: envValue("OPENWIKI_POSTGRES_SCALE_DATABASE_CLASS"),
    database_storage: envValue("OPENWIKI_POSTGRES_SCALE_DATABASE_STORAGE"),
    image_digest: envValue("OPENWIKI_IMAGE_DIGEST"),
    runtime_env: {
      OPENWIKI_RUNTIME_MODE: "hosted",
      OPENWIKI_READ_BACKEND: "postgres",
      OPENWIKI_SEARCH_BACKEND: "postgres",
      OPENWIKI_QUEUE_BACKEND: "postgres",
      OPENWIKI_WRITE_COORDINATOR_BACKEND: "postgres",
      OPENWIKI_OPERATIONAL_STATE_BACKEND: "postgres",
      OPENWIKI_REQUIRE_AUTH: "1",
    },
    budgets: budgets(),
    ...extra,
  };
}

function dryRunChecks() {
  return [
    "postgres_full_sync",
    "readyz",
    "search",
    "page",
    "graph-neighbors",
    "mcp-http-read-token",
    "postgres_incremental_sync",
  ].map((name) => ({ name, pass: false, status: "not_checked" }));
}

async function createScaleWorkspace(root, pageCount) {
  await createWorkspace(root, { template: "basic", title: `OpenWiki Hosted Postgres Scale ${Date.now()}` });
  const conceptsDir = path.join(root, "wiki", "concepts");
  await fs.mkdir(conceptsDir, { recursive: true });
  const now = "2026-05-27T00:00:00.000Z";
  for (let start = 0; start < pageCount; start += 250) {
    const writes = [];
    for (let index = start; index < Math.min(start + 250, pageCount); index += 1) {
      const ordinal = String(index + 1).padStart(6, "0");
      const department = `department-${String(index % 50).padStart(2, "0")}`;
      const domain = `domain-${String(index % 200).padStart(3, "0")}`;
      writes.push(fs.writeFile(
        path.join(conceptsDir, `scale-${ordinal}.md`),
        [
          "---",
          `id: page:concept:scale-${ordinal}`,
          "type: concept",
          `title: Hosted Scale Knowledge ${ordinal}`,
          `summary: Synthetic ${department} ${domain} hosted Postgres scale page.`,
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
          `# Hosted Scale Knowledge ${ordinal}`,
          "",
          `This hosted scale page belongs to ${department} and ${domain}.`,
          "It exercises OpenWiki Postgres read/search, graph, HTTP, and MCP paths.",
          "",
        ].join("\n"),
      ));
    }
    await Promise.all(writes);
  }
}

async function appendFixtureEdit(root) {
  await fs.appendFile(path.join(root, "wiki", "concepts", "scale-000001.md"), "\nIncremental hosted Postgres sync evidence edit.\n");
}

async function gitCommitAll(root, message) {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "openwiki-release-evidence@example.invalid"]);
  await git(root, ["config", "user.name", "OpenWiki Release Evidence"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", message]);
}
async function git(root, args) {
  await execFile("git", openWikiGitArgs(undefined, args), { cwd: root, env: openWikiGitEnv(), timeout: 60_000 });
}

async function sourceGitMetadata() {
  return {
    branch: await sourceCommand("git", ["branch", "--show-current"]),
    commit: await sourceCommand("git", ["rev-parse", "HEAD"]),
    dirty_files: (await sourceCommand("git", ["status", "--short"])).split("\n").filter(Boolean),
  };
}

async function sourceCommand(command, args) {
  try {
    const { stdout } = await execFile(command, args, { cwd: REPO_ROOT, timeout: 15_000 });
    return stdout.trim();
  } catch (error) {
    return error instanceof Error ? `unavailable: ${error.message}` : "unavailable";
  }
}

async function timed(name, callback) {
  const started = performance.now();
  const result = await callback();
  return { name, elapsed_ms: round(performance.now() - started), result };
}
function syncCheck(run, limitMs) {
  return {
    name: run.name,
    pass: run.elapsed_ms <= limitMs,
    elapsed_ms: run.elapsed_ms,
    limit_ms: limitMs,
    record_count: run.result.record_count,
    edge_count: run.result.edge_count,
    search_document_count: run.result.search_document_count,
    mode: run.result.mode,
    upserted_record_count: run.result.upserted_record_count,
  };
}
async function measureHttp(name, baseUrl, pathForIteration, count, limitMs, token) {
  return measure(name, count, limitMs, async (index) => {
    const pathValue = typeof pathForIteration === "function" ? pathForIteration(index) : pathForIteration;
    const response = await fetch(`${baseUrl}${pathValue}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const text = await response.text();
    if (response.status !== 200) {
      throw new Error(`${name} returned ${response.status}: ${text.slice(0, 200)}`);
    }
    if (text.length === 0) {
      throw new Error(`${name} returned an empty response`);
    }
  });
}
async function measureMcp(baseUrl, count, limitMs, token) {
  return measure("mcp-http-read-token", count, limitMs, async (index) => {
    const initialize = await fetch(`${baseUrl}/mcp?tools=read`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: `mcp-init-${index}`, method: "initialize" }),
    });
    const body = await initialize.text();
    if (initialize.status !== 200) {
      throw new Error(`MCP initialize returned ${initialize.status}: ${body.slice(0, 200)}`);
    }
    const sessionId = initialize.headers.get("mcp-session-id");
    if (!sessionId) {
      throw new Error("MCP initialize did not return MCP-Session-Id");
    }
    const stream = await fetch(`${baseUrl}/mcp?once=true`, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        "mcp-session-id": sessionId,
      },
    });
    const text = await stream.text();
    if (stream.status !== 200 || !text.includes("openwiki mcp stream")) {
      throw new Error(`MCP stream returned ${stream.status}: ${text.slice(0, 200)}`);
    }
  });
}
async function measure(name, count, limitMs, callback) {
  const durations = [];
  for (let index = 0; index < count; index += 1) {
    const started = performance.now();
    await callback(index);
    durations.push(performance.now() - started);
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
function searchPath(index) {
  const department = `department-${String(index % 50).padStart(2, "0")}`;
  return `/api/v1/search?q=${encodeURIComponent(`hosted scale ${department}`)}&type=page&limit=10`;
}
function pagePath(index) {
  const ordinal = String((index % records) + 1).padStart(6, "0");
  return `/pages/${encodeURIComponent(`page:concept:scale-${ordinal}`)}`;
}
function graphPath(index) {
  const ordinal = String((index % records) + 1).padStart(6, "0");
  return `/api/v1/graph/${encodeURIComponent(`page:concept:scale-${ordinal}`)}/neighbors?limit=32`;
}
function budgets() {
  return DEFAULT_BUDGETS[stage] ?? DEFAULT_BUDGETS["10k"];
}
function observations() {
  const memory = process.memoryUsage();
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpus: os.cpus().length,
    loadavg: os.loadavg(),
    memory: Object.fromEntries(Object.entries(memory).map(([key, value]) => [key, value])),
    total_memory_bytes: os.totalmem(),
    free_memory_bytes: os.freemem(),
  };
}
function applyHostedEnv(databaseUrl) {
  process.env.OPENWIKI_DATABASE_URL = databaseUrl;
  process.env.OPENWIKI_RUNTIME_MODE = "hosted";
  process.env.OPENWIKI_READ_BACKEND = "postgres";
  process.env.OPENWIKI_SEARCH_BACKEND = "postgres";
  process.env.OPENWIKI_QUEUE_BACKEND = "postgres";
  process.env.OPENWIKI_WRITE_COORDINATOR_BACKEND = "postgres";
  process.env.OPENWIKI_OPERATIONAL_STATE_BACKEND = "postgres";
  process.env.OPENWIKI_REQUIRE_AUTH = "1";
  process.env.OPENWIKI_RATE_LIMIT_ENABLED = "0";
}

function hostedEnvKeys() {
  return [
    "OPENWIKI_DATABASE_URL",
    "OPENWIKI_RUNTIME_MODE",
    "OPENWIKI_READ_BACKEND",
    "OPENWIKI_SEARCH_BACKEND",
    "OPENWIKI_QUEUE_BACKEND",
    "OPENWIKI_WRITE_COORDINATOR_BACKEND",
    "OPENWIKI_OPERATIONAL_STATE_BACKEND",
    "OPENWIKI_REQUIRE_AUTH",
    "OPENWIKI_RATE_LIMIT_ENABLED",
  ];
}

function databaseUrlFromEnv() {
  if (process.env.OPENWIKI_DATABASE_URL?.trim()) {
    return { envName: "OPENWIKI_DATABASE_URL", value: process.env.OPENWIKI_DATABASE_URL };
  }
  if (process.env.DATABASE_URL?.trim()) {
    return { envName: "DATABASE_URL", value: process.env.DATABASE_URL };
  }
  return undefined;
}

function parseArgs(args) {
  const parsed = {
    dryRun: false,
    enforce: false,
    json: false,
    keepRoot: false,
    iterations: undefined,
    out: undefined,
    records: undefined,
    root: undefined,
    stage: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--enforce") {
      parsed.enforce = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--keep-root") {
      parsed.keepRoot = true;
    } else if (arg === "--stage") {
      parsed.stage = stageValue(requiredValue(args, index, arg));
      index += 1;
    } else if (arg === "--records") {
      parsed.records = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--iterations") {
      parsed.iterations = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--out") {
      parsed.out = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--root") {
      parsed.root = requiredValue(args, index, arg);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return parsed;
}

function stageValue(value) {
  if (value !== "10k" && value !== "100k") {
    throw new Error("--stage must be 10k or 100k");
  }
  return value;
}

function requiredValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: pnpm perf:postgres:hosted [options]

Generates hosted Postgres scale evidence. Set OPENWIKI_DATABASE_URL or
DATABASE_URL in the environment; do not pass database URLs on the command line.

Options:
  --stage 10k|100k     Benchmark stage. Defaults to 10k.
  --records N          Override synthetic page count.
  --iterations N       HTTP/MCP iterations per probe.
  --out PATH           JSON report path.
  --root PATH          Reuse or create a workspace root; implies --keep-root.
  --keep-root          Keep the generated temporary workspace.
  --enforce            Exit non-zero when measured budgets fail.
  --dry-run            Write the evidence inventory without database access.
  --json               Print the JSON report.
`);
}

async function writeReport(outPath, report, printJson) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  if (printJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Wrote ${path.relative(REPO_ROOT, outPath)}`);
  }
}

function snapshotEnv(keys) {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of snapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function envValue(key) {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const index = Math.ceil(values.length * quantile) - 1;
  return values[Math.min(Math.max(index, 0), values.length - 1)] ?? 0;
}

function round(value) {
  return Math.round(value * 10) / 10;
}
