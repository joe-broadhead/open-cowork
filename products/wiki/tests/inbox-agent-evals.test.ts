import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("inbox agent orchestration eval emits deterministic release-gate evidence", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--no-warnings", "--import", "tsx", "scripts/openwiki-inbox-agent-evals.mjs", "--json"],
    {
      cwd: process.cwd(),
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 8,
    },
  );
  const report = JSON.parse(stdout) as {
    schema_version: string;
    deterministic: boolean;
    provider_model: string;
    failure_taxonomy: string[];
    summary: { total: number; passed: number; failed: number };
    checks: Array<{ id: string; status: string; evidence?: Record<string, unknown> }>;
  };
  assert.equal(report.schema_version, "openwiki.inbox_agent_evals.v1");
  assert.equal(report.deterministic, true);
  assert.equal(report.provider_model, "not_used_deterministic");
  assert.ok(report.failure_taxonomy.includes("provider_failure"));
  assert.ok(report.failure_taxonomy.includes("model_refusal"));
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.passed, report.summary.total);
  for (const required of [
    "local-transcript-inbox-source-proposals",
    "remote-http-mcp-proposal-inbox-flow",
    "permission-filtering-two-users-shared-space",
    "duplicate-transcript-handling",
    "prompt-injection-transcript-handling",
    "sync-after-processing-local-remote",
  ]) {
    assert.equal(report.checks.find((check) => check.id === required)?.status, "passed", `missing passing check ${required}`);
  }
});
