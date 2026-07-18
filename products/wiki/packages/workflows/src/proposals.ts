import path from "node:path";
import { rm } from "node:fs/promises";
import {
  type PageRecord,
  type ProposalRecord,
  type ValidationIssue,
  type ValidationReport,
  assertOpenWikiId,
  idToUri,
  isoNow,
  slugify,
} from "@openwiki/core";
import {
  appendEvent,
  loadRepository,
  readPage,
  renderPageMarkdown,
} from "@openwiki/repo";
import { withWriteCoordination } from "./write-coordinator.ts";
import { rebuildDerivedIndexes } from "./derived-indexes.ts";
import { currentGitCommit, gitAdd, gitCommit } from "./git.ts";
import {
  dateSequenceId,
  nextDailySequence,
  pagePathFor,
  renderProposalYaml,
  unifiedDiff,
} from "./format.ts";
import { writeText } from "./io.ts";
import type {
  CreateSynthesisInput,
  CreateSynthesisResult,
  ProposeEditInput,
  ProposeEditResult,
  ProposeSynthesisInput,
  ProposeSynthesisResult,
} from "./types.ts";

import { applyProposal } from "./proposal-apply.ts";
import { reviewProposal } from "./proposal-review.ts";
export async function proposeEdit(input: ProposeEditInput): Promise<ProposeEditResult> {
  throwIfAborted(input.abortSignal);
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.propose_edit",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: {
        page_id: input.pageId,
      },
    },
    () => proposeEditUnlocked(input),
  );
}

async function proposeEditUnlocked(input: ProposeEditInput): Promise<ProposeEditResult> {
  throwIfAborted(input.abortSignal);
  const repo = await loadRepository(input.root);
  const page = await readPage(repo.root, input.pageId);
  throwIfAborted(input.abortSignal);
  const now = isoNow();
  const sequence = nextDailySequence(repo.proposals.map((proposal) => proposal.id), "proposal", now);
  const proposalId = dateSequenceId("proposal", now, sequence);
  const actorId = input.actorId ?? "actor:user:local";
  assertOpenWikiId(actorId, "actor");

  const updatedPage: PageRecord = {
    ...page,
    title: input.title ?? page.title,
    body: input.body.trim(),
    source_ids: input.sourceIds ?? page.source_ids,
    claim_ids: input.claimIds ?? page.claim_ids,
    updated_at: now,
  };
  if (input.summary !== undefined) {
    updatedPage.summary = input.summary;
  }
  const oldMarkdown = renderPageMarkdown(page);
  const newMarkdown = renderPageMarkdown(updatedPage);
  const diff = unifiedDiff(page.path, oldMarkdown, newMarkdown);

  const proposalStem = proposalId.replace(/:/g, "_").replace(/-/g, "_");
  const proposalPath = `proposals/${proposalStem}.yaml`;
  const diffPath = `proposals/diffs/${proposalStem}.diff`;
  const reportPath = `proposals/reports/${proposalStem}.json`;
  const snapshotPath = `proposals/snapshots/${proposalStem}/${path.basename(page.path)}`;

  const validation = validateProposedPage(proposalId, updatedPage, repo.sources.map((source) => source.id), now);
  const proposal: ProposalRecord = {
    id: proposalId,
    uri: idToUri(proposalId),
    type: "proposal",
    title: input.proposalTitle ?? `Edit ${page.title}`,
    status: "open",
    actor_id: actorId,
    target_ids: [page.id],
    target_path: page.path,
    diff: {
      format: "unified",
      path: diffPath,
    },
    snapshot_path: snapshotPath,
    validation_report_path: reportPath,
    created_at: now,
    path: proposalPath,
  };
  const baseCommit = await currentGitCommit(repo.root);
  if (baseCommit) {
    proposal.base_commit = baseCommit;
  }
  if (input.rationale) {
    proposal.rationale = input.rationale;
  }

  await writeProposalArtifacts(repo.root, [
    { path: diffPath, body: diff },
    { path: snapshotPath, body: newMarkdown },
    { path: reportPath, body: `${JSON.stringify(validation, null, 2)}\n` },
    { path: proposalPath, body: renderProposalYaml(proposal) },
  ], input.abortSignal);
  await appendEvent(repo.root, {
    type: "proposal.created",
    actor_id: actorId,
    operation: "wiki.propose_edit",
    record_id: proposal.id,
    record_type: "proposal",
    occurred_at: now,
    data: {
      target_ids: proposal.target_ids,
      target_path: proposal.target_path,
      diff_path: proposal.diff.path,
      snapshot_path: proposal.snapshot_path,
      validation_report_path: proposal.validation_report_path,
    },
  });
  await rebuildDerivedIndexes(repo.root);

  return { proposal, validation, diff };
}

