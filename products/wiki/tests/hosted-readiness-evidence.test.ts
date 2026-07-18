import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();

test("hosted readiness evidence dry-run records the full hosted runtime contract", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "openwiki-hosted-readiness-dry-run-"));
  const out = path.join(temp, "hosted-readiness.json");
  try {
    const { stdout } = await execFileAsync(
      "node",
      ["--no-warnings", "--import", "tsx", "scripts/openwiki-hosted-readiness-evidence.mjs", "--dry-run", "--out", out, "--json"],
      { cwd: ROOT, maxBuffer: 1024 * 1024 * 4 },
    );
    const printed = JSON.parse(stdout) as HostedReadinessReport;
    const written = JSON.parse(await readFile(out, "utf8")) as HostedReadinessReport;
    assert.equal(printed.schema_version, "openwiki-hosted-readiness-evidence-v1");
    assert.equal(written.schema_version, "openwiki-hosted-readiness-evidence-v1");
    assert.equal(written.status, "not_checked");
    assert.equal(written.dry_run, true);
    assert.deepEqual(written.runtime_env, {
      OPENWIKI_RUNTIME_MODE: "hosted",
      OPENWIKI_READ_BACKEND: "postgres",
      OPENWIKI_SEARCH_BACKEND: "postgres",
      OPENWIKI_QUEUE_BACKEND: "postgres",
      OPENWIKI_WRITE_COORDINATOR_BACKEND: "postgres",
      OPENWIKI_OPERATIONAL_STATE_BACKEND: "postgres",
      OPENWIKI_REQUIRE_AUTH: "1",
      OPENWIKI_RATE_LIMIT_ENABLED: "1",
    });
    assert.deepEqual(
      written.checks.map((check) => check.name),
      [
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
      ],
    );
    assert.equal(written.checks.every((check) => check.status === "not_checked" && check.pass === false), true);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

interface HostedReadinessReport {
  schema_version: string;
  status: string;
  dry_run: boolean;
  runtime_env: Record<string, string>;
  checks: Array<{ name: string; pass: boolean; status: string }>;
}
