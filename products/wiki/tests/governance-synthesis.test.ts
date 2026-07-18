import { createWorkspace, listEvents, loadRepository, readPage } from "@openwiki/repo";
import { searchWiki } from "@openwiki/search";
import {
  applyProposal,
  createSynthesis,
  proposeSynthesis,
  reviewProposal
} from "@openwiki/workflows";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("creates new synthesis pages through proposals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-synthesis-"));
  try {
    await createWorkspace(root, "Synthesis Wiki");
    const repo = await loadRepository(root);
    const sourceId = repo.sources[0]?.id;
    assert.ok(sourceId);

    const result = await proposeSynthesis({
      root,
      title: "Agent Memory Synthesis",
      pageType: "concept",
      summary: "Synthesis of agent memory governance patterns.",
      topics: ["agents", "memory"],
      sourceIds: [sourceId],
      actorId: "actor:agent:wiki-researcher",
      rationale: "Create a sourced synthesis page for review.",
      body: "# Agent Memory Synthesis\n\nAgent memory synthesis pages should connect cited evidence to durable wiki decisions.",
    });

    assert.equal(result.validation.status, "passed");
    assert.equal(result.page.id, "page:concept:agent-memory-synthesis");
    assert.equal(result.proposal.target_path, "wiki/concepts/agent-memory-synthesis.md");
    assert.ok(result.proposal.snapshot_path);

    const snapshot = await readFile(path.join(root, result.proposal.snapshot_path ?? ""), "utf8");
    assert.match(snapshot, /Agent Memory Synthesis/);
    assert.match(result.diff, /--- a\/wiki\/concepts\/agent-memory-synthesis.md/);

    const review = await reviewProposal({
      root,
      proposalId: result.proposal.id,
      decision: "accepted",
      actorId: "actor:user:reviewer",
      rationale: "The synthesis is sourced and scoped.",
    });
    assert.equal(review.proposal.status, "accepted");

    const apply = await applyProposal({
      root,
      proposalId: result.proposal.id,
      actorId: "actor:user:maintainer",
    });
    assert.equal(apply.proposal.status, "applied");
    assert.deepEqual(apply.applied_paths, ["wiki/concepts/agent-memory-synthesis.md"]);

    const page = await readPage(root, "page:concept:agent-memory-synthesis");
    assert.equal(page.title, "Agent Memory Synthesis");
    assert.match(page.body, /durable wiki decisions/);

    const search = await searchWiki(root, { query: "durable wiki decisions", types: ["page"], limit: 5 });
    assert.equal(search.results[0]?.id, "page:concept:agent-memory-synthesis");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creates synthesis pages through the trusted governed workflow", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-create-synthesis-"));
  try {
    await createWorkspace(root, "Create Synthesis Wiki");
    await initTestGit(root);
    const repo = await loadRepository(root);
    const sourceId = repo.sources[0]?.id;
    assert.ok(sourceId);

    const result = await createSynthesis({
      root,
      title: "Trusted Agent Memory Brief",
      pageType: "concept",
      summary: "Trusted synthesis created through proposal, decision, and apply records.",
      topics: ["agents", "memory"],
      sourceIds: [sourceId],
      actorId: "actor:agent:trusted-synthesizer",
      rationale: "Create a trusted synthesis while preserving governance records.",
      decisionRationale: "Trusted workflow is allowed to apply this synthesis.",
      body: "# Trusted Agent Memory Brief\n\nTrusted synthesis still keeps proposals, decisions, and applied page history inspectable.",
      commit: true,
      message: "Create trusted synthesis",
    });

    assert.ok(result.commit);
    assert.equal(result.proposal.status, "applied");
    const appliedCommitSha = await git(root, ["rev-parse", result.commit]);
    assert.equal(result.proposal.applied_commit, appliedCommitSha);
    const committedFiles = await git(root, ["show", "--name-only", "--format=", result.commit]);
    assert.match(committedFiles, /wiki\/concepts\/trusted-agent-memory-brief\.md/);
    assert.match(committedFiles, /proposals\/proposal_/);
    assert.match(committedFiles, /decisions\/decision_/);
    assert.equal(result.decision.decision, "accepted");
    assert.equal(result.page.id, "page:concept:trusted-agent-memory-brief");
    assert.deepEqual(result.applied_paths, ["wiki/concepts/trusted-agent-memory-brief.md"]);
    assert.equal(result.repository_validation.status, "passed");
    assert.equal(await git(root, ["status", "--short"]), "");

    const page = await readPage(root, "page:concept:trusted-agent-memory-brief");
    assert.match(page.body, /proposals, decisions, and applied page history/);
    const createdEvents = await listEvents(root, 20);
    const synthesisEvent = createdEvents.events.find((event) => event.type === "synthesis.created" && event.operation === "wiki.create_synthesis");
    assert.equal(synthesisEvent?.data?.commit, result.commit);
    assert.equal(synthesisEvent?.data?.applied_commit, appliedCommitSha);

    const search = await searchWiki(root, { query: "trusted synthesis inspectable", types: ["page"], limit: 5 });
    assert.equal(search.results[0]?.id, "page:concept:trusted-agent-memory-brief");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function initTestGit(root: string): Promise<void> {
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "OpenWiki Test"]);
  await git(root, ["config", "user.email", "openwiki@example.com"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "Initial wiki"]);
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args]);
  return stdout.trim();
}