async function writeProposalArtifacts(
  root: string,
  artifacts: Array<{ path: string; body: string }>,
  signal: AbortSignal | undefined,
): Promise<void> {
  const writtenPaths: string[] = [];
  try {
    throwIfAborted(signal);
    for (const artifact of artifacts) {
      await writeText(root, artifact.path, artifact.body);
      writtenPaths.push(artifact.path);
      throwIfAborted(signal);
    }
  } catch (error) {
    await Promise.all(writtenPaths.map((artifactPath) => rm(path.join(root, artifactPath), { force: true }).catch(() => undefined)));
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new Error("OpenWiki proposal creation aborted");
  }
}

export async function proposeSynthesis(input: ProposeSynthesisInput): Promise<ProposeSynthesisResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.propose_synthesis",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: {
        title: input.title,
        page_type: input.pageType ?? "concept",
      },
    },
    () => proposeSynthesisUnlocked(input),
  );
}

async function proposeSynthesisUnlocked(input: ProposeSynthesisInput): Promise<ProposeSynthesisResult> {
  const repo = await loadRepository(input.root);
  const now = isoNow();
  const actorId = input.actorId ?? "actor:user:local";
  assertOpenWikiId(actorId, "actor");

  const pageType = slugify(input.pageType ?? "concept");
  const title = input.title.trim();
  if (!title) {
    throw new Error("Synthesis title cannot be empty");
  }
  const pageId = `page:${pageType}:${slugify(title)}`;
  const pagePath = pagePathFor(pageType, title);
  const sourceIds = (input.sourceIds ?? []).map((sourceId) => sourceId.trim()).filter(Boolean);
  const topics = (input.topics ?? []).map((topic) => topic.trim()).filter(Boolean);
  const page: PageRecord = {
    id: pageId,
    uri: idToUri(pageId),
    type: "page",
    page_type: pageType,
    title,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    body_format: "markdown",
    body: input.body.trim(),
    path: pagePath,
    source_ids: sourceIds,
    claim_ids: [],
    status: "draft",
    topics,
    created_at: now,
    updated_at: now,
  };

  const sequence = nextDailySequence(repo.proposals.map((proposal) => proposal.id), "proposal", now);
  const proposalId = dateSequenceId("proposal", now, sequence);
  const proposalStem = proposalId.replace(/:/g, "_").replace(/-/g, "_");
  const proposalPath = `proposals/${proposalStem}.yaml`;
  const diffPath = `proposals/diffs/${proposalStem}.diff`;
  const reportPath = `proposals/reports/${proposalStem}.json`;
  const snapshotPath = `proposals/snapshots/${proposalStem}/${path.basename(page.path)}`;
  const newMarkdown = renderPageMarkdown(page);
  const diff = unifiedDiff(page.path, "", newMarkdown);
  const validation = validateProposedPage(proposalId, page, repo.sources.map((source) => source.id), now);
  addSynthesisValidationIssues(validation, page, repo.pages);

  const proposal: ProposalRecord = {
    id: proposalId,
    uri: idToUri(proposalId),
    type: "proposal",
    title: `Create ${title}`,
    status: "open",
    actor_id: actorId,
    target_ids: [page.id],
    target_path: page.path,
    diff: {
      format: "unified",
      path: diffPath,
    },
    snapshot_path: snapshotPath,
    validation_report_path: reportPath,
    created_at: now,
    path: proposalPath,
  };
  const baseCommit = await currentGitCommit(repo.root);
  if (baseCommit) {
    proposal.base_commit = baseCommit;
  }
  if (input.rationale) {
    proposal.rationale = input.rationale;
  }

  await writeText(repo.root, diffPath, diff);
  await writeText(repo.root, snapshotPath, newMarkdown);
  await writeText(repo.root, reportPath, `${JSON.stringify(validation, null, 2)}\n`);
  await writeText(repo.root, proposalPath, renderProposalYaml(proposal));
  await appendEvent(repo.root, {
    type: "proposal.created",
    actor_id: actorId,
    operation: "wiki.propose_synthesis",
    record_id: proposal.id,
    record_type: "proposal",
    occurred_at: now,
    data: {
      target_ids: proposal.target_ids,
      target_path: proposal.target_path,
      diff_path: proposal.diff.path,
      snapshot_path: proposal.snapshot_path,
      validation_report_path: proposal.validation_report_path,
    },
  });
  await rebuildDerivedIndexes(repo.root);

  return { proposal, page, validation, diff };
}

