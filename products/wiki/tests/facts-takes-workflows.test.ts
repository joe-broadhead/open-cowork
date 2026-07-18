import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { routeHttpRequest } from "@openwiki/http-api";
import { OpenWikiPolicyDeniedError } from "@openwiki/core";
import { handleMcpRequest } from "@openwiki/mcp-server";
import { scopesForRole } from "@openwiki/policy";
import { createWorkspace, loadRepository, readProposalDetail } from "@openwiki/repo";
import { buildSearchIndex } from "@openwiki/search";
import {
  applyProposal,
  findTrajectory,
  listFacts,
  proposeFact,
  proposeTake,
  recallWiki,
  resolveTake,
  reviewProposal,
  takesScorecard,
} from "@openwiki/workflows";

const execFileAsync = promisify(execFile);

test("facts and takes are proposed, applied, recalled, and scored", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-facts-takes-"));
  try {
    await createWorkspace(root, "Facts And Takes Wiki");

    const factProposal = await proposeFact({
      root,
      text: "The personal wiki dogfood uses OpenClaw as a daily-life memory client.",
      kind: "dogfood",
      subjectIds: ["page:concept:agent-memory"],
      pageIds: ["page:concept:agent-memory"],
      confidence: "high",
      sensitivity: "internal",
      actorId: "actor:user:test",
      rationale: "Capture the dogfood setup as an explicit fact.",
    });
    assert.equal(factProposal.validation.status, "passed");
    await reviewProposal({
      root,
      proposalId: factProposal.proposal.id,
      decision: "accepted",
      actorId: "actor:user:reviewer",
      rationale: "Fact proposal is scoped to the facts ledger.",
    });
    await applyProposal({ root, proposalId: factProposal.proposal.id, actorId: "actor:user:maintainer" });

    const takeProposal = await proposeTake({
      root,
      statement: "Adding explicit facts and takes will improve personal-wiki dogfood recall.",
      rationale: "Structured memory can be retrieved without turning every observation into a page.",
      probability: 0.8,
      confidence: "medium",
      pageIds: ["page:concept:agent-memory"],
      actorId: "actor:user:test",
    });
    assert.equal(takeProposal.validation.status, "passed");
    await reviewProposal({
      root,
      proposalId: takeProposal.proposal.id,
      decision: "accepted",
      actorId: "actor:user:reviewer",
      rationale: "Take proposal is scoped to the takes ledger.",
    });
    await applyProposal({ root, proposalId: takeProposal.proposal.id, actorId: "actor:user:maintainer" });

    const resolveProposal = await resolveTake({
      root,
      id: takeProposal.take.id,
      resolution: "correct",
      actorId: "actor:user:test",
      rationale: "Dogfood recall improved during the test.",
    });
    assert.equal(resolveProposal.validation.status, "passed");
    await reviewProposal({
      root,
      proposalId: resolveProposal.proposal.id,
      decision: "accepted",
      actorId: "actor:user:reviewer",
      rationale: "Resolution proposal is scoped to the takes ledger.",
    });
    await applyProposal({ root, proposalId: resolveProposal.proposal.id, actorId: "actor:user:maintainer" });

    const repo = await loadRepository(root);
    assert.equal(repo.facts.length, 1);
    assert.equal(repo.takes.length, 1);
    assert.equal(repo.takes[0]?.resolution, "correct");
    assert.equal(repo.takes[0]?.score, 0.04);

    const facts = await listFacts({ root, kinds: ["dogfood"] });
    assert.equal(facts.total, 1);
    assert.equal(facts.facts[0]?.id, factProposal.fact.id);

    const recall = await recallWiki({ root, query: "OpenClaw daily-life memory", limit: 5 });
    assert.ok(recall.hot_memory.some((memory) => memory.id === factProposal.fact.id));

    const scorecard = await takesScorecard({ root });
    assert.equal(scorecard.scored, 1);
    assert.equal(scorecard.brier_score, 0.04);

    const trajectory = await findTrajectory({ root, id: "page:concept:agent-memory" });
    assert.ok(trajectory.items.some((item) => item.id === factProposal.fact.id));
    assert.ok(trajectory.items.some((item) => item.id === takeProposal.take.id));

    const httpFacts = await routeHttpRequest(root, "GET", "/api/v1/facts", undefined, { scopes: scopesForRole("viewer") });
    assert.equal(httpFacts.status, 200);
    assert.equal((httpFacts.body as { total: number }).total, 1);

    const mcpScorecard = await handleMcpRequest(
      root,
      { jsonrpc: "2.0", id: "takes-scorecard", method: "tools/call", params: { name: "wiki.takes_scorecard", arguments: {} } },
      { toolMode: "read" },
    );
    assert.equal((mcpScorecard as { structuredContent?: { scored?: number } }).structuredContent?.scored, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("independent same-base fact and take proposals rebase append-only ledgers on apply", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-facts-takes-rebase-"));
  try {
    await createWorkspace(root, "Facts Takes Rebase Wiki");
    await initGit(root);

    const firstFact = await proposeFact({
      root,
      id: "fact:test:first",
      text: "The first same-base fact survives ledger rebase.",
      kind: "dogfood",
      actorId: "actor:user:test",
    });
    const secondFact = await proposeFact({
      root,
      id: "fact:test:second",
      text: "The second same-base fact is appended without overwriting.",
      kind: "dogfood",
      actorId: "actor:user:test",
    });
    await accept(root, firstFact.proposal.id);
    await accept(root, secondFact.proposal.id);

    const firstFactApply = await applyProposal({ root, proposalId: firstFact.proposal.id, actorId: "actor:user:maintainer", commit: true });
    assert.equal(firstFactApply.rebase, undefined);
    const secondFactDetail = await readProposalDetail(root, secondFact.proposal.id);
    assert.equal(secondFactDetail.snapshot_status?.status, "stale");
    const secondFactApply = await applyProposal({ root, proposalId: secondFact.proposal.id, actorId: "actor:user:maintainer", commit: true });
    assert.equal(secondFactApply.rebase?.performed, true);
    assert.deepEqual(secondFactApply.rebase?.paths, ["facts/facts.jsonl"]);
    assert.deepEqual(secondFactApply.rebase?.appended_record_ids, ["fact:test:second"]);

    const firstTake = await proposeTake({
      root,
      id: "take:test:first",
      statement: "The first same-base take survives ledger rebase.",
      probability: 0.65,
      actorId: "actor:user:test",
    });
    const secondTake = await proposeTake({
      root,
      id: "take:test:second",
      statement: "The second same-base take is appended without overwriting.",
      probability: 0.75,
      actorId: "actor:user:test",
    });
    await accept(root, firstTake.proposal.id);
    await accept(root, secondTake.proposal.id);

    await applyProposal({ root, proposalId: firstTake.proposal.id, actorId: "actor:user:maintainer", commit: true });
    const secondTakeApply = await applyProposal({ root, proposalId: secondTake.proposal.id, actorId: "actor:user:maintainer", commit: true });
    assert.equal(secondTakeApply.rebase?.performed, true);
    assert.deepEqual(secondTakeApply.rebase?.paths, ["takes/takes.jsonl"]);
    assert.deepEqual(secondTakeApply.rebase?.appended_record_ids, ["take:test:second"]);

    const repo = await loadRepository(root);
    assert.deepEqual(repo.facts.map((fact) => fact.id).sort(), ["fact:test:first", "fact:test:second"]);
    assert.deepEqual(repo.takes.map((take) => take.id).sort(), ["take:test:first", "take:test:second"]);
    const rebaseEvent = repo.events.find((event) => event.type === "proposal.applied" && event.record_id === secondTake.proposal.id);
    assert.equal((rebaseEvent?.data as { rebase?: { strategy?: string } } | undefined)?.rebase?.strategy, "append_jsonl");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ask citations filter private source metadata from visible page evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-ask-citation-policy-"));
  try {
    await createWorkspace(root, "Ask Citation Policy Wiki");
    await writeJson(root, "policy/sections.json", [
      { id: "public", title: "Public", paths: ["wiki/public/**"], visibility: "public" },
      { id: "private-sources", title: "Private Sources", paths: ["sources/manifests/private/**"], visibility: "private", owner_principal: "group:private" },
    ]);
    await writeJson(root, "policy/grants.json", [{ principal: "group:all-users", section: "public", role: "viewer" }]);
    await writeJson(root, "policy/approval-rules.json", []);
    await writePage(root, {
      id: "page:public:citation-policy",
      path: "wiki/public/citation-policy.md",
      title: "Citation Policy",
      body: "Visible page body mentions citationalpha for the question.",
      pageType: "concept",
      sourceIds: ["source:private:meeting"],
    });
    await writeSource(root, {
      id: "source:private:meeting",
      path: "sources/manifests/private/meeting.yaml",
      title: "Secret Source Omega",
    });
    await buildSearchIndex(root);

    const ask = await routeHttpRequest(
      root,
      "POST",
      "/api/v1/ask",
      { question: "citationalpha", limit: 5 },
      { role: "viewer", scopes: scopesForRole("viewer") },
    );
    assert.equal(ask.status, 200);
    const payload = JSON.stringify(ask.body);
    assert.match(payload, /Citation Policy/);
    assert.doesNotMatch(payload, /Secret Source Omega/);
    assert.doesNotMatch(payload, /source:private:meeting/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fact proposals do not generate full-ledger diffs for partially visible actors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-fact-proposal-policy-"));
  try {
    await createWorkspace(root, "Fact Proposal Policy Wiki");
    await writeJson(root, "policy/sections.json", [
      { id: "public", title: "Public", paths: ["wiki/public/**", "facts/**"], visibility: "public" },
      { id: "private", title: "Private", paths: ["wiki/private/**"], visibility: "private", owner_principal: "group:private" },
    ]);
    await writeJson(root, "policy/grants.json", [{ principal: "group:all-users", section: "public", role: "viewer" }]);
    await writeJson(root, "policy/approval-rules.json", []);
    await writePage(root, {
      id: "page:public:note",
      path: "wiki/public/note.md",
      title: "Public Note",
      body: "Public fact target.",
      sourceIds: [],
    });
    await writePage(root, {
      id: "page:private:note",
      path: "wiki/private/note.md",
      title: "Private Note",
      body: "Private fact target.",
      sourceIds: [],
    });
    await writeFile(path.join(root, "facts", "facts.jsonl"), JSON.stringify({
      id: "fact:private:secret",
      uri: "openwiki://fact/private/secret",
      type: "fact",
      kind: "secret",
      text: "Hidden ledger fact SecretLedgerOmega",
      subject_ids: ["page:private:note"],
      page_ids: ["page:private:note"],
      source_ids: [],
      claim_ids: [],
      confidence: "high",
      sensitivity: "private",
      status: "active",
      created_at: "2026-06-14T00:00:00.000Z",
      updated_at: "2026-06-14T00:00:00.000Z",
      path: "facts/facts.jsonl",
    }) + "\n");

    await assert.rejects(
      proposeFact({
        root,
        text: "Visible actor tries to add a public fact.",
        kind: "public",
        pageIds: ["page:public:note"],
        actorId: "actor:user:viewer",
        policyContext: { role: "viewer", scopes: scopesForRole("viewer") },
      }),
      (error: unknown) => error instanceof OpenWikiPolicyDeniedError && /requires visibility to every existing fact record/.test(error.message),
    );

    await assert.rejects(
      proposeFact({
        root,
        text: "Bounded admin tries to add a public fact.",
        kind: "public",
        pageIds: ["page:public:note"],
        actorId: "actor:user:bounded-admin",
        policyContext: { role: "admin", scopes: ["wiki:admin"], bounds: { pathPrefixes: ["wiki/public"] } },
      }),
      (error: unknown) => error instanceof OpenWikiPolicyDeniedError && /requires visibility to every existing fact record/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeJson(root: string, relativePath: string, value: unknown): Promise<void> {
  const absolutePath = path.join(root, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, JSON.stringify(value, null, 2) + "\n");
}

async function initGit(root: string): Promise<void> {
  await execFileAsync("git", ["-C", root, "init", "--initial-branch", "master"]);
  await execFileAsync("git", ["-C", root, "config", "user.name", "OpenWiki Test"]);
  await execFileAsync("git", ["-C", root, "config", "user.email", "openwiki@example.com"]);
  await execFileAsync("git", ["-C", root, "add", "."]);
  await execFileAsync("git", ["-C", root, "commit", "-m", "Initial wiki"]);
}

async function accept(root: string, proposalId: string): Promise<void> {
  await reviewProposal({
    root,
    proposalId,
    decision: "accepted",
    actorId: "actor:user:reviewer",
    rationale: "Accepted for same-ledger rebase test.",
  });
}

async function writePage(
  root: string,
  input: { id: string; path: string; title: string; body: string; sourceIds: string[]; pageType?: string },
): Promise<void> {
  const absolutePath = path.join(root, input.path);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    [
      "---",
      `id: ${input.id}`,
      `type: ${input.pageType ?? "note"}`,
      `title: ${input.title}`,
      "status: draft",
      "topics: []",
      ...(input.sourceIds.length === 0 ? ["source_ids: []"] : ["source_ids:", ...input.sourceIds.map((sourceId) => `  - ${sourceId}`)]),
      "claim_ids: []",
      "created_at: 2026-06-14T00:00:00.000Z",
      "updated_at: 2026-06-14T00:00:00.000Z",
      "---",
      "",
      `# ${input.title}`,
      "",
      input.body,
      "",
    ].join("\n"),
  );
}

async function writeSource(root: string, input: { id: string; path: string; title: string }): Promise<void> {
  const absolutePath = path.join(root, input.path);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    [
      `id: ${input.id}`,
      `title: ${input.title}`,
      "source_type: manual",
      "retrieved_at: 2026-06-14T00:00:00.000Z",
      "content_hash: sha256:private-source",
      "trust:",
      "  reliability: high",
    ].join("\n") + "\n",
  );
}
