import { createWorkspace, loadRepository, readPage } from "@openwiki/repo";
import {
  applyProposal,
  proposeEdit,
  proposeSectionPolicy,
  reviewProposal
} from "@openwiki/workflows";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("CLI previews effective section permissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-policy-preview-cli-"));
  try {
    await createWorkspace(root, "Policy Preview CLI Wiki");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "policy",
        "preview",
        "--role",
        "maintainer",
        "--target-path",
        "wiki/concepts/agent-memory.md",
        "--target",
        "page:concept:agent-memory",
        "--operation",
        "wiki.apply_proposal",
        "--json",
      ],
      { cwd: process.cwd() },
    );

    const output = JSON.parse(stdout) as {
      preview: {
        scopes: string[];
        paths: Array<{ role?: string; access: { maintain: boolean } }>;
        records: Array<{ id: string; visible: boolean }>;
        operations: Array<{ operation: string; allowed: boolean }>;
      };
    };
    assert.ok(output.preview.scopes.includes("wiki:commit"));
    assert.equal(output.preview.paths[0]?.role, "maintainer");
    assert.equal(output.preview.paths[0]?.access.maintain, true);
    assert.equal(output.preview.records[0]?.visible, true);
    assert.equal(output.preview.operations[0]?.operation, "wiki.apply_proposal");
    assert.equal(output.preview.operations[0]?.allowed, true);

    const { stdout: identityStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "policy",
        "identities",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const identities = JSON.parse(identityStdout) as {
      identities: { principals: Array<{ id: string }>; groups: Array<{ id: string }>; service_accounts: unknown[] };
    };
    assert.ok(identities.identities.principals.some((principal) => principal.id === "group:all-users"));
    assert.ok(identities.identities.groups.some((group) => group.id === "group:all-users"));
    assert.deepEqual(identities.identities.service_accounts, []);

    const { stdout: sectionStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "policy",
        "propose-section",
        "--section",
        "section:legal",
        "--title",
        "Legal",
        "--path",
        "wiki/legal/**",
        "--viewer",
        "group:legal",
        "--reviewer",
        "group:legal-reviewers",
        "--admin",
        "group:legal-admins",
        "--owner",
        "group:legal-admins",
        "--rationale",
        "Add governed Legal section.",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const sectionOutput = JSON.parse(sectionStdout) as {
      proposal: { target_path: string; target_ids: string[]; snapshot_paths?: Record<string, string> };
      validation: { status: string };
    };
    assert.equal(sectionOutput.proposal.target_path, "policy");
    assert.deepEqual(sectionOutput.proposal.target_ids, ["policy:sections", "policy:grants", "policy:approval-rules"]);
    assert.ok(sectionOutput.proposal.snapshot_paths?.grants);
    assert.equal(sectionOutput.validation.status, "passed");

    const { stdout: workspaceStdout } = await execFileAsync(
      process.execPath,
      [
        "--no-warnings",
        "--import",
        "tsx",
        path.join(process.cwd(), "packages", "cli", "src", "main.ts"),
        "--root",
        root,
        "workspace",
        "registry",
        "--json",
      ],
      { cwd: process.cwd() },
    );
    const workspaceOutput = JSON.parse(workspaceStdout) as {
      registry: { source: string; workspaces: Array<{ id: string }>; repos: Array<{ repo_id: string }> };
    };
    assert.equal(workspaceOutput.registry.source, "git");
    assert.equal(workspaceOutput.registry.workspaces[0]?.id, "workspace:policy-preview-cli-wiki");
    assert.equal(workspaceOutput.registry.repos[0]?.repo_id, "repo:default");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proposal apply validates staged repository before mutating canonical files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-apply-validation-"));
  try {
    await createWorkspace(root, "Apply Validation Wiki");
    const before = await readPage(root, "page:concept:agent-memory");
    const proposed = await proposeEdit({
      root,
      pageId: "page:concept:agent-memory",
      actorId: "actor:user:test",
      rationale: "Exercise staged validation.",
      body: "# Agent Memory\n\nThis body should not be applied while the repository is invalid.",
    });
    await reviewProposal({
      root,
      proposalId: proposed.proposal.id,
      decision: "accepted",
      actorId: "actor:user:reviewer",
      rationale: "Accepted before repository drift.",
    });

    await writeFile(
      path.join(root, "claims", "claim-index.jsonl"),
      `${JSON.stringify({
        id: "claim:2026-05-21-001",
        uri: "openwiki://claim/2026-05-21-001",
        type: "claim",
        text: "This claim points at missing evidence.",
        page_id: "page:concept:agent-memory",
        source_ids: ["source:missing"],
        confidence: "medium",
        risk: "low",
        status: "active",
      })}\n`,
    );

    await assert.rejects(
      applyProposal({
        root,
        proposalId: proposed.proposal.id,
        actorId: "actor:user:applier",
      }),
      /repository validation/,
    );

    const after = await readPage(root, "page:concept:agent-memory");
    assert.equal(after.body, before.body);
    const repo = await loadRepository(root);
    assert.equal(repo.proposals[0]?.status, "accepted");
    assert.equal(repo.events.some((event) => event.type === "proposal.applied"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proposal apply requires every snapshot target to be represented", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-apply-snapshot-coverage-"));
  try {
    await createWorkspace(root, "Apply Snapshot Coverage Wiki");
    const proposed = await proposeSectionPolicy({
      root,
      sectionId: "section:finance",
      title: "Finance",
      paths: ["wiki/finance/**"],
      viewerPrincipals: ["group:finance"],
      reviewerPrincipals: ["group:finance-reviewers"],
      actorId: "actor:user:policy-editor",
      rationale: "Exercise snapshot coverage validation.",
    });
    await reviewProposal({
      root,
      proposalId: proposed.proposal.id,
      decision: "accepted",
      actorId: "actor:user:reviewer",
      rationale: "Accepted before intentionally corrupting snapshot coverage.",
    });

    const proposalPath = path.join(root, proposed.proposal.path);
    const acceptedYaml = await readFile(proposalPath, "utf8");
    const missingGrantSnapshotYaml = acceptedYaml.replace(/\n  grants: [^\n]+/u, "");
    assert.notEqual(missingGrantSnapshotYaml, acceptedYaml);
    await writeFile(proposalPath, missingGrantSnapshotYaml, "utf8");

    await assert.rejects(
      applyProposal({
        root,
        proposalId: proposed.proposal.id,
        actorId: "actor:user:applier",
      }),
      /target_id policy:grants does not have a snapshot_path/,
    );

    const repo = await loadRepository(root);
    const stored = repo.proposals.find((proposal) => proposal.id === proposed.proposal.id);
    assert.equal(stored?.status, "accepted");
    assert.equal(repo.policy.sections.some((section) => section.id === "section:finance"), false);
    assert.equal(repo.events.some((event) => event.type === "proposal.applied" && event.record_id === proposed.proposal.id), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
