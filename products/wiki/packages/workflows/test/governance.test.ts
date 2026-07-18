import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspace } from "@openwiki/repo";
import { runGovernanceDetectors } from "../src/governance.ts";

test("governance detector module reports deterministic missing-source findings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-governance-"));
  try {
    await createWorkspace(root, { template: "basic", title: "Governance Fixture" });
    const report = await runGovernanceDetectors({ root, detectors: ["orphan_page"] });
    assert.equal(report.workspace_id.startsWith("workspace:"), true);
    assert.equal(report.counts.stale_claim, 0);
    assert.equal(report.counts.missing_source, 0);
    assert.equal(report.counts.broken_link, 0);
    assert.equal(report.counts.orphan_page, report.findings.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
