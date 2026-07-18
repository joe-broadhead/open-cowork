import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("cloud apply evidence runner dry-runs every Terraform provider without credentials", async () => {
  for (const provider of ["aws", "gcp"]) {
    const result = await execFileAsync(process.execPath, [
      "--no-warnings",
      "--import",
      "tsx",
      "scripts/openwiki-cloud-apply-evidence.mjs",
      "--provider",
      provider,
      "--dry-run",
      "--json",
      "--out",
      `artifacts/openwiki-cloud-apply-evidence-${provider}-test.json`,
    ], {
      cwd: process.cwd(),
    });
    const report = JSON.parse(result.stdout) as {
      schema_version?: string;
      dry_run?: boolean;
      status?: string;
      provider?: string;
      issue?: string;
      git?: { branch?: string; commit?: string; dirty_files?: string[] };
      expected_runtime_env?: Record<string, string>;
      token_env_present?: boolean;
      checks?: Array<{ name?: string; pass?: boolean; status?: string }>;
    };
    assert.equal(report.schema_version, "openwiki-cloud-apply-evidence-v1");
    assert.equal(report.dry_run, true);
    assert.equal(report.status, "not_checked");
    assert.equal(report.provider, provider);
    assert.match(report.issue ?? "", /^#19[5-6]$/);
    assert.equal(report.git?.branch, await currentBranch());
    assert.match(report.git?.commit ?? "", /^[0-9a-f]{40}$/);
    assert.ok(Array.isArray(report.git?.dirty_files));
    assert.equal(report.expected_runtime_env?.OPENWIKI_RUNTIME_MODE, "hosted");
    assert.equal(report.expected_runtime_env?.OPENWIKI_READ_BACKEND, "postgres");
    assert.equal(report.expected_runtime_env?.OPENWIKI_SEARCH_BACKEND, "postgres");
    assert.equal(report.expected_runtime_env?.OPENWIKI_QUEUE_BACKEND, "postgres");
    assert.equal(report.expected_runtime_env?.OPENWIKI_OPERATIONAL_STATE_BACKEND, "postgres");
    assert.equal(report.token_env_present, false);
    const checkNames = new Set((report.checks ?? []).map((check) => check.name));
    for (const expected of ["provider_auth", "terraform_fmt", "terraform_init", "terraform_validate", "terraform_plan", "terraform_apply", "livez", "readyz", "openapi", "mcp-http-read-token", "terraform_destroy"]) {
      assert.ok(checkNames.has(expected), `missing ${provider} evidence check ${expected}`);
    }
    assert.ok((report.checks ?? []).every((check) => check.status === "not_checked"));
    assert.ok((report.checks ?? []).every((check) => check.pass === false));
  }
});

async function currentBranch(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
    cwd: process.cwd(),
  });
  return stdout.trim();
}

test("cloud apply evidence docs describe live evidence and dry-run limits", async () => {
  const docs = await readFile("deploy/terraform/README.md", "utf8");
  const packageJson = await readFile("package.json", "utf8");
  const releaseEvidence = await readFile("scripts/openwiki-release-evidence.mjs", "utf8");
  assert.match(docs, /pnpm deploy:cloud:evidence -- --provider aws --dry-run/);
  assert.match(docs, /OPENWIKI_CLOUD_EVIDENCE_PUBLIC_ORIGIN/);
  assert.match(docs, /OPENWIKI_CLOUD_EVIDENCE_MCP_TOKEN/);
  assert.match(docs, /pass: false/);
  assert.match(packageJson, /deploy:cloud:evidence/);
  assert.match(releaseEvidence, /openwiki-cloud-apply-evidence-aws\.json/);
  assert.match(releaseEvidence, /openwiki-cloud-apply-evidence-gcp\.json/);
});
