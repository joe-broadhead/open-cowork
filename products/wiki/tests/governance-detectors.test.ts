import { routeHttpRequest } from "@openwiki/http-api";
import { handleMcpRequest } from "@openwiki/mcp-server";
import { createWorkspace } from "@openwiki/repo";
import {
  runGovernanceDetectors
} from "@openwiki/workflows";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("governance detectors find stale claims, missing sources, broken links, and orphan pages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-governance-detectors-"));
  try {
    await createWorkspace(root, "Governance Detector Wiki");
    await writeFile(
      path.join(root, "wiki", "concepts", "maintenance-risk.md"),
      [
        "---",
        "id: page:concept:maintenance-risk",
        "type: concept",
        "title: Maintenance Risk",
        "summary: Page intentionally shaped for governance detector coverage.",
        "status: draft",
        "topics:",
        "  - governance",
        "source_ids: []",
        "claim_ids:",
        "  - claim:governance:stale",
        "created_at: 2026-05-26T00:00:00.000Z",
        "updated_at: 2026-05-26T00:00:00.000Z",
        "---",
        "",
        "# Maintenance Risk",
        "",
        "This page links to [a missing page](missing-page.md) and has intentionally weak evidence.",
        "",
      ].join("\n"),
    );
    const claimIndexPath = path.join(root, "claims", "claim-index.jsonl");
    const existingClaims = await readFile(claimIndexPath, "utf8");
    await writeFile(
      claimIndexPath,
      existingClaims +
        JSON.stringify({
          id: "claim:governance:stale",
          uri: "openwiki://claim/governance/stale",
          type: "claim",
          text: "Maintenance risk claim needs fresh evidence.",
          page_id: "page:concept:maintenance-risk",
          source_ids: [],
          confidence: "medium",
          risk: "medium",
          status: "stale",
          last_verified_at: "2025-01-01T00:00:00.000Z",
        }) +
        "\n",
    );

    const report = await runGovernanceDetectors({ root, staleAfterDays: 30 });
    assert.equal(report.status, "attention");
    assert.ok(report.counts.stale_claim >= 1);
    assert.ok(report.counts.missing_source >= 2);
    assert.ok(report.counts.broken_link >= 1);
    assert.ok(report.counts.orphan_page >= 1);
    assert.ok(report.findings.some((finding) => finding.detector === "stale_claim" && finding.record_id === "claim:governance:stale"));
    assert.ok(report.findings.some((finding) => finding.detector === "missing_source" && finding.record_id === "page:concept:maintenance-risk"));
    assert.ok(report.findings.some((finding) => finding.detector === "missing_source" && finding.record_id === "claim:governance:stale"));
    assert.ok(report.findings.some((finding) => finding.detector === "broken_link" && finding.target === "missing-page.md"));
    assert.ok(report.findings.some((finding) => finding.detector === "orphan_page" && finding.record_id === "page:concept:maintenance-risk"));

    const http = await routeHttpRequest(root, "GET", "/api/v1/governance/detectors?stale_after_days=30");
    assert.equal(http.status, 200);
    assert.ok(
      (http.body as { findings: Array<{ detector: string; record_id: string }> }).findings.some(
        (finding) => finding.detector === "broken_link" && finding.record_id === "page:concept:maintenance-risk",
      ),
    );

    const mcp = await handleMcpRequest(root, {
      jsonrpc: "2.0",
      id: "governance-detectors",
      method: "tools/call",
      params: {
        name: "wiki.detect_governance",
        arguments: { detectors: ["stale_claim", "missing_source", "broken_link", "orphan_page"], stale_after_days: 30 },
      },
    });
    assert.ok(
      (mcp as { structuredContent: { findings: Array<{ detector: string; record_id: string }> } }).structuredContent.findings.some(
        (finding) => finding.detector === "missing_source" && finding.record_id === "claim:governance:stale",
      ),
    );

    const { stdout } = await execFileAsync(process.execPath, [
      "--no-warnings",
      "--import",
      "tsx",
      path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
      "--root",
      root,
      "governance",
      "detectors",
      "--stale-after-days",
      "30",
      "--json",
    ]);
    const cli = JSON.parse(stdout) as { findings: Array<{ detector: string; target?: string }> };
    assert.ok(cli.findings.some((finding) => finding.detector === "broken_link" && finding.target === "missing-page.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
