import os from "node:os";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type EventRecord,
  type ProposalRecord,
  assertOpenWikiId,
  atomicWriteFile,
  isoNow,
  writeOpenWikiLog,
} from "@openwiki/core";
import { appendEvent, loadRepository, readProposal } from "@openwiki/repo";
import { validateRepository, type RepositoryValidationReport } from "@openwiki/validation";
import { withWriteCoordination } from "./write-coordinator.ts";
import { rebuildDerivedIndexes } from "./derived-indexes.ts";
import { runPostEventAutomation } from "./sync.ts";
import {
  currentGitCommit,
  currentGitCommitFull,
  gitAdd,
  gitCommit,
  gitFileAtCommit,
  gitPathsChangedSince,
  OPENWIKI_PROPOSAL_APPLY_PATHS,
} from "./git.ts";
import { renderProposalYaml } from "./format.ts";
import { readValidationReport, safeExistingRepoPath, safeRepoWritePath, writeText } from "./io.ts";
import { normalizePolicyFileName, policyFilePath } from "./policy-utils.ts";
import type { ApplyProposalInput, ApplyProposalResult } from "./proposal-apply-types.ts";
import type { PolicyFileName } from "./types.ts";

export async function applyProposal(input: ApplyProposalInput): Promise<ApplyProposalResult> {
  const startedAt = Date.now();
  const actorId = input.actorId ?? "actor:user:local";
  writeOpenWikiLog({
    event: "proposal_apply_started",
    actor_id: actorId,
    metadata: {
      proposal_id: input.proposalId,
      commit: input.commit === true,
    },
  });
  try {
    const result = await withWriteCoordination(
      {
        root: input.root,
        operation: "wiki.apply_proposal",
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        metadata: {
          proposal_id: input.proposalId,
          commit: input.commit === true,
        },
      },
      () => applyProposalUnlocked(input),
    );
    await runPostEventAutomation({
      root: input.root,
      eventType: "proposal.applied",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      recordId: result.proposal.id,
      recordType: "proposal",
      subjectIds: result.proposal.target_ids,
      subjectPaths: result.applied_paths,
      hasManagedCommit: result.commit !== undefined,
    }).catch((error) => {
      writeOpenWikiLog({
        event: "post_event_automation_failed",
        level: "error",
        actor_id: actorId,
        metadata: { trigger_event: "proposal.applied", proposal_id: result.proposal.id },
        error: error instanceof Error ? error.message : String(error),
      });
    });
    writeOpenWikiLog({
      event: "proposal_apply_succeeded",
      actor_id: actorId,
      duration_ms: Date.now() - startedAt,
      metadata: {
        proposal_id: result.proposal.id,
        applied_paths: result.applied_paths,
        commit: result.commit,
      },
    });
    return result;
  } catch (error) {
    writeOpenWikiLog({
      event: "proposal_apply_failed",
      level: "error",
      actor_id: actorId,
      duration_ms: Date.now() - startedAt,
      metadata: {
        proposal_id: input.proposalId,
        commit: input.commit === true,
      },
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function applyProposalUnlocked(input: ApplyProposalInput): Promise<ApplyProposalResult> {
  const repo = await loadRepository(input.root);
  const proposal = await readProposal(repo.root, input.proposalId);
  if (proposal.status !== "accepted") {
    if (proposal.status === "applied") {
      throw new Error(`Proposal ${proposal.id} has already been applied`);
    }
    if (proposal.status === "closed") {
      throw new Error(`Proposal ${proposal.id} is closed and cannot be applied`);
    }
    throw new Error(`Proposal ${proposal.id} must be accepted before it can be applied`);
  }
  if (!proposal.snapshot_path) {
    if (!proposal.snapshot_paths || Object.keys(proposal.snapshot_paths).length === 0) {
      throw new Error(`Proposal ${proposal.id} does not include a snapshot_path`);
    }
  }

  const validation = await readValidationReport(repo.root, proposal.validation_report_path);
  if (validation?.status === "failed") {
    throw new Error(`Proposal ${proposal.id} has a failed validation report`);
  }

  const applyEntries = await proposalApplyEntries(repo, proposal);
  const rebase = await reconcileProposalBaseCommit(repo.root, proposal, applyEntries);
  const appliedAt = isoNow();
  const appliedProposal: ProposalRecord = {
    ...proposal,
    status: "applied",
    applied_at: appliedAt,
  };
  const repositoryValidation = await stageAndValidateProposalApply(repo.root, appliedProposal, applyEntries);

  for (const entry of applyEntries) {
    const targetPath = await safeRepoWritePath(repo.root, entry.targetRelativePath);
    await atomicWriteFile(targetPath, entry.snapshot);
  }

  const applyActorId = input.actorId ?? "actor:user:local";
  assertOpenWikiId(applyActorId, "actor");

  let commit: string | undefined;
  let finalProposal = appliedProposal;
  if (input.commit) {
    await writeText(repo.root, proposal.path, renderProposalYaml(appliedProposal));
    await gitAdd(repo.root, proposalRelatedCommitPaths(repo, proposal, applyEntries));
    await gitCommit(repo.root, input.message ?? `Apply ${proposal.id}`);
    commit = await currentGitCommit(repo.root);
    const sha = await currentGitCommitFull(repo.root);
    const shortSha = commit ?? sha.slice(0, 12);
    finalProposal = {
      ...appliedProposal,
      applied_commit: sha,
    };
    await writeText(repo.root, proposal.path, renderProposalYaml(finalProposal));
    const applyEvent = await appendProposalAppliedEvent(repo.root, finalProposal, applyActorId, appliedAt, applyEntries, repositoryValidation, rebase, {
      sha,
      shortSha,
    });
    await gitAdd(repo.root, [proposal.path, applyEvent.path]);
    await gitCommit(repo.root, `Record proposal apply audit for ${shortSha}`);
  } else {
    await writeText(repo.root, proposal.path, renderProposalYaml(appliedProposal));
    await appendProposalAppliedEvent(repo.root, appliedProposal, applyActorId, appliedAt, applyEntries, repositoryValidation, rebase);
  }

  await rebuildDerivedIndexes(repo.root);

  return {
    proposal: finalProposal,
    applied_paths: applyEntries.map((entry) => entry.targetRelativePath),
    validation,
    repository_validation: repositoryValidation,
    ...(rebase === undefined ? {} : { rebase }),
    ...(commit === undefined ? {} : { commit }),
  };
}

interface ProposalApplyRebase {
  performed: true;
  strategy: "append_jsonl";
  paths: string[];
  appended_record_ids: string[];
}

async function reconcileProposalBaseCommit(
  root: string,
  proposal: ProposalRecord,
  applyEntries: ProposalApplyEntry[],
): Promise<ProposalApplyRebase | undefined> {
  const baseStatus = await proposalBaseCommitStatus(root, proposal, applyEntries.map((entry) => entry.targetRelativePath));
  if (!baseStatus.changed) {
    return undefined;
  }
  const rebase = await rebaseAppendOnlyLedgerEntries(root, proposal, applyEntries);
  if (rebase !== undefined) {
    return rebase;
  }
  throw new Error(
    `Proposal ${proposal.id} has a stale snapshot based on ${proposal.base_commit}, but the current commit is ${baseStatus.current}; revalidate or recreate the proposal before applying`,
  );
}

async function proposalBaseCommitStatus(root: string, proposal: ProposalRecord, targetPaths: string[]): Promise<{ changed: boolean; current?: string }> {
  if (!proposal.base_commit) {
    return { changed: false };
  }
  const current = await currentGitCommit(root);
  if (current === undefined) {
    throw new Error(`Proposal ${proposal.id} was based on ${proposal.base_commit}, but the current commit could not be resolved`);
  }
  if (gitCommitMatches(proposal.base_commit, current)) {
    return { changed: false, current };
  }
  if (!(await gitPathsChangedSince(root, proposal.base_commit, targetPaths))) {
    return { changed: false, current };
  }
  return { changed: true, current };
}

function gitCommitMatches(left: string, right: string): boolean {
  return left === right || left.startsWith(right) || right.startsWith(left);
}

async function appendProposalAppliedEvent(
  root: string,
  proposal: ProposalRecord,
  actorId: string,
  appliedAt: string,
  applyEntries: ProposalApplyEntry[],
  repositoryValidation: RepositoryValidationReport,
  rebase?: ProposalApplyRebase,
  commit?: { sha: string; shortSha: string },
): Promise<EventRecord> {
  return appendEvent(root, {
    type: "proposal.applied",
    actor_id: actorId,
    operation: "wiki.apply_proposal",
    record_id: proposal.id,
    record_type: "proposal",
    occurred_at: appliedAt,
    subject_ids: applyEntries.map((entry) => entry.targetId),
    subject_paths: applyEntries.map((entry) => entry.targetRelativePath),
    data: {
      applied_paths: applyEntries.map((entry) => entry.targetRelativePath),
      ...(rebase === undefined ? {} : { rebase }),
      repository_validation: {
        id: repositoryValidation.id,
        status: repositoryValidation.status,
        issue_count: repositoryValidation.issue_count,
      },
      ...(commit === undefined
        ? {}
        : {
            commit: `commit:${commit.shortSha}`,
            sha: commit.sha,
            short_sha: commit.shortSha,
          }),
    },
  });
}

interface ProposalApplyEntry {
  targetId: string;
  targetRelativePath: string;
  snapshotRelativePath: string;
  snapshot: string;
}

async function rebaseAppendOnlyLedgerEntries(
  root: string,
  proposal: ProposalRecord,
  entries: ProposalApplyEntry[],
): Promise<ProposalApplyRebase | undefined> {
  if (!proposal.base_commit || entries.length === 0 || entries.some((entry) => !appendOnlyLedgerPath(entry.targetRelativePath))) {
    return undefined;
  }
  const rebasedEntries: ProposalApplyEntry[] = [];
  const appendedRecordIds: string[] = [];
  for (const entry of entries) {
    const rebased = await rebaseAppendOnlyLedgerEntry(root, proposal, entry);
    if (rebased === undefined) {
      return undefined;
    }
    rebasedEntries.push({ ...entry, snapshot: rebased.snapshot });
    appendedRecordIds.push(...rebased.appendedRecordIds);
  }
  entries.splice(0, entries.length, ...rebasedEntries);
  return {
    performed: true,
    strategy: "append_jsonl",
    paths: uniqueCommitPaths(entries.map((entry) => entry.targetRelativePath)),
    appended_record_ids: appendedRecordIds,
  };
}

async function rebaseAppendOnlyLedgerEntry(
  root: string,
  proposal: ProposalRecord,
  entry: ProposalApplyEntry,
): Promise<{ snapshot: string; appendedRecordIds: string[] } | undefined> {
  const baseBody = (await gitFileAtCommit(root, proposal.base_commit ?? "", entry.targetRelativePath)) ?? "";
  const currentBody = await readRepoTextOrEmpty(root, entry.targetRelativePath);
  const baseRecords = parseJsonlLedger(baseBody, entry.targetRelativePath, "base");
  const currentRecords = parseJsonlLedger(currentBody, entry.targetRelativePath, "current");
  const snapshotRecords = parseJsonlLedger(entry.snapshot, entry.snapshotRelativePath, "snapshot");
  const baseById = recordsById(baseRecords, entry.targetRelativePath, "base");
  const currentById = recordsById(currentRecords, entry.targetRelativePath, "current");
  const snapshotById = recordsById(snapshotRecords, entry.snapshotRelativePath, "snapshot");

  for (const [id, baseRecord] of baseById) {
    if (snapshotById.get(id)?.canonical !== baseRecord.canonical) {
      return undefined;
    }
    if (currentById.get(id)?.canonical !== baseRecord.canonical) {
      return undefined;
    }
  }

  const appended = snapshotRecords.filter((record) => !baseById.has(record.id));
  if (appended.length === 0) {
    return undefined;
  }
  for (const record of appended) {
    if (currentById.has(record.id)) {
      throw new Error(`Proposal ${proposal.id} cannot rebase ${entry.targetRelativePath}: record ${record.id} already exists in the current ledger`);
    }
  }

  const currentPrefix = currentBody.trimEnd();
  const appendedBody = appended.map((record) => record.line).join("\n");
  return {
    snapshot: `${currentPrefix ? `${currentPrefix}\n` : ""}${appendedBody}\n`,
    appendedRecordIds: appended.map((record) => record.id),
  };
}

function appendOnlyLedgerPath(repoPath: string): boolean {
  return repoPath === "facts/facts.jsonl" || repoPath === "takes/takes.jsonl";
}

async function readRepoTextOrEmpty(root: string, repoPath: string): Promise<string> {
  try {
    return await fs.readFile(await safeRepoWritePath(root, repoPath), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

interface JsonlLedgerRecord {
  id: string;
  line: string;
  canonical: string;
}

function parseJsonlLedger(body: string, repoPath: string, label: string): JsonlLedgerRecord[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== "object" || parsed === null || !("id" in parsed) || typeof (parsed as { id?: unknown }).id !== "string") {
        throw new Error(`Proposal ${label} ledger ${repoPath} line ${index + 1} is missing a string id`);
      }
      return { id: (parsed as { id: string }).id, line, canonical: JSON.stringify(parsed) };
    });
}

function recordsById(records: JsonlLedgerRecord[], repoPath: string, label: string): Map<string, JsonlLedgerRecord> {
  const byId = new Map<string, JsonlLedgerRecord>();
  for (const record of records) {
    if (byId.has(record.id)) {
      throw new Error(`Proposal ${label} ledger ${repoPath} contains duplicate record id ${record.id}`);
    }
    byId.set(record.id, record);
  }
  return byId;
}

function proposalRelatedCommitPaths(
  repo: Awaited<ReturnType<typeof loadRepository>>,
  proposal: ProposalRecord,
  applyEntries: ProposalApplyEntry[],
  extraPaths: Array<string | undefined> = [],
): string[] {
  return uniqueCommitPaths([
    ...applyEntries.map((entry) => entry.targetRelativePath),
    proposal.path,
    proposal.diff.path,
    proposal.validation_report_path,
    ...applyEntries.map((entry) => entry.snapshotRelativePath),
    ...repo.decisions.filter((decision) => decision.proposal_id === proposal.id).map((decision) => decision.path),
    ...repo.comments.filter((comment) => comment.proposal_id === proposal.id).map((comment) => comment.path),
    ...extraPaths,
  ]);
}

function uniqueCommitPaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const uniquePaths: string[] = [];
  for (const commitPath of paths) {
    if (!commitPath || seen.has(commitPath)) {
      continue;
    }
    seen.add(commitPath);
    uniquePaths.push(commitPath);
  }
  return uniquePaths;
}

async function proposalApplyEntries(repo: Awaited<ReturnType<typeof loadRepository>>, proposal: ProposalRecord): Promise<ProposalApplyEntry[]> {
  if (proposal.snapshot_paths !== undefined && Object.keys(proposal.snapshot_paths).length > 0) {
    const entries: ProposalApplyEntry[] = [];
    const snapshotTargetIds = new Set<string>();
    for (const [policyFile, snapshotRelativePath] of Object.entries(proposal.snapshot_paths)) {
      const normalizedPolicyFile = normalizePolicyFileName(policyFile as PolicyFileName);
      const targetId = `policy:${normalizedPolicyFile}`;
      const targetRelativePath = policyFilePath(normalizedPolicyFile);
      if (!proposal.target_ids.includes(targetId)) {
        throw new Error(`Proposal ${proposal.id} snapshot ${policyFile} is not listed in target_ids`);
      }
      snapshotTargetIds.add(targetId);
      assertProposalApplyTarget(repo, proposal, targetId, targetRelativePath, snapshotRelativePath);
      const snapshot = await fs.readFile(await safeExistingRepoPath(repo.root, snapshotRelativePath), "utf8");
      entries.push({ targetId, targetRelativePath, snapshotRelativePath, snapshot });
    }
    const missingSnapshotTargetId = proposal.target_ids.find((targetId) => !snapshotTargetIds.has(targetId));
    if (missingSnapshotTargetId !== undefined) {
      throw new Error(`Proposal ${proposal.id} target_id ${missingSnapshotTargetId} does not have a snapshot_path`);
    }
    return entries;
  }

  if (proposal.target_ids.length !== 1) {
    throw new Error(`Proposal ${proposal.id} must target exactly one record without snapshot_paths`);
  }
  const targetId = proposal.target_ids[0] ?? "";
  const page = repo.pages.find((candidate) => candidate.id === targetId);
  const targetRelativePath = page?.path ?? proposal.target_path;
  if (!targetRelativePath) {
    throw new Error(`Proposal ${proposal.id} does not include a target_path for apply`);
  }
  if (!proposal.snapshot_path) {
    throw new Error(`Proposal ${proposal.id} does not include a snapshot_path`);
  }
  assertProposalApplyTarget(repo, proposal, targetId, targetRelativePath, proposal.snapshot_path);
  const snapshot = await fs.readFile(await safeExistingRepoPath(repo.root, proposal.snapshot_path), "utf8");
  return [{ targetId, targetRelativePath, snapshotRelativePath: proposal.snapshot_path, snapshot }];
}

async function stageAndValidateProposalApply(
  root: string,
  proposal: ProposalRecord,
  entries: ProposalApplyEntry[],
): Promise<RepositoryValidationReport> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openwiki-apply-"));
  try {
    await fs.cp(root, tempRoot, {
      recursive: true,
      force: true,
      filter: (source) => shouldCopyForApplyValidation(root, source),
    });
    for (const entry of entries) {
      await writeText(tempRoot, entry.targetRelativePath, entry.snapshot);
    }
    await writeText(tempRoot, proposal.path, renderProposalYaml(proposal));
    const validation = await validateRepository(tempRoot);
    if (validation.status === "failed") {
      throw new Error(
        `Applying ${proposal.id} would fail repository validation: ${validation.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => `${issue.code}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return validation;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function shouldCopyForApplyValidation(root: string, source: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(source));
  if (!relative) {
    return true;
  }
  const parts = relative.split(path.sep);
  if (parts[0] === ".git") {
    return false;
  }
  if (parts[0] === ".openwiki" && parts[1] === "index") {
    return false;
  }
  return true;
}

function assertProposalApplyTarget(
  repo: Awaited<ReturnType<typeof loadRepository>>,
  proposal: ProposalRecord,
  targetId: string,
  targetRelativePath: string,
  snapshotRelativePath: string,
): void {
  assertManagedProposalPath(targetRelativePath, "target_path");
  assertManagedProposalPath(snapshotRelativePath, "snapshot_path");
  if (!snapshotRelativePath.startsWith("proposals/snapshots/")) {
    throw new Error(`Proposal ${proposal.id} snapshot_path must be under proposals/snapshots/ before apply`);
  }
  if (targetId.startsWith("page:")) {
    if (!targetRelativePath.startsWith("wiki/")) {
      throw new Error(`Proposal ${proposal.id} page target must be under wiki/`);
    }
    const page = repo.pages.find((candidate) => candidate.id === targetId);
    if (page && page.path !== targetRelativePath) {
      throw new Error(`Proposal ${proposal.id} target_path does not match existing page path`);
    }
    return;
  }
  if (targetId.startsWith("source:")) {
    if (!targetRelativePath.startsWith("sources/manifests/") || !targetRelativePath.endsWith(".yaml")) {
      throw new Error(`Proposal ${proposal.id} source target must be a YAML manifest under sources/manifests/`);
    }
    return;
  }
  if (targetId.startsWith("policy:")) {
    if (!["policy/sections.json", "policy/grants.json", "policy/approval-rules.json"].includes(targetRelativePath)) {
      throw new Error(`Proposal ${proposal.id} policy target must be one of the supported policy files`);
    }
    return;
  }
  if (targetId.startsWith("fact:")) {
    if (targetRelativePath !== "facts/facts.jsonl") {
      throw new Error(`Proposal ${proposal.id} fact target must update facts/facts.jsonl`);
    }
    return;
  }
  if (targetId.startsWith("take:")) {
    if (targetRelativePath !== "takes/takes.jsonl") {
      throw new Error(`Proposal ${proposal.id} take target must update takes/takes.jsonl`);
    }
    return;
  }
  throw new Error(`Proposal ${proposal.id} targets unsupported record id ${targetId}`);
}

function assertManagedProposalPath(repoPath: string, field: string): void {
  const normalized = repoPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.includes("..") || normalized.startsWith(".git/") || normalized === ".git") {
    throw new Error(`Proposal ${field} must be a safe repository-relative path`);
  }
  if (!OPENWIKI_PROPOSAL_APPLY_PATHS.some((allowed) => normalized === allowed || normalized.startsWith(allowed + "/"))) {
    throw new Error(`Proposal ${field} must target an OpenWiki-managed path`);
  }
}
