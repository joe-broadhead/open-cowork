import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("hosted scale docs pin the Postgres serving, write, and operational-state assumptions", async () => {
  const operationsDocs = await readFile("docs/deployment/operations.md", "utf8");
  const monitoringDocs = await readFile("docs/deployment/operations/monitoring.md", "utf8");
  const allOperationsDocs = [operationsDocs, monitoringDocs].join("\n");
  for (const variable of [
    "OPENWIKI_READ_BACKEND",
    "OPENWIKI_SEARCH_BACKEND",
    "OPENWIKI_QUEUE_BACKEND",
    "OPENWIKI_WRITE_COORDINATOR_BACKEND",
    "OPENWIKI_OPERATIONAL_STATE_BACKEND",
    "OPENWIKI_RUNTIME_MODE",
  ]) {
    assert.match(operationsDocs, new RegExp("`" + variable + "`"));
  }
  assert.match(operationsDocs, /hosted` or `enterprise/);
  assert.match(operationsDocs, /read\/search\/queue stores/);
  assert.match(operationsDocs, /multi-container deployments, use Postgres for the queue/);
  assert.match(allOperationsDocs, /Streamable HTTP MCP sessions/);
  assert.match(monitoringDocs, /rate-limit windows by workspace/);
  assert.match(monitoringDocs, /Prometheus metrics stay process-local/);
});

test("10k benchmark artifacts are tracked but non-blocking for v0.1", async () => {
  const performanceDocs = await readFile("docs/deployment/performance.md", "utf8");
  const scaleScript = await readFile("scripts/openwiki-scale-perf.mjs", "utf8");
  const releaseEvidence = await readFile("scripts/openwiki-release-evidence.mjs", "utf8");

  assert.match(performanceDocs, /v0\.1 local\/team/);
  assert.match(performanceDocs, /Blocking smoke gate/);
  assert.match(performanceDocs, /v0\.2 team\/hosted/);
  assert.match(performanceDocs, /Non-blocking benchmark evidence/);
  assert.match(performanceDocs, /three consecutive scheduled main-branch benchmark/);
  assert.match(performanceDocs, /OPENWIKI_SCALE_ENFORCE=1/);
  assert.match(performanceDocs, /OPENWIKI_RUNTIME_MODE=hosted/);
  assert.match(performanceDocs, /disables request-path\s+SQLite index rebuilds and full-repo search fallbacks/);
  assert.match(performanceDocs, /hosted` and `enterprise` runtime modes/);
  assert.match(scaleScript, /"10k": 10_000/);
  assert.match(scaleScript, /MODE === "smoke"/);
  assert.match(releaseEvidence, /openwiki-scale-perf-benchmark-10k\.json/);
});

test("hosted Postgres scale evidence runner dry-runs without database credentials", async () => {
  const result = await execFileAsync(process.execPath, [
    "--no-warnings",
    "--import",
    "tsx",
    "scripts/openwiki-postgres-scale-evidence.mjs",
    "--dry-run",
    "--json",
    "--out",
    "artifacts/openwiki-postgres-scale-evidence-test.json",
  ], {
    cwd: process.cwd(),
  });
  const report = JSON.parse(result.stdout) as {
    schema_version?: string;
    dry_run?: boolean;
    status?: string;
    database_url_env?: string;
    git?: { branch?: string; commit?: string; dirty_files?: string[] };
    runtime_env?: Record<string, string>;
    checks?: Array<{ name?: string; pass?: boolean; status?: string }>;
  };
  assert.equal(report.schema_version, "openwiki-postgres-scale-evidence-v1");
  assert.equal(report.dry_run, true);
  assert.equal(report.status, "not_checked");
  assert.equal(report.database_url_env, undefined);
  assert.equal(report.git?.branch, await currentBranch());
  assert.match(report.git?.commit ?? "", /^[0-9a-f]{40}$/);
  assert.ok(Array.isArray(report.git?.dirty_files));
  assert.equal(report.runtime_env?.OPENWIKI_RUNTIME_MODE, "hosted");
  assert.equal(report.runtime_env?.OPENWIKI_READ_BACKEND, "postgres");
  assert.equal(report.runtime_env?.OPENWIKI_SEARCH_BACKEND, "postgres");
  assert.equal(report.runtime_env?.OPENWIKI_QUEUE_BACKEND, "postgres");
  assert.equal(report.runtime_env?.OPENWIKI_WRITE_COORDINATOR_BACKEND, "postgres");
  assert.equal(report.runtime_env?.OPENWIKI_OPERATIONAL_STATE_BACKEND, "postgres");
  const checkNames = new Set((report.checks ?? []).map((check) => check.name));
  for (const expected of ["postgres_full_sync", "postgres_incremental_sync", "readyz", "search", "page", "graph-neighbors", "mcp-http-read-token"]) {
    assert.ok(checkNames.has(expected), `missing hosted Postgres evidence check ${expected}`);
  }
  assert.ok((report.checks ?? []).every((check) => check.status === "not_checked"));
  assert.ok((report.checks ?? []).every((check) => check.pass === false));
});

async function currentBranch(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
    cwd: process.cwd(),
  });
  return stdout.trim();
}
