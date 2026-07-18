import path from "node:path";
import {
  type OpenWikiPolicyBundle,
  type OpenWikiSectionRecord,
  type ProposalRecord,
  assertOpenWikiId,
  idToUri,
  isoNow,
  uniqueStrings,
} from "@openwiki/core";
import { appendEvent, loadRepository } from "@openwiki/repo";
import { withWriteCoordination } from "./write-coordinator.ts";
import { rebuildDerivedIndexes } from "./derived-indexes.ts";
import { currentGitCommit } from "./git.ts";
import {
  dateSequenceId,
  nextDailySequence,
  renderProposalYaml,
  unifiedDiff,
} from "./format.ts";
import { writeText } from "./io.ts";
import {
  approvalRuleIdForSection,
  mergePolicyGrants,
  normalizePolicyFileBody,
  normalizePolicyFileName,
  normalizeSectionId,
  policyBundleWithProposedFile,
  policyFileBodyFromBundle,
  policyFilePath,
  readPolicyFileBody,
  sectionTitleFromId,
  upsertApprovalRule,
  upsertSection,
  validatePolicyProposal,
} from "./policy-utils.ts";
import type {
  ProposePolicyChangeInput,
  ProposePolicyChangeResult,
  ProposeSectionPolicyInput,
  ProposeSectionPolicyResult,
} from "./types.ts";

export async function proposePolicyChange(input: ProposePolicyChangeInput): Promise<ProposePolicyChangeResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.propose_policy_change",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: {
        policy_file: input.policyFile,
      },
    },
    () => proposePolicyChangeUnlocked(input),
  );
}

async function proposePolicyChangeUnlocked(input: ProposePolicyChangeInput): Promise<ProposePolicyChangeResult> {
  const repo = await loadRepository(input.root);
  const now = isoNow();
  const actorId = input.actorId ?? "actor:user:local";
  assertOpenWikiId(actorId, "actor");
  const policyFile = normalizePolicyFileName(input.policyFile);
  const targetPath = policyFilePath(policyFile);
  const oldBody = await readPolicyFileBody(repo.root, targetPath);
  const newBody = normalizePolicyFileBody(policyFile, input.body);
  const nextPolicy = policyBundleWithProposedFile(repo.policy, policyFile, JSON.parse(newBody) as unknown);

  const sequence = nextDailySequence(repo.proposals.map((proposal) => proposal.id), "proposal", now);
  const proposalId = dateSequenceId("proposal", now, sequence);
  const proposalStem = proposalId.replace(/:/g, "_").replace(/-/g, "_");
  const proposalPath = `proposals/${proposalStem}.yaml`;
  const diffPath = `proposals/diffs/${proposalStem}.diff`;
  const reportPath = `proposals/reports/${proposalStem}.json`;
  const snapshotPath = `proposals/snapshots/${proposalStem}/${path.basename(targetPath)}`;
  const diff = unifiedDiff(targetPath, oldBody, newBody);
  const validation = validatePolicyProposal(proposalId, targetPath, nextPolicy, now);

  const proposal: ProposalRecord = {
    id: proposalId,
    uri: idToUri(proposalId),
    type: "proposal",
    title: `Update policy ${policyFile}`,
    status: "open",
    actor_id: actorId,
    target_ids: [`policy:${policyFile}`],
    target_path: targetPath,
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
  await writeText(repo.root, snapshotPath, newBody);
  await writeText(repo.root, reportPath, `${JSON.stringify(validation, null, 2)}\n`);
  await writeText(repo.root, proposalPath, renderProposalYaml(proposal));
  await appendEvent(repo.root, {
    type: "proposal.created",
    actor_id: actorId,
    operation: "wiki.propose_policy",
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

  return { proposal, policy_file: policyFile, target_path: targetPath, validation, diff };
}

export async function proposeSectionPolicy(input: ProposeSectionPolicyInput): Promise<ProposeSectionPolicyResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.propose_section_policy",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: {
        section_id: input.sectionId,
      },
    },
    () => proposeSectionPolicyUnlocked(input),
  );
}

