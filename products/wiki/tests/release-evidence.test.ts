import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("release evidence treats public reachability as a recommended artifact", async () => {
  const releaseEvidence = await readFile("scripts/openwiki-release-evidence.mjs", "utf8");
  assert.match(releaseEvidence, /name === "openwiki-public-release-check\.json"/);
  assert.match(releaseEvidence, /dry_run: booleanField\(record, "dry_run"\)/);
  assert.match(releaseEvidence, /failed: numberField\(record, "failed"\)/);
  const references = releaseEvidence.match(/openwiki-public-release-check\.json/g) ?? [];
  assert.ok(references.length >= 2);
});
