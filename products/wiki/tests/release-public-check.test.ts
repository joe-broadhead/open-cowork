import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("public release reachability helper records required announcement URLs", async () => {
  const outPath = path.join("artifacts", "openwiki-public-release-check-test.json");
  const result = await execFileAsync(process.execPath, [
    "--no-warnings",
    "scripts/openwiki-public-release-check.mjs",
    "--dry-run",
    "--out",
    outPath,
  ], {
    cwd: process.cwd(),
  });
  assert.match(result.stdout, /openwiki-public-release-check-test\.json/);
  const report = JSON.parse(await readFile(outPath, "utf8")) as {
    schema_version?: string;
    dry_run?: boolean;
    checks?: Array<{ name?: string; category?: string; url?: string; ok?: boolean; status?: string }>;
  };
  assert.equal(report.schema_version, "openwiki-public-release-check-v1");
  assert.equal(report.dry_run, true);
  const checks = report.checks ?? [];
  const names = new Set(checks.map((check) => check.name));
  for (const required of [
    "repo-home",
    "repo-issues",
    "repo-security-policy",
    "repo-release-tag",
    "release-source-tarball",
    "docs-site",
    "docs-distribution",
    "docs-mcp-agents",
    "docs-security",
    "raw-readme-md",
    "raw-changelog-md",
    "raw-security-md",
    "raw-support-md",
    "schema-id-openwiki",
    "schema-ref-openwiki",
  ]) {
    assert.ok(names.has(required), `missing public release target ${required}`);
  }
  assert.ok(checks.every((check) => check.status === "not_checked" && check.ok === true));
  assert.ok(checks.some((check) => check.url === "https://raw.githubusercontent.com/joe-broadhead/open-wiki/v0.0.0/schemas/openwiki/v0/openwiki.schema.json"));
  assert.equal(checks.some((check) => check.category?.startsWith("schema") && /\/master\/schemas\/openwiki\//.test(check.url ?? "")), false);
});

test("public release reachability helper can defer unpublished release URLs", async () => {
  const outPath = path.join("artifacts", "openwiki-public-release-check-unpublished-test.json");
  await execFileAsync(process.execPath, [
    "--no-warnings",
    "scripts/openwiki-public-release-check.mjs",
    "--allow-unpublished",
    "--repo-url",
    "https://github.com/example/private-openwiki",
    "--docs-url",
    "https://example.invalid/openwiki/",
    "--out",
    outPath,
  ], {
    cwd: process.cwd(),
  });
  const report = JSON.parse(await readFile(outPath, "utf8")) as {
    allow_unpublished?: boolean;
    checks?: Array<{ ok?: boolean; status?: string }>;
  };
  assert.equal(report.allow_unpublished, true);
  assert.ok((report.checks ?? []).length > 0);
  assert.ok((report.checks ?? []).every((check) => check.ok === true && check.status === "deferred_unpublished"));
});
