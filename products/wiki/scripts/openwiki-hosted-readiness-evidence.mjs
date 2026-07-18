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
import { createRun, runNextQueuedJob } from "@openwiki/jobs";
import { MCP_PROTOCOL_VERSION } from "@openwiki/mcp-server";
import {
  closePostgresSqlPools,
  migratePostgresRuntime,
  rebuildPostgresRuntimeIndex,
} from "@openwiki/postgres-runtime";
import { createWorkspace } from "@openwiki/repo";
import { OpenWikiWriteInProgressError, createServiceAccountToken, withWriteCoordination } from "@openwiki/workflows";

const execFile = promisify(execFileCallback);
const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ARTIFACTS_DIR = path.join(REPO_ROOT, "artifacts");
const options = parseArgs(process.argv.slice(2));
const outputPath = path.resolve(options.out ?? path.join(ARTIFACTS_DIR, "openwiki-hosted-readiness-evidence.json"));
const sourceGit = await sourceGitMetadata();

if (options.dryRun) {
  await writeReport(
    outputPath,
    baseReport("not_checked", undefined, {
      root: options.root,
      checks: dryRunChecks(),
      observations: observations(),
    }),
    options.json,
  );
  process.exit(0);
}

const database = databaseUrlFromEnv();
if (database === undefined) {
  throw new Error("Set OPENWIKI_DATABASE_URL or DATABASE_URL to run hosted readiness evidence");
}

const envSnapshot = snapshotEnv(hostedEnvKeys());
const root = options.root === undefined
  ? await fs.mkdtemp(path.join(os.tmpdir(), "openwiki-hosted-readiness-"))
  : path.resolve(options.root);
let serverA;
let serverB;
const keepRoot = options.keepRoot || options.root !== undefined;