async function proposeSectionPolicyUnlocked(input: ProposeSectionPolicyInput): Promise<ProposeSectionPolicyResult> {
  const repo = await loadRepository(input.root);
  const now = isoNow();
  const actorId = input.actorId ?? "actor:user:local";
  assertOpenWikiId(actorId, "actor");
  const sectionId = normalizeSectionId(input.sectionId);
  const sectionPaths = uniqueStrings(input.paths, { trim: true, omitEmpty: true });
  if (sectionPaths.length === 0) {
    throw new Error("Section policy proposal requires at least one path");
  }

  const reviewerPrincipals = uniqueStrings(input.reviewerPrincipals ?? [], { trim: true, omitEmpty: true });
  const explicitRequiredReviewerPrincipals = uniqueStrings(input.requiredReviewerPrincipals ?? [], { trim: true, omitEmpty: true });
  const requiredReviewerPrincipals =
    explicitRequiredReviewerPrincipals.length > 0 ? explicitRequiredReviewerPrincipals : reviewerPrincipals;
  const section: OpenWikiSectionRecord = {
    id: sectionId,
    title: input.title.trim() || sectionTitleFromId(sectionId),
    paths: sectionPaths,
    visibility: input.visibility ?? "private",
    ...(input.ownerPrincipal ? { owner_principal: input.ownerPrincipal } : {}),
    ...(reviewerPrincipals.length > 0 ? { default_reviewers: reviewerPrincipals } : {}),
  };
  const nextPolicy: OpenWikiPolicyBundle = {
    sections: upsertSection(repo.policy.sections, section),
    grants: mergePolicyGrants(
      repo.policy.grants,
      sectionId,
      {
        viewer: input.viewerPrincipals ?? [],
        contributor: input.contributorPrincipals ?? [],
        researcher: input.researcherPrincipals ?? [],
        reviewer: reviewerPrincipals,
        maintainer: input.maintainerPrincipals ?? [],
        admin: uniqueStrings([...(input.ownerPrincipal ? [input.ownerPrincipal] : []), ...(input.adminPrincipals ?? [])], { trim: true, omitEmpty: true }),
      },
      { replaceSectionGrants: input.replaceGrants === true },
    ),
    approval_rules: upsertApprovalRule(repo.policy.approval_rules, {
      id: approvalRuleIdForSection(sectionId),
      paths: sectionPaths,
      required_reviewers: requiredReviewerPrincipals.map((principal) => ({ principal, role: "reviewer" as const })),
      require_separate_actor: true,
    }),
  };

  const sequence = nextDailySequence(repo.proposals.map((proposal) => proposal.id), "proposal", now);
  const proposalId = dateSequenceId("proposal", now, sequence);
  const proposalStem = proposalId.replace(/:/g, "_").replace(/-/g, "_");
  const diffPath = `proposals/diffs/${proposalStem}.diff`;
  const reportPath = `proposals/reports/${proposalStem}.json`;
  const proposalPath = `proposals/${proposalStem}.yaml`;
  const policyFiles = ["sections", "grants", "approval-rules"] as const;
  const snapshotPaths = Object.fromEntries(
    policyFiles.map((policyFile) => [policyFile, `proposals/snapshots/${proposalStem}/${policyFile}.json`]),
  ) as Record<(typeof policyFiles)[number], string>;
  const oldBodies = await Promise.all(policyFiles.map((policyFile) => readPolicyFileBody(repo.root, policyFilePath(policyFile))));
  const newBodies = policyFiles.map((policyFile) => policyFileBodyFromBundle(nextPolicy, policyFile));
  const diff = policyFiles
    .map((policyFile, index) => unifiedDiff(policyFilePath(policyFile), oldBodies[index] ?? "[]\n", newBodies[index] ?? "[]\n"))
    .join("\n");
  const validation = validatePolicyProposal(proposalId, "policy", nextPolicy, now);

  const proposal: ProposalRecord = {
    id: proposalId,
    uri: idToUri(proposalId),
    type: "proposal",
    title: `Update section policy ${section.id}`,
    status: "open",
    actor_id: actorId,
    target_ids: policyFiles.map((policyFile) => `policy:${policyFile}`),
    target_path: "policy",
    diff: {
      format: "unified",
      path: diffPath,
    },
    snapshot_paths: snapshotPaths,
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
  for (const [index, policyFile] of policyFiles.entries()) {
    await writeText(repo.root, snapshotPaths[policyFile], newBodies[index] ?? "[]\n");
  }
  await writeText(repo.root, reportPath, `${JSON.stringify(validation, null, 2)}\n`);
  await writeText(repo.root, proposalPath, renderProposalYaml(proposal));
  await appendEvent(repo.root, {
    type: "proposal.created",
    actor_id: actorId,
    operation: "wiki.propose_section_policy",
    record_id: proposal.id,
    record_type: "proposal",
    occurred_at: now,
    data: {
      target_ids: proposal.target_ids,
      target_path: proposal.target_path,
      diff_path: proposal.diff.path,
      snapshot_paths: proposal.snapshot_paths,
      validation_report_path: proposal.validation_report_path,
    },
  });
  await rebuildDerivedIndexes(repo.root);

  return { proposal, section, policy_files: [...policyFiles], target_path: "policy", validation, diff };
}
