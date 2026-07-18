import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("enterprise demo eval proves corpus, MCP, UI, static export, and backup surfaces", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--no-warnings",
      "--import",
      "tsx",
      path.join(process.cwd(), "scripts", "openwiki-enterprise-demo-eval.mjs"),
      "--json",
    ],
    { maxBuffer: 2 * 1024 * 1024 },
  );
  const report = JSON.parse(stdout) as {
    status: string;
    checks: string[];
    generated: {
      page_ids: string[];
      proposal_ids: string[];
      decision_ids: string[];
      run_ids: string[];
      artifacts: { static_out_dir?: string; backup_dir?: string };
    };
  };

  assert.equal(report.status, "pass");
  for (const expected of [
    "corpus shape",
    "governance fixtures",
    "search and read permission filtering",
    "MCP read and proposal agent workflows",
    "server UI smoke",
    "static export private filtering",
    "backup and restore smoke",
  ]) {
    assert.ok(report.checks.includes(expected), `missing enterprise demo check: ${expected}`);
  }
  assert.ok(report.generated.page_ids.length >= 9);
  assert.ok(report.generated.proposal_ids.length >= 3);
  assert.ok(report.generated.decision_ids.length >= 1);
  assert.ok(report.generated.run_ids.length >= 1);
  assert.equal(typeof report.generated.artifacts.static_out_dir, "string");
  assert.equal(typeof report.generated.artifacts.backup_dir, "string");
});