try {
  await createHostedWorkspace(root);
  const readToken = await createServiceAccountToken({
    root,
    profile: "hosted-readonly-agent",
    id: "service:hosted-readiness-reader",
    actorId: "actor:agent:hosted-readiness-reader",
    auditActorId: "actor:release:hosted-readiness",
    description: "Temporary hosted readiness reader.",
    tokenDescription: "Temporary hosted readiness reader token.",
  });
  const rateToken = await createServiceAccountToken({
    root,
    profile: "hosted-readonly-agent",
    id: "service:hosted-readiness-rate",
    actorId: "actor:agent:hosted-readiness-rate",
    auditActorId: "actor:release:hosted-readiness",
    description: "Temporary hosted readiness rate-limit probe.",
    tokenDescription: "Temporary hosted readiness rate-limit token.",
  });
  await gitCommitAll(root, "Create hosted readiness fixture");
  applyHostedEnv(database.value);

  const checks = [];
  checks.push(await timedCheck("postgres_migrate", async () => {
    const result = await migratePostgresRuntime({ databaseUrl: database.value });
    return {
      applied: result.applied.length,
      skipped: result.skipped.length,
      database_url_env: result.database_url_env,
    };
  }));
  checks.push(await timedCheck("postgres_full_sync", async () => rebuildPostgresRuntimeIndex(root, { databaseUrl: database.value })));

  serverA = await startHttpApi({ root, port: 0 });
  serverB = await startHttpApi({ root, port: 0 });
  checks.push(await httpCheck("readyz", serverA.url, "/readyz", readToken.token.value));
  checks.push(await httpJsonCheck("index_postgres", serverA.url, "/api/v1/index", readToken.token.value, (json) => json?.serving_layer === "postgres-runtime"));
  checks.push(await httpJsonCheck("search_postgres", serverA.url, "/api/v1/search?q=hosted%20readiness&type=page&limit=5", readToken.token.value, (json) => Array.isArray(json?.results) && json.results.length > 0));
  checks.push(await httpCheck("page_render", serverA.url, `/pages/${encodeURIComponent("page:concept:hosted-readiness")}`, readToken.token.value));
  checks.push(await httpJsonCheck("graph_neighbors", serverA.url, `/api/v1/graph/${encodeURIComponent("page:concept:hosted-readiness")}/neighbors?limit=10`, readToken.token.value, (json) => Array.isArray(json?.nodes)));
  checks.push(await mcpSessionCheck(serverA.url, serverB.url, readToken.token.value));
  checks.push(await postgresQueueWorkerCheck(root));
  checks.push(await writeCoordinatorContentionCheck(root));
  checks.push(await sharedRateLimitCheck(serverA.url, serverB.url, rateToken.token.value));

  const passed = checks.every((check) => check.pass);
  await writeReport(
    outputPath,
    baseReport(passed ? "passed" : "failed", database.envName, {
      root: keepRoot ? root : undefined,
      web_replicas: 2,
      checks,
      observations: observations(),
    }),
    options.json,
  );
  if (!passed && options.enforce) {
    process.exitCode = 1;
  }
} finally {
  await serverA?.close({ timeoutMs: 1000 });
  await serverB?.close({ timeoutMs: 1000 });
  await closePostgresSqlPools();
  restoreEnv(envSnapshot);
  if (!keepRoot) {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function baseReport(status, databaseUrlEnv, extra) {
  return {
    schema_version: "openwiki-hosted-readiness-evidence-v1",
    generated_at: new Date().toISOString(),
    status,
    dry_run: options.dryRun,
    git: sourceGit,
    database_url_env: databaseUrlEnv,
    provider: envValue("OPENWIKI_HOSTED_EVIDENCE_PROVIDER"),
    region: envValue("OPENWIKI_HOSTED_EVIDENCE_REGION"),
    runtime_env: {
      OPENWIKI_RUNTIME_MODE: "hosted",
      OPENWIKI_READ_BACKEND: "postgres",
      OPENWIKI_SEARCH_BACKEND: "postgres",
      OPENWIKI_QUEUE_BACKEND: "postgres",
      OPENWIKI_WRITE_COORDINATOR_BACKEND: "postgres",
      OPENWIKI_OPERATIONAL_STATE_BACKEND: "postgres",
      OPENWIKI_REQUIRE_AUTH: "1",
      OPENWIKI_RATE_LIMIT_ENABLED: "1",
    },
    ...extra,
  };
}

function dryRunChecks() {
  return [
    "postgres_migrate",
    "postgres_full_sync",
    "readyz",
    "index_postgres",
    "search_postgres",
    "page_render",
    "graph_neighbors",
    "mcp_session_shared_across_replicas",
    "postgres_queue_worker",
    "postgres_write_coordination_contention",
    "postgres_rate_limit_shared_across_replicas",
  ].map((name) => ({ name, pass: false, status: "not_checked" }));
}

async function createHostedWorkspace(root) {
  await createWorkspace(root, { template: "basic", title: `OpenWiki Hosted Readiness ${Date.now()}` });
  await fs.mkdir(path.join(root, "wiki", "concepts"), { recursive: true });
  await fs.writeFile(
    path.join(root, "wiki", "concepts", "hosted-readiness.md"),
    [
      "---",
      "id: page:concept:hosted-readiness",
      "type: concept",
      "title: Hosted Readiness",
      "summary: Hosted readiness evidence page.",
      "status: published",
      "topics:",
      "  - hosted-readiness",
      "source_ids:",
      "  - source:2026-05-21-001",
      "claim_ids: []",
      "created_at: 2026-06-25T00:00:00.000Z",
      "updated_at: 2026-06-25T00:00:00.000Z",
      "---",
      "",
      "# Hosted Readiness",
      "",
      "This page proves hosted readiness search, page rendering, graph, and MCP paths.",
      "",
    ].join("\n"),
  );
}

async function postgresQueueWorkerCheck(root) {
  return timedCheck("postgres_queue_worker", async () => {
    const queued = await createRun({ root, runType: "lint", actorId: "actor:user:hosted-readiness" });
    const result = await runNextQueuedJob({ root, workerId: "actor:agent:hosted-readiness-worker" });
    return {
      queued_run_id: queued.id,
      processed_run_id: result.run?.id,
      status: result.run?.status,
      pass: result.run?.id === queued.id && result.run.status === "succeeded",
    };
  }, (result) => result.pass === true);
}

async function writeCoordinatorContentionCheck(root) {
  let releaseLease;
  let leaseReady;
  const releaseLeasePromise = new Promise((resolve) => {
    releaseLease = resolve;
  });
  const leaseReadyPromise = new Promise((resolve) => {
    leaseReady = resolve;
  });
  const holder = withWriteCoordination(
    {
      root,
      operation: "evidence.hosted_write_a",
      actorId: "actor:user:hosted-writer-a",
      backend: "postgres",
      leaseMs: 5000,
      heartbeatMs: 500,
    },
    async () => {
      leaseReady();
      await releaseLeasePromise;
    },
  );
  await leaseReadyPromise;
  try {
    return await timedCheck("postgres_write_coordination_contention", async () => {
      let rejected = false;
      try {
        await withWriteCoordination(
          {
            root,
            operation: "evidence.hosted_write_b",
            actorId: "actor:user:hosted-writer-b",
            backend: "postgres",
            leaseMs: 5000,
            heartbeatMs: 500,
          },
          async () => ({ unexpected: true }),
        );
      } catch (error) {
        rejected = error instanceof OpenWikiWriteInProgressError;
      }
      return { rejected };
    }, (result) => result.rejected === true);
  } finally {
    releaseLease();
    await holder;
  }
}

async function sharedRateLimitCheck(serverAUrl, serverBUrl, token) {
  const previousSearchLimit = process.env.OPENWIKI_RATE_LIMIT_SEARCH;
  const previousWindow = process.env.OPENWIKI_RATE_LIMIT_WINDOW_MS;
  try {
    process.env.OPENWIKI_RATE_LIMIT_SEARCH = "1";
    process.env.OPENWIKI_RATE_LIMIT_WINDOW_MS = "60000";
    return await timedCheck("postgres_rate_limit_shared_across_replicas", async () => {
      const first = await fetch(`${serverAUrl}/api/v1/search?q=shared-rate-limit&type=page&limit=1`, { headers: authHeaders(token) });
      await first.text();
      const second = await fetch(`${serverBUrl}/api/v1/search?q=shared-rate-limit&type=page&limit=1`, { headers: authHeaders(token) });
      await second.text();
      return { first_status: first.status, second_status: second.status };
    }, (result) => result.first_status === 200 && result.second_status === 429);
  } finally {
    restoreEnvValue("OPENWIKI_RATE_LIMIT_SEARCH", previousSearchLimit);
    restoreEnvValue("OPENWIKI_RATE_LIMIT_WINDOW_MS", previousWindow);
  }
}

async function mcpSessionCheck(serverAUrl, serverBUrl, token) {
  return timedCheck("mcp_session_shared_across_replicas", async () => {
    const initialize = await fetch(`${serverAUrl}/mcp?tools=read`, {
      method: "POST",
      headers: {
        ...authHeaders(token),
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "hosted-init", method: "initialize" }),
    });
    const initBody = await initialize.text();
    const sessionId = initialize.headers.get("mcp-session-id");
    if (initialize.status !== 200 || sessionId === null) {
      return { initialize_status: initialize.status, stream_status: 0, session_id: sessionId, body: initBody.slice(0, 200) };
    }
    const stream = await fetch(`${serverBUrl}/mcp?once=true`, {
      headers: {
        ...authHeaders(token),
        accept: "text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        "mcp-session-id": sessionId,
      },
    });
    const streamBody = await stream.text();
    return {
      initialize_status: initialize.status,
      stream_status: stream.status,
      session_id: sessionId,
      stream_ok: streamBody.includes("openwiki mcp stream"),
    };
  }, (result) => result.initialize_status === 200 && result.stream_status === 200 && result.stream_ok === true);
}

async function httpCheck(name, baseUrl, route, token) {
  return timedCheck(name, async () => {
    const response = await fetch(`${baseUrl}${route}`, { headers: authHeaders(token) });
    const text = await response.text();
    return { status: response.status, bytes: text.length };
  }, (result) => result.status === 200 && result.bytes > 0);
}

async function httpJsonCheck(name, baseUrl, route, token, validate) {
  return timedCheck(name, async () => {
    const response = await fetch(`${baseUrl}${route}`, { headers: authHeaders(token) });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, bytes: text.length, valid: response.status === 200 && validate(json) };
  }, (result) => result.valid === true);
}

