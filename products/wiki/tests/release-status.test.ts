import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("release status helper emits a go/no-go artifact without publishing", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { scripts?: Record<string, string> };
  assert.equal(packageJson.scripts?.["release:status"], "node --no-warnings scripts/openwiki-release-status.mjs");

  const outPath = path.join("artifacts", "openwiki-release-status-test.json");
  const status = await execFileAsync(process.execPath, ["--no-warnings", "scripts/openwiki-release-status.mjs", "--out", outPath], {
    cwd: process.cwd(),
  });
  assert.match(status.stdout, /openwiki-release-status-test\.json/);
  const statusJson = JSON.parse(await readFile(outPath, "utf8")) as {
    schema_version?: string;
    package?: { expected_tag?: string };
    summary?: { checks?: number };
    checks?: Array<{ name?: string; status?: string }>;
    next_actions?: Array<{ check?: string }>;
  };
  assert.equal(statusJson.schema_version, "openwiki-release-status-v1");
  assert.equal(statusJson.package?.expected_tag, "v0.0.0");
  assert.ok((statusJson.summary?.checks ?? 0) >= 8);
  const checkNames = new Set((statusJson.checks ?? []).map((check) => check.name));
  for (const required of [
    "clean_git",
    "release_tag",
    "release_evidence",
    "npm_tarball",
    "public_reachability",
    "cloud_aws",
    "cloud_gcp",
    "hosted_postgres_scale",
  ]) {
    assert.ok(checkNames.has(required), `missing release status check ${required}`);
  }
  const gcpCheck = statusJson.checks?.find((check) => check.name === "cloud_gcp");
  assert.equal(gcpCheck?.status, "deferred");
  assert.ok(!statusJson.next_actions?.some((action) => action.check === "cloud_gcp"));
  // The release tag either already exists in this checkout (post-tag working
  // trees; CI checkouts omit tags) and the check passes, or it is listed as a
  // next action. Both are valid go/no-go artifacts; asserting "always pending"
  // failed in any checkout that has fetched the release tag.
  const releaseTagCheck = statusJson.checks?.find((check) => check.name === "release_tag");
  const releaseTagPending = statusJson.next_actions?.some((action) => action.check === "release_tag") ?? false;
  assert.ok(
    releaseTagCheck?.status === "passed" || releaseTagPending,
    "release_tag must either pass or be surfaced as a next action",
  );
});