export async function createSynthesis(input: CreateSynthesisInput): Promise<CreateSynthesisResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.create_synthesis",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: {
        title: input.title,
        commit: input.commit === true,
      },
    },
    () => createSynthesisUnlocked(input),
  );
}

async function createSynthesisUnlocked(input: CreateSynthesisInput): Promise<CreateSynthesisResult> {
  const actorId = input.actorId ?? "actor:user:local";
  assertOpenWikiId(actorId, "actor");
  const proposed = await proposeSynthesis({
    root: input.root,
    title: input.title,
    body: input.body,
    ...(input.pageType === undefined ? {} : { pageType: input.pageType }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.topics === undefined ? {} : { topics: input.topics }),
    ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds }),
    actorId,
    rationale: input.rationale ?? "Trusted synthesis workflow.",
  });
  const reviewed = await reviewProposal({
    root: input.root,
    proposalId: proposed.proposal.id,
    decision: "accepted",
    actorId,
    rationale: input.decisionRationale ?? "Trusted synthesis workflow accepted this generated page.",
  });
  const applied = await applyProposal({
    root: input.root,
    proposalId: proposed.proposal.id,
    actorId,
    ...(input.commit === true ? { commit: true, message: input.message ?? `Create synthesis ${proposed.page.id}` } : {}),
  });
  const page = await readPage(input.root, proposed.page.id);
  const synthesisEvent = await appendEvent(input.root, {
    type: "synthesis.created",
    actor_id: actorId,
    operation: "wiki.create_synthesis",
    record_id: page.id,
    record_type: "page",
    data: {
      proposal_id: proposed.proposal.id,
      decision_id: reviewed.decision.id,
      applied_paths: applied.applied_paths,
      ...(applied.commit === undefined ? {} : { commit: applied.commit }),
      ...(applied.proposal.applied_commit === undefined ? {} : { applied_commit: applied.proposal.applied_commit }),
    },
  });

  const commit = applied.commit;
  if (input.commit) {
    if (!commit) {
      throw new Error(`Committed synthesis ${proposed.proposal.id} did not produce a commit`);
    }
    await gitAdd(input.root, [synthesisEvent.path]);
    await gitCommit(input.root, `Record synthesis audit for ${commit}`);
  }

  await rebuildDerivedIndexes(input.root);

  return {
    proposal: applied.proposal,
    decision: reviewed.decision,
    page,
    applied_paths: applied.applied_paths,
    validation: proposed.validation,
    repository_validation: applied.repository_validation,
    ...(commit === undefined ? {} : { commit }),
  };
}

function validateProposedPage(
  proposalId: string,
  page: PageRecord,
  sourceIds: string[],
  checkedAt: string,
): ValidationReport {
  const issues: ValidationIssue[] = [];
  if (!page.body.trim()) {
    issues.push({
      severity: "error",
      code: "page.body.empty",
      message: "Proposed page body cannot be empty.",
      path: page.path,
    });
  }
  if (!/^#\s+/m.test(page.body)) {
    issues.push({
      severity: "warning",
      code: "page.heading.missing",
      message: "Proposed page body should include a top-level Markdown heading.",
      path: page.path,
    });
  }
  const knownSources = new Set(sourceIds);
  for (const sourceId of page.source_ids) {
    if (!knownSources.has(sourceId)) {
      issues.push({
        severity: "warning",
        code: "page.source.unknown",
        message: `Page references unknown source '${sourceId}'.`,
        path: page.path,
      });
    }
  }

  return {
    id: `${proposalId}:validation`,
    proposal_id: proposalId,
    status: issues.some((issue) => issue.severity === "error") ? "failed" : "passed",
    checked_at: checkedAt,
    issues,
  };
}

function addSynthesisValidationIssues(
  validation: ValidationReport,
  page: PageRecord,
  existingPages: PageRecord[],
): void {
  if (existingPages.some((candidate) => candidate.id === page.id)) {
    validation.issues.push({
      severity: "error",
      code: "page.id.duplicate",
      message: `Page ID '${page.id}' already exists.`,
      path: page.path,
    });
  }
  if (existingPages.some((candidate) => candidate.path === page.path)) {
    validation.issues.push({
      severity: "error",
      code: "page.path.duplicate",
      message: `Page path '${page.path}' already exists.`,
      path: page.path,
    });
  }
  if (validation.issues.some((issue) => issue.severity === "error")) {
    validation.status = "failed";
  }
}