async function timedCheck(name, callback, validate = () => true) {
  const started = performance.now();
  try {
    const result = await callback();
    const pass = validate(result);
    return { name, pass, status: pass ? "passed" : "failed", elapsed_ms: round(performance.now() - started), result };
  } catch (error) {
    return {
      name,
      pass: false,
      status: "failed",
      elapsed_ms: round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

async function gitCommitAll(root, message) {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "openwiki-hosted-evidence@example.invalid"]);
  await git(root, ["config", "user.name", "OpenWiki Hosted Evidence"]);
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

function applyHostedEnv(databaseUrl) {
  process.env.OPENWIKI_DATABASE_URL = databaseUrl;
  process.env.OPENWIKI_RUNTIME_MODE = "hosted";
  process.env.OPENWIKI_READ_BACKEND = "postgres";
  process.env.OPENWIKI_SEARCH_BACKEND = "postgres";
  process.env.OPENWIKI_QUEUE_BACKEND = "postgres";
  process.env.OPENWIKI_WRITE_COORDINATOR_BACKEND = "postgres";
  process.env.OPENWIKI_OPERATIONAL_STATE_BACKEND = "postgres";
  process.env.OPENWIKI_REQUIRE_AUTH = "1";
  process.env.OPENWIKI_RATE_LIMIT_ENABLED = "1";
  process.env.OPENWIKI_RATE_LIMIT_REQUESTS = "1000";
  process.env.OPENWIKI_RATE_LIMIT_SEARCH = "1000";
  process.env.OPENWIKI_RATE_LIMIT_MCP = "1000";
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
    "OPENWIKI_RATE_LIMIT_REQUESTS",
    "OPENWIKI_RATE_LIMIT_SEARCH",
    "OPENWIKI_RATE_LIMIT_MCP",
    "OPENWIKI_RATE_LIMIT_WINDOW_MS",
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
    out: undefined,
    root: undefined,
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

function requiredValue(args, index, name) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: pnpm evidence:hosted-readiness [options]

Generates hosted readiness evidence. Set OPENWIKI_DATABASE_URL or DATABASE_URL
in the environment for live mode; do not pass database URLs on the command line.

Options:
  --out PATH       JSON report path.
  --root PATH      Reuse or create a workspace root; implies --keep-root.
  --keep-root      Keep the generated temporary workspace.
  --enforce        Exit non-zero when measured checks fail.
  --dry-run        Write the evidence inventory without database access.
  --json           Print the JSON report.
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
    restoreEnvValue(key, value);
  }
}

function restoreEnvValue(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function envValue(key) {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function observations() {
  const memory = process.memoryUsage();
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    cpus: os.cpus().length,
    loadavg: os.loadavg(),
    memory,
    total_memory_bytes: os.totalmem(),
    free_memory_bytes: os.freemem(),
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}
