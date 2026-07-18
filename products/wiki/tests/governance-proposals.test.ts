import { routeHttpRequest } from "@openwiki/http-api";
import { readGitSyncState } from "@openwiki/git";
import { createWorkspace, listProposals, loadRepository, readPage, readProposalDetail } from "@openwiki/repo";
import { searchWiki } from "@openwiki/search";
import { exportStaticSite } from "@openwiki/static-export";
import {
  applyProposal,
  closeProposal,
  commentOnProposal,
  proposeEdit,
  proposeSource,
  reviewProposal
} from "@openwiki/workflows";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("creates and reviews an auditable edit proposal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-governance-"));
  try {
    await createWorkspace(root, "Governance Wiki");

    const result = await proposeEdit({
      root,
      pageId: "page:concept:agent-memory",
      actorId: "actor:user:test",
      rationale: "Clarify the local governance workflow.",
      body: "# Agent Memory\n\nAgent memory stays inspectable through OpenWiki proposals and decisions.",
    });

    assert.equal(result.validation.status, "passed");
    assert.match(result.diff, /--- a\/wiki\/concepts\/agent-memory.md/);
    assert.equal(result.proposal.status, "open");
    assert.ok(result.proposal.snapshot_path);
    assert.ok(result.proposal.validation_report_path);

    const repoAfterProposal = await loadRepository(root);
    assert.equal(repoAfterProposal.proposals.length, 1);
    assert.equal(repoAfterProposal.proposals[0]?.id, result.proposal.id);

    assert.equal((await listProposals(root, { actorId: "actor:user:test" })).total, 1);
    assert.equal((await listProposals(root, { targetId: "page:concept:agent-memory" })).total, 1);
    assert.equal((await listProposals(root, { targetPath: "wiki/concepts/agent-memory.md" })).total, 1);
    assert.equal((await listProposals(root, { sectionId: "section:all" })).total, 1);
    assert.equal((await listProposals(root, { updatedAfter: "2020-01-01T00:00:00.000Z" })).total, 1);
    assert.equal((await listProposals(root, { updatedAfter: "2099-01-01T00:00:00.000Z" })).total, 0);
    const filteredProposalApi = await routeHttpRequest(
      root,
      "GET",
      "/api/v1/proposals?actor_id=" +
        encodeURIComponent("actor:user:test") +
        "&target_id=" +
        encodeURIComponent("page:concept:agent-memory") +
        "&section_id=" +
        encodeURIComponent("section:all"),
    );
    assert.equal(filteredProposalApi.status, 200);
    assert.equal((filteredProposalApi.body as { total: number }).total, 1);

    const diff = await readFile(path.join(root, result.proposal.diff.path), "utf8");
    assert.match(diff, /Clarify the local governance workflow|Agent memory stays inspectable/);

    const search = await searchWiki(root, { query: "governance workflow", types: ["proposal"], limit: 5 });
    assert.equal(search.results[0]?.id, result.proposal.id);

    const httpProposal = await routeHttpRequest(
      root,
      "GET",
      `/api/v1/proposals/${encodeURIComponent(result.proposal.id)}`,
    );
    assert.equal(httpProposal.status, 200);
    assert.equal((httpProposal.body as { id: string }).id, result.proposal.id);

    const comment = await commentOnProposal({
      root,
      proposalId: result.proposal.id,
      actorId: "actor:agent:review-assistant",
      body: "Please confirm the new wording still cites inspectable evidence.",
    });
    assert.match(comment.comment.id, /^comment:/);
    const detailAfterComment = await readProposalDetail(root, result.proposal.id);
    assert.equal(detailAfterComment.comments.length, 1);
    assert.match(detailAfterComment.comments[0]?.body ?? "", /inspectable evidence/);
    const commentSearch = await searchWiki(root, { query: "inspectable evidence", types: ["comment"], limit: 5 });
    assert.equal(commentSearch.results[0]?.id, comment.comment.id);

    const review = await reviewProposal({
      root,
      proposalId: result.proposal.id,
      decision: "accepted",
      actorId: "actor:user:reviewer",
      rationale: "The proposal is scoped and validated.",
    });
    assert.equal(review.proposal.status, "accepted");
    assert.equal(review.decision.decision, "accepted");

    const { stdout: decisionStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "decision",
        "read",
        review.decision.id,
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const cliDecision = JSON.parse(decisionStdout) as { id: string; decision: string; rationale: string };
    assert.equal(cliDecision.id, review.decision.id);
    assert.equal(cliDecision.decision, "accepted");
    assert.match(cliDecision.rationale, /scoped and validated/);

    const repoAfterReview = await loadRepository(root);
    assert.equal(repoAfterReview.decisions.length, 1);
    assert.equal(repoAfterReview.proposals[0]?.status, "accepted");

    const apply = await applyProposal({
      root,
      proposalId: result.proposal.id,
      actorId: "actor:user:applier",
    });
    assert.equal(apply.proposal.status, "applied");
    assert.deepEqual(apply.applied_paths, ["wiki/concepts/agent-memory.md"]);
    assert.equal(apply.repository_validation.status, "passed");

    const pageAfterApply = await readPage(root, "page:concept:agent-memory");
    assert.match(pageAfterApply.body, /stays inspectable through OpenWiki proposals and decisions/);

    const appliedSearch = await searchWiki(root, { query: "stays inspectable", types: ["page"], limit: 5 });
    assert.equal(appliedSearch.results[0]?.id, "page:concept:agent-memory");

    const repoAfterApply = await loadRepository(root);
    assert.equal(repoAfterApply.proposals[0]?.status, "applied");
    assert.ok(repoAfterApply.proposals[0]?.applied_at);
    assert.ok(repoAfterApply.events.some((event) => event.type === "proposal.created" && event.record_id === result.proposal.id));
    assert.ok(repoAfterApply.events.some((event) => event.type === "proposal.commented" && event.record_id === result.proposal.id));
    assert.ok(repoAfterApply.events.some((event) => event.type === "proposal.reviewed" && event.record_id === result.proposal.id));
    assert.ok(repoAfterApply.events.some((event) => event.type === "proposal.applied" && event.record_id === result.proposal.id));
    await assert.rejects(
      applyProposal({
        root,
        proposalId: result.proposal.id,
        actorId: "actor:user:applier",
      }),
      /has already been applied/,
    );

    const exported = await exportStaticSite({ root, outDir: "public" });
    assert.ok(exported.files.includes("proposals.jsonl"));
    assert.ok(exported.files.includes("proposal-comments.jsonl"));
    assert.ok(exported.files.includes("decisions.jsonl"));
    assert.ok(exported.files.includes("decisions.json"));
    assert.ok(exported.files.includes("events.jsonl"));
    assert.ok(exported.files.includes(`${result.proposal.id.replace("proposal:", "proposals/")}.json`));
    assert.ok(exported.files.includes(`${review.decision.id.replace("decision:", "decisions/")}.json`));
    const proposalsJsonl = await readFile(path.join(exported.outDir, "proposals.jsonl"), "utf8");
    assert.match(proposalsJsonl, /"status":"applied"/);
    const proposalJson = await readFile(
      path.join(exported.outDir, `${result.proposal.id.replace("proposal:", "proposals/")}.json`),
      "utf8",
    );
    assert.match(proposalJson, /"status": "applied"/);
    const decisionJson = await readFile(
      path.join(exported.outDir, `${review.decision.id.replace("decision:", "decisions/")}.json`),
      "utf8",
    );
    assert.match(decisionJson, /The proposal is scoped and validated/);
    const eventsJsonl = await readFile(path.join(exported.outDir, "events.jsonl"), "utf8");
    assert.match(eventsJsonl, /proposal\.applied/);
    const commentsJsonl = await readFile(path.join(exported.outDir, "proposal-comments.jsonl"), "utf8");
    assert.match(commentsJsonl, /inspectable evidence/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("edit proposals can update page source and claim metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-governance-metadata-"));
  try {
    await createWorkspace(root, "Governance Metadata Wiki");
    const repo = await loadRepository(root);
    const page = repo.pages[0];
    const source = repo.sources[0];
    const claim = repo.claims[0];
    assert.ok(page);
    assert.ok(source);
    assert.ok(claim);

    const result = await proposeEdit({
      root,
      pageId: page.id,
      actorId: "actor:user:test",
      rationale: "Link page metadata to existing evidence.",
      sourceIds: [source.id],
      claimIds: [claim.id],
      body: "# Personal Knowledge Base\n\nMetadata links keep governance and dream checks grounded.",
    });

    assert.equal(result.validation.status, "passed");
    assert.ok(result.proposal.snapshot_path);
    const snapshot = await readFile(path.join(root, result.proposal.snapshot_path), "utf8");
    assert.match(snapshot, new RegExp(`source_ids:\\n  - ${source.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(snapshot, new RegExp(`claim_ids:\\n  - ${claim.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proposal detail and comments reject symlinked managed files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-proposal-symlink-"));
  const outside = path.join(os.tmpdir(), `openwiki-proposal-outside-${Date.now()}.txt`);
  try {
    await createWorkspace(root, "Proposal Symlink Wiki");
    await writeFile(outside, "outside host content must not be exposed");

    const diffProposal = await proposeEdit({
      root,
      pageId: "page:concept:agent-memory",
      actorId: "actor:user:test",
      rationale: "Create diff artifact",
      body: "# Agent Memory\n\nDiff artifact proposal.",
    });
    await replaceWithSymlink(root, diffProposal.proposal.diff.path, outside);
    await assert.rejects(readProposalDetail(root, diffProposal.proposal.id), /symbolic links/);

    const snapshotProposal = await proposeEdit({
      root,
      pageId: "page:concept:agent-memory",
      actorId: "actor:user:test",
      rationale: "Create snapshot artifact",
      body: "# Agent Memory\n\nSnapshot artifact proposal.",
    });
    assert.ok(snapshotProposal.proposal.snapshot_path);
    await replaceWithSymlink(root, snapshotProposal.proposal.snapshot_path, outside);
    await assert.rejects(readProposalDetail(root, snapshotProposal.proposal.id), /symbolic links/);

    const validationProposal = await proposeEdit({
      root,
      pageId: "page:concept:agent-memory",
      actorId: "actor:user:test",
      rationale: "Create validation artifact",
      body: "# Agent Memory\n\nValidation artifact proposal.",
    });
    assert.ok(validationProposal.proposal.validation_report_path);
    await replaceWithSymlink(root, validationProposal.proposal.validation_report_path, outside);
    await assert.rejects(readProposalDetail(root, validationProposal.proposal.id), /symbolic links/);

    const commentProposal = await proposeEdit({
      root,
      pageId: "page:concept:agent-memory",
      actorId: "actor:user:test",
      rationale: "Create comment target",
      body: "# Agent Memory\n\nComment target proposal.",
    });
    await symlink(outside, path.join(root, "proposals", "comments.jsonl"));
    await assert.rejects(
      commentOnProposal({
        root,
        proposalId: commentProposal.proposal.id,
        actorId: "actor:user:reviewer",
        body: "This comment must not write through a symlink.",
      }),
      /symbolic links/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("applying a proposal with commit includes audit artifacts and leaves Git clean", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-apply-commit-"));
  try {
    await createWorkspace(root, "Apply Commit Wiki");
    await initTestGit(root);

    const proposed = await proposeEdit({
      root,
      pageId: "page:concept:agent-memory",
      actorId: "actor:user:test",
      rationale: "Exercise committed proposal audit trail.",
      body: "# Agent Memory\n\nCommitted proposal applies must include events, decisions, and reports.",
    });
    await commentOnProposal({
      root,
      proposalId: proposed.proposal.id,
      actorId: "actor:user:reviewer",
      body: "Comment should travel with the committed proposal ledger.",
    });
    await reviewProposal({
      root,
      proposalId: proposed.proposal.id,
      decision: "accepted",
      actorId: "actor:user:reviewer",
      rationale: "Validated and ready to apply.",
    });

    const applied = await applyProposal({
      root,
      proposalId: proposed.proposal.id,
      actorId: "actor:user:maintainer",
      commit: true,
      message: "Apply proposal audit artifacts",
    });

    assert.ok(applied.commit);
    assert.equal(await git(root, ["status", "--short"]), "");
    const committedFiles = await git(root, ["show", "--name-only", "--format=", applied.commit]);
    assert.match(committedFiles, /wiki\/concepts\/agent-memory\.md/);
    assert.match(committedFiles, /proposals\/proposal_/);
    assert.match(committedFiles, /proposals\/diffs\//);
    assert.match(committedFiles, /proposals\/snapshots\//);
    assert.match(committedFiles, /proposals\/reports\//);
    assert.match(committedFiles, /proposals\/comments\.jsonl/);
    assert.match(committedFiles, /decisions\/decision_/);
    const appliedCommitSha = await git(root, ["rev-parse", applied.commit]);
    assert.equal(applied.proposal.applied_commit, appliedCommitSha);
    const repo = await loadRepository(root);
    const applyEvent = repo.events.find((event) => event.type === "proposal.applied" && event.record_id === proposed.proposal.id);
    assert.equal(applyEvent?.data?.sha, appliedCommitSha);
    assert.equal(applyEvent?.data?.short_sha, applied.commit);
    assert.equal(applyEvent?.data?.commit, `commit:${applied.commit}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proposal apply push_after_commit syncs the committed wiki to the configured Git remote", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-apply-auto-sync-"));
  const remote = path.join(os.tmpdir(), "openwiki-apply-auto-sync-" + Date.now() + ".git");
  const restoreLocalGitRemotes = allowLocalGitRemotesForTest();
  try {
    await execFileAsync("git", ["init", "--bare", remote]);
    const config = await createWorkspace(root, "Apply Auto Sync Wiki");
    await writeFile(path.join(root, "openwiki.json"), JSON.stringify({
      ...config,
      runtime: {
        ...(config.runtime ?? {}),
        sync: {
          remote: "origin",
          branch: "main",
          push_after_commit: true,
          conflict_policy: "stop",
        },
      },
    }, null, 2) + "\n");
    await initTestGit(root);
    await git(root, ["branch", "-M", "main"]);
    await git(root, ["remote", "add", "origin", remote]);
    await git(root, ["push", "-u", "origin", "main"]);

    const proposed = await proposeEdit({
      root,
      pageId: "page:concept:agent-memory",
      actorId: "actor:user:test",
      rationale: "Exercise post-apply sync.",
      body: "# Agent Memory\n\nCommitted proposal applies can sync to the private remote.",
    });
    await reviewProposal({
      root,
      proposalId: proposed.proposal.id,
      decision: "accepted",
      actorId: "actor:user:reviewer",
      rationale: "Validated and ready to sync.",
    });

    const applied = await applyProposal({
      root,
      proposalId: proposed.proposal.id,
      actorId: "actor:user:maintainer",
      commit: true,
      message: "Apply proposal for auto sync",
    });

    assert.ok(applied.commit);
    assert.equal(await git(root, ["status", "--short"]), "");
    const localHead = await git(root, ["rev-parse", "HEAD"]);
    const remoteHead = (await execFileAsync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout.trim();
    assert.equal(remoteHead, localHead);
    const syncState = await readGitSyncState(root);
    assert.equal(syncState.last_success?.status, "synced");
  } finally {
    restoreLocalGitRemotes();
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  }
});

test("proposal apply can trigger bounded configured backup automation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-apply-auto-backup-"));
  const backupDir = await mkdtemp(path.join(os.tmpdir(), "openwiki-apply-auto-backup-dest-"));
  try {
    const config = await createWorkspace(root, "Apply Auto Backup Wiki");
    await writeFile(path.join(root, "openwiki.json"), JSON.stringify({
      ...config,
      runtime: {
        ...(config.runtime ?? {}),
        backups: {
          enabled: true,
          schedule: "manual",
          backup_after_events: ["proposal.applied"],
          event_threshold: 1,
          min_interval_seconds: 0,
          destinations: [
            {
              id: "local",
              kind: "local",
              path: backupDir,
            },
          ],
        },
      },
    }, null, 2) + "\n");

    const proposed = await proposeEdit({
      root,
      pageId: "page:concept:agent-memory",
      actorId: "actor:user:test",
      rationale: "Exercise post-apply backup.",
      body: "# Agent Memory\n\nApplied proposals can trigger backup automation.",
    });
    await reviewProposal({
      root,
      proposalId: proposed.proposal.id,
      decision: "accepted",
      actorId: "actor:user:reviewer",
      rationale: "Validated and ready to back up.",
    });
    await applyProposal({
      root,
      proposalId: proposed.proposal.id,
      actorId: "actor:user:maintainer",
    });

    const backups = (await readdir(backupDir)).filter((entry) => entry.startsWith("openwiki-backup-"));
    assert.equal(backups.length, 1);
    const repo = await loadRepository(root);
    assert.ok(repo.events.some((event) => event.type === "backup.created"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  }
});

test("proposal section filters preserve non-suffix globstar path semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-section-globstar-"));
  try {
    await createWorkspace(root, "Section Globstar Wiki");
    await writeFile(
      path.join(root, "policy", "sections.json"),
      JSON.stringify(
        [
          { id: "section:all", title: "All", paths: ["**"], visibility: "public" },
          { id: "section:agent-memory", title: "Agent Memory", paths: ["wiki/**/concepts/agent-memory.md"], visibility: "public" },
        ],
        null,
        2,
      ) + "\n",
    );
    const result = await proposeEdit({
      root,
      pageId: "page:concept:agent-memory",
      actorId: "actor:user:globstar",
      rationale: "Exercise globstar section filtering.",
      body: "# Agent Memory\n\nGlobstar section filters should include this proposal.",
    });
    assert.equal(result.validation.status, "passed");
    assert.equal((await listProposals(root, { sectionId: "section:agent-memory" })).total, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proposal review cannot accept failed validation reports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-review-validation-"));
  try {
    await createWorkspace(root, "Review Validation Wiki");

    const proposed = await proposeSource({
      root,
      title: "Invalid Source Type",
      sourceType: "web_page",
      url: "https://example.com/invalid-source-type",
      actorId: "actor:user:researcher",
      rationale: "Exercise review guardrails.",
    });

    assert.equal(proposed.validation.status, "failed");
    await assert.rejects(
      reviewProposal({
        root,
        proposalId: proposed.proposal.id,
        decision: "accepted",
        actorId: "actor:user:reviewer",
        rationale: "This should not be accepted.",
      }),
      /cannot be accepted because validation status is failed/,
    );

    const needsChanges = await reviewProposal({
      root,
      proposalId: proposed.proposal.id,
      decision: "needs_changes",
      actorId: "actor:user:reviewer",
      rationale: "Use source_type webpage instead of web_page.",
    });
    assert.equal(needsChanges.proposal.status, "open");
    assert.equal(needsChanges.decision.decision, "needs_changes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proposals can be closed as superseded without becoming canonical", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-close-proposal-"));
  try {
    await createWorkspace(root, "Close Proposal Wiki");

    const invalid = await proposeSource({
      root,
      title: "Invalid Source Proposal",
      sourceType: "web_page",
      url: "https://example.com/invalid-source",
      actorId: "actor:user:researcher",
      rationale: "Smoke-test invalid source metadata.",
    });
    const replacement = await proposeSource({
      root,
      title: "Replacement Source Proposal",
      sourceType: "webpage",
      url: "https://example.com/replacement-source",
      actorId: "actor:user:researcher",
      rationale: "Replacement with supported source type.",
    });

    const closed = await closeProposal({
      root,
      proposalId: invalid.proposal.id,
      actorId: "actor:user:reviewer",
      rationale: "Superseded by the replacement source proposal.",
      supersededBy: replacement.proposal.id,
    });

    assert.equal(closed.closed, true);
    assert.equal(closed.proposal.status, "closed");
    assert.equal(closed.proposal.close_resolution, "superseded");
    assert.equal(closed.proposal.superseded_by, replacement.proposal.id);
    assert.equal(closed.proposal.closed_by, "actor:user:reviewer");
    assert.ok(closed.proposal.closed_at);

    await assert.rejects(
      applyProposal({
        root,
        proposalId: invalid.proposal.id,
        actorId: "actor:user:maintainer",
      }),
      /is closed and cannot be applied/,
    );

    const repo = await loadRepository(root);
    const stored = repo.proposals.find((proposal) => proposal.id === invalid.proposal.id);
    assert.equal(stored?.status, "closed");
    assert.equal(stored?.superseded_by, replacement.proposal.id);
    assert.ok(repo.events.some((event) => event.type === "proposal.closed" && event.record_id === invalid.proposal.id));
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

async function replaceWithSymlink(root: string, repoPath: string, target: string): Promise<void> {
  const artifactPath = path.join(root, repoPath);
  await rm(artifactPath, { force: true });
  await symlink(target, artifactPath);
}

function allowLocalGitRemotesForTest(): () => void {
  const previous = process.env.OPENWIKI_ALLOW_LOCAL_GIT_REMOTE;
  process.env.OPENWIKI_ALLOW_LOCAL_GIT_REMOTE = "1";
  return () => {
    if (previous === undefined) {
      delete process.env.OPENWIKI_ALLOW_LOCAL_GIT_REMOTE;
      return;
    }
    process.env.OPENWIKI_ALLOW_LOCAL_GIT_REMOTE = previous;
  };
}
