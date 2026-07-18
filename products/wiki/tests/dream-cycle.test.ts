import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import { idToUri, type PageRecord } from "@openwiki/core";
import { routeHttpRequest } from "@openwiki/http-api";
import { runLocalJob } from "@openwiki/jobs";
import { handleMcpRequest } from "@openwiki/mcp-server";
import { scopesForRole } from "@openwiki/policy";
import { createWorkspace, listEvents, listRuns, loadRepository, renderPageMarkdown } from "@openwiki/repo";
import { dreamRunReportForRun } from "@openwiki/workflows";

const ROOT = process.cwd();
const execFileAsync = promisify(execFile);

test("dream cycle records durable runs, phase events, reports, and CLI status", async () => {
  const root = await dreamWorkspace("openwiki-dream-run-");
  try {
    const result = await runLocalJob({
      root,
      runType: "dream.run",
      actorId: "actor:agent:dream",
      input: {
        phases: ["index_refresh", "stale_claims", "orphan_pages", "missing_backlinks", "link_suggestions", "report"],
        limit: 10,
        dry_run: true,
      },
    });
    assert.equal(result.run.status, "succeeded");
    assert.equal(result.run.run_type, "dream.run");
    const output = result.run.output as {
      schema_version: string;
      dry_run: boolean;
      phases: Array<{ phase: string; status: string; items: unknown[] }>;
      report: { status: string; item_count: number; proposal_count: number };
    };
    assert.equal(output.schema_version, "openwiki-dream-run-v1");
    assert.equal(output.dry_run, true);
    assert.equal(output.report.proposal_count, 0);
    assert.ok(output.phases.some((phase) => phase.phase === "index_refresh" && phase.status === "succeeded"));
    assert.ok(output.phases.some((phase) => phase.phase === "link_suggestions" && phase.items.length > 0));

    const runs = await listRuns(root, 10);
    assert.ok(runs.runs.some((run) => run.id === result.run.id));
    const events = await listEvents(root, 100);
    assert.ok(events.events.some((event) => event.type === "dream.started" && event.record_id === result.run.id));
    assert.ok(events.events.some((event) => event.type === "dream.phase.succeeded" && event.operation === "wiki.dream_run"));
    assert.ok(!JSON.stringify(result.run).includes("Project Beta for launch."), "dream output must not persist private body snippets");

    const status = await execFileAsync(
      process.execPath,
      ["--no-warnings", "--import", "tsx", path.join(ROOT, "packages", "cli", "src", "main.ts"), "--root", root, "dream", "status", "--json"],
      { cwd: ROOT },
    );
    const statusBody = JSON.parse(status.stdout) as { runs: Array<{ id: string; run_type: string }> };
    assert.equal(statusBody.runs[0]?.id, result.run.id);
    assert.equal(statusBody.runs[0]?.run_type, "dream.run");

    const report = await execFileAsync(
      process.execPath,
      ["--no-warnings", "--import", "tsx", path.join(ROOT, "packages", "cli", "src", "main.ts"), "--root", root, "dream", "report", result.run.id, "--json"],
      { cwd: ROOT },
    );
    const reportBody = JSON.parse(report.stdout) as { run: { id: string }; report: { status: string } };
    assert.equal(reportBody.run.id, result.run.id);
    assert.equal(typeof reportBody.report.status, "string");
    await assert.rejects(dreamRunReportForRun(root, "run:missing"), /Dream run not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dream link suggestions create review proposals only when explicitly requested", async () => {
  const root = await dreamWorkspace("openwiki-dream-proposals-");
  try {
    const result = await runLocalJob({
      root,
      runType: "dream.run",
      actorId: "actor:agent:dream",
      input: {
        phases: ["link_suggestions", "report"],
        limit: 10,
        create_proposals: true,
      },
    });
    assert.equal(result.run.status, "succeeded");
    const output = result.run.output as { proposal_ids: string[]; report: { proposal_count: number } };
    assert.ok(output.proposal_ids.length > 0);
    assert.equal(output.report.proposal_count, output.proposal_ids.length);

    const repo = await loadRepository(root);
    const proposal = repo.proposals.find(
      (candidate) => output.proposal_ids.includes(candidate.id) && candidate.target_ids.includes("page:concept:alpha"),
    );
    assert.ok(proposal);
    assert.match(proposal.title, /^Dream link suggestions for /);
    assert.match(proposal.rationale ?? "", new RegExp(result.run.id));
    assert.match(proposal.rationale ?? "", /Idempotency key:/);
    assert.equal(proposal.status, "open");
    assert.ok(proposal.validation_report_path);
    const validation = JSON.parse(await readFile(path.join(root, proposal.validation_report_path), "utf8")) as { status: string };
    assert.equal(validation.status, "passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dream provider phases extract fact and take candidates", async () => {
  const root = await dreamWorkspace("openwiki-dream-provider-candidates-");
  try {
    const result = await runLocalJob({
      root,
      runType: "dream.run",
      actorId: "actor:agent:dream",
      input: {
        phases: ["fact_candidates", "take_score_candidates", "report"],
        provider: "fixture",
        dry_run: true,
      },
    });
    assert.equal(result.run.status, "succeeded");
    const output = result.run.output as {
      provider_enabled: boolean;
      phases: Array<{ phase: string; status: string; items: Array<{ record_type: string; title?: string }>; proposal_ids: string[] }>;
      report: { skipped_phase_count: number; proposal_count: number };
    };
    assert.equal(output.provider_enabled, true);
    assert.equal(output.report.skipped_phase_count, 0);
    assert.equal(output.report.proposal_count, 0);
    const factPhase = output.phases.find((phase) => phase.phase === "fact_candidates");
    const takePhase = output.phases.find((phase) => phase.phase === "take_score_candidates");
    assert.equal(factPhase?.status, "succeeded");
    assert.equal(takePhase?.status, "succeeded");
    assert.ok(factPhase?.items.some((item) => item.record_type === "fact_candidate" && item.title !== undefined));
    assert.ok(takePhase?.items.some((item) => item.record_type === "take_candidate" && item.title !== undefined));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dream provider phases create fact and take review proposals only when requested", async () => {
  const root = await dreamWorkspace("openwiki-dream-provider-proposals-");
  try {
    const result = await runLocalJob({
      root,
      runType: "dream.run",
      actorId: "actor:agent:dream",
      input: {
        phases: ["fact_candidates", "take_score_candidates", "report"],
        provider: "fixture",
        create_proposals: true,
      },
    });
    assert.equal(result.run.status, "succeeded");
    const output = result.run.output as {
      proposal_ids: string[];
      phases: Array<{ phase: string; proposal_ids: string[] }>;
      report: { proposal_count: number };
    };
    assert.equal(output.report.proposal_count, 2);
    assert.equal(output.proposal_ids.length, 2);
    assert.ok(output.phases.find((phase) => phase.phase === "fact_candidates")?.proposal_ids.length);
    assert.ok(output.phases.find((phase) => phase.phase === "take_score_candidates")?.proposal_ids.length);

    const repo = await loadRepository(root);
    assert.equal(repo.facts.length, 0);
    assert.equal(repo.takes.length, 0);
    assert.equal(repo.proposals.filter((proposal) => output.proposal_ids.includes(proposal.id)).length, 2);
    assert.ok(repo.proposals.some((proposal) => proposal.target_ids.some((id) => id.startsWith("fact:dream:"))));
    assert.ok(repo.proposals.some((proposal) => proposal.target_ids.some((id) => id.startsWith("take:dream:"))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("low-scope remote actors cannot run proposal-producing dream phases", async () => {
  const root = await dreamWorkspace("openwiki-dream-policy-");
  try {
    const genericHttpDenied = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/runs",
      { run_type: "dream.run", input: { phases: ["link_suggestions"], create_proposals: true }, wait: true },
      { role: "admin" },
    );
    assert.equal(genericHttpDenied.status, 403);

    const queuedHttpDenied = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/dream/runs",
      { phases: ["link_suggestions"], dry_run: true },
      { role: "admin" },
    );
    assert.equal(queuedHttpDenied.status, 400);

    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: "generic-dream-run",
          method: "tools/call",
          params: {
            name: "wiki.run_job",
            arguments: { run_type: "dream.run", input: { phases: ["link_suggestions"], create_proposals: true }, wait: true },
          },
        },
        { toolMode: "write", role: "admin" },
      ),
      /dream\.run.*not available through MCP/,
    );

    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: "queued-dream-run",
          method: "tools/call",
          params: {
            name: "wiki.dream_run",
            arguments: { phases: ["link_suggestions"], dry_run: true },
          },
        },
        { toolMode: "proposal", role: "admin" },
      ),
      /requires wait=true/,
    );

    const httpDenied = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/dream/runs",
      { phases: ["link_suggestions"], create_proposals: true, wait: true },
      { scopes: scopesForRole("viewer") },
    );
    assert.equal(httpDenied.status, 403);

    await assert.rejects(
      handleMcpRequest(
        root,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "wiki.dream_run",
            arguments: { phases: ["link_suggestions"], create_proposals: true, wait: true },
          },
        },
        { toolMode: "proposal", role: "viewer" },
      ),
      /wiki\.dream_run|wiki:propose/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote dream runs filter private phase output and status records by policy", async () => {
  const root = await dreamWorkspace("openwiki-dream-visibility-");
  try {
    await writeDreamPolicy(root);
    await writePage(root, {
      id: "page:private:secret",
      uri: idToUri("page:private:secret"),
      type: "page",
      page_type: "concept",
      title: "Secret Dream",
      summary: "Private dream page",
      body_format: "markdown",
      body: "Secret Dream should not appear in contributor dream outputs.",
      path: "wiki/private/secret-dream.md",
      source_ids: [],
      claim_ids: [],
      status: "active",
      topics: ["secret"],
      created_at: "2026-06-13T00:00:00.000Z",
      updated_at: "2026-06-13T00:00:00.000Z",
    });
    await writePage(root, {
      id: "page:readonly:dream",
      uri: idToUri("page:readonly:dream"),
      type: "page",
      page_type: "concept",
      title: "Read Only Dream",
      summary: "Visible but not proposal-authorized",
      body_format: "markdown",
      body: "Read Only Dream mentions Alpha but should not receive dream proposals.",
      path: "wiki/readonly/dream.md",
      source_ids: [],
      claim_ids: [],
      status: "active",
      topics: ["readonly"],
      created_at: "2026-06-13T00:00:00.000Z",
      updated_at: "2026-06-13T00:00:00.000Z",
    });

    const broadRun = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/dream/runs",
      { phases: ["index_refresh", "report"], wait: true, dry_run: true },
      { role: "admin" },
    );
    assert.equal(broadRun.status, 201);
    const broadRunBody = broadRun.body as { run: { id: string; output?: { subject_paths?: string[] } } };
    assert.ok(broadRunBody.run.output?.subject_paths?.includes("wiki/private/secret-dream.md"));
    const broadRunForContributor = await routeHttpRequest(root, "GET", `/api/v1/dream/runs/${encodeURIComponent(broadRunBody.run.id)}`, undefined, { role: "contributor" });
    assert.equal(broadRunForContributor.status, 404);
    const contributorRunList = await routeHttpRequest(root, "GET", "/api/v1/dream/runs?limit=5", undefined, { role: "contributor" });
    assert.equal(contributorRunList.status, 200);
    assert.ok(!(contributorRunList.body as { runs: Array<{ id: string }> }).runs.some((run) => run.id === broadRunBody.run.id));

    const created = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/dream/runs",
      { phases: ["index_refresh", "thin_pages", "missing_backlinks", "link_suggestions", "report"], wait: true, dry_run: true },
      { role: "contributor" },
    );
    assert.equal(created.status, 201);
    assert.doesNotMatch(JSON.stringify(created.body), /Secret Dream|wiki\/private\/secret-dream/);
    const createdBody = created.body as { run: { output?: { phases?: Array<{ phase: string; counts: Record<string, number> }> } } };
    const indexPhase = createdBody.run.output?.phases?.find((phase) => phase.phase === "index_refresh");
    const repo = await loadRepository(root);
    const allRecordCount = repo.pages.length + repo.sources.length + repo.claims.length + repo.proposals.length;
    assert.ok((indexPhase?.counts.search_record_count ?? 0) < allRecordCount);

    const status = await routeHttpRequest(root, "GET", "/api/v1/dream/runs?limit=5", undefined, { role: "contributor" });
    assert.equal(status.status, 200);
    assert.doesNotMatch(JSON.stringify(status.body), /Secret Dream|wiki\/private\/secret-dream/);

    const mcpStatus = await handleMcpRequest(
      root,
      {
        jsonrpc: "2.0",
        id: "dream-status",
        method: "tools/call",
        params: { name: "wiki.dream_status", arguments: { limit: 5 } },
      },
      { toolMode: "read", role: "contributor" },
    );
    assert.doesNotMatch(JSON.stringify(mcpStatus), /Secret Dream|wiki\/private\/secret-dream/);

    const proposed = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/dream/runs",
      { phases: ["link_suggestions", "report"], wait: true, create_proposals: true },
      { role: "contributor" },
    );
    assert.equal(proposed.status, 201);
    const proposedBody = proposed.body as { run: { output?: { phases?: Array<{ phase: string; items: Array<{ path?: string }> }> } } };
    const proposedText = JSON.stringify(proposed.body);
    assert.doesNotMatch(proposedText, /Read Only Dream/);
    assert.doesNotMatch(proposedText, /Secret Dream|wiki\/private\/secret-dream/);
    const proposedLinkPhase = proposedBody.run.output?.phases?.find((phase) => phase.phase === "link_suggestions");
    assert.ok(!proposedLinkPhase?.items.some((item) => item.path === "wiki/readonly/dream.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function dreamWorkspace(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  await createWorkspace(root, "Dream Wiki");
  await writePage(root, {
    id: "page:concept:alpha",
    uri: idToUri("page:concept:alpha"),
    type: "page",
    page_type: "concept",
    title: "Alpha",
    summary: "Alpha page",
    body_format: "markdown",
    body: "Alpha depends on Project Beta for launch.",
    path: "wiki/concepts/alpha.md",
    source_ids: [],
    claim_ids: [],
    status: "active",
    topics: ["alpha"],
    created_at: "2026-06-13T00:00:00.000Z",
    updated_at: "2026-06-13T00:00:00.000Z",
  });
  await writePage(root, {
    id: "page:concept:project-beta",
    uri: idToUri("page:concept:project-beta"),
    type: "page",
    page_type: "concept",
    title: "Project Beta",
    summary: "Beta page",
    body_format: "markdown",
    body: "Project Beta is a launch dependency with no incoming canonical wiki link.",
    path: "wiki/concepts/project-beta.md",
    source_ids: [],
    claim_ids: [],
    status: "active",
    topics: ["beta"],
    created_at: "2026-06-13T00:00:00.000Z",
    updated_at: "2026-06-13T00:00:00.000Z",
  });
  return root;
}

async function writeDreamPolicy(root: string): Promise<void> {
  await writeFile(
    path.join(root, "policy", "sections.json"),
    JSON.stringify(
      [
        { id: "section:public", title: "Public", paths: ["wiki/concepts/**"], visibility: "public" },
        { id: "section:readonly", title: "Read Only", paths: ["wiki/readonly/**"], visibility: "public" },
        { id: "section:private", title: "Private", paths: ["wiki/private/**"], visibility: "private" },
      ],
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(root, "policy", "grants.json"),
    JSON.stringify(
      [
        { principal: "group:all-users", section: "section:public", role: "contributor" },
        { principal: "group:all-users", section: "section:readonly", role: "viewer" },
        { principal: "group:private-team", section: "section:private", role: "maintainer" },
      ],
      null,
      2,
    ) + "\n",
  );
}

async function writePage(root: string, page: PageRecord): Promise<void> {
  await mkdir(path.dirname(path.join(root, page.path)), { recursive: true });
  await writeFile(path.join(root, page.path), renderPageMarkdown(page), "utf8");
}
