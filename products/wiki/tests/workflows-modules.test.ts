import { promises as fs } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceBackup, restoreWorkspaceBackup } from "../packages/workflows/src/backup.ts";
import { createServiceAccountToken, listServiceAccountTokens, revokeServiceAccountToken, rotateServiceAccountToken } from "../packages/workflows/src/service-accounts.ts";
import { fetchAndIngestSource, ingestSource, proposeSource } from "../packages/workflows/src/sources.ts";
import { applyProposal } from "../packages/workflows/src/proposal-apply.ts";
import { closeProposal, commentOnProposal, reviewProposal } from "../packages/workflows/src/proposal-review.ts";
import { createSynthesis, proposeEdit, proposeSynthesis } from "../packages/workflows/src/proposals.ts";
import { runDreamCycle } from "../packages/workflows/src/dream-cycle.ts";

const WORKFLOW_SRC_DIR = path.join(process.cwd(), "packages", "workflows", "src");

test("workflow package is split into bounded domain modules", async () => {
  const entries = await fs.readdir(WORKFLOW_SRC_DIR);
  const sourceFiles = entries.filter((entry) => entry.endsWith(".ts"));
  const lineCounts = await Promise.all(
    sourceFiles.map(async (entry) => {
      const source = await fs.readFile(path.join(WORKFLOW_SRC_DIR, entry), "utf8");
      return { entry, lines: source.split("\n").length - 1 };
    }),
  );
  const index = lineCounts.find((item) => item.entry === "index.ts");
  assert.ok(index);
  assert.ok(index.lines < 500, `workflows/src/index.ts should stay below 500 LOC, got ${index.lines}`);
  const oversized = lineCounts.filter((item) => item.lines > 800);
  assert.deepEqual(oversized, []);
});

test("workflow public barrel delegates proposal, source, service-account, and backup flows", async () => {
  const index = await fs.readFile(path.join(WORKFLOW_SRC_DIR, "index.ts"), "utf8");
  for (const moduleName of [
    "backup",
    "backup-rehearsal",
    "dream-cycle",
    "proposal-apply",
    "proposal-review",
    "proposals",
    "service-accounts",
    "sources",
  ]) {
    assert.ok(index.includes(`from "./${moduleName}.ts"`), `index.ts should re-export ${moduleName}.ts`);
  }
});

test("workflow domain modules expose focused callable surfaces", () => {
  for (const workflow of [
    applyProposal,
    closeProposal,
    commentOnProposal,
    createServiceAccountToken,
    createSynthesis,
    createWorkspaceBackup,
    fetchAndIngestSource,
    ingestSource,
    listServiceAccountTokens,
    proposeEdit,
    proposeSource,
    proposeSynthesis,
    restoreWorkspaceBackup,
    reviewProposal,
    revokeServiceAccountToken,
    rotateServiceAccountToken,
    runDreamCycle,
  ]) {
    assert.equal(typeof workflow, "function");
  }
});
