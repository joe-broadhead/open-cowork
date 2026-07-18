import {
  type DecisionRecord,
  type ProposalRecord,
  assertOpenWikiId,
  idToUri,
  isoNow,
} from "@openwiki/core";
import {
  appendEvent,
  appendProposalComment,
  loadRepository,
  readProposal,
} from "@openwiki/repo";
import { withWriteCoordination } from "./write-coordinator.ts";
import { rebuildDerivedIndexes } from "./derived-indexes.ts";
import {
  dateSequenceId,
  nextDailySequence,
  renderDecisionYaml,
  renderProposalYaml,
} from "./format.ts";
import { readValidationReport, writeText } from "./io.ts";
import type {
  CloseProposalInput,
  CloseProposalResult,
  CommentOnProposalInput,
  CommentOnProposalResult,
  ReviewProposalInput,
  ReviewProposalResult,
} from "./types.ts";

export async function reviewProposal(input: ReviewProposalInput): Promise<ReviewProposalResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.review_proposal",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: {
        proposal_id: input.proposalId,
        decision: input.decision,
      },
    },
    () => reviewProposalUnlocked(input),
  );
}

async function reviewProposalUnlocked(input: ReviewProposalInput): Promise<ReviewProposalResult> {
  const repo = await loadRepository(input.root);
  const proposal = await readProposal(repo.root, input.proposalId);
  const now = isoNow();
  const sequence = nextDailySequence(repo.decisions.map((decision) => decision.id), "decision", now);
  const decisionId = dateSequenceId("decision", now, sequence);
  const actorId = input.actorId ?? "actor:user:local";
  assertOpenWikiId(actorId, "actor");
  const validation = await readValidationReport(repo.root, proposal.validation_report_path);
  if (input.decision === "accepted" && validation?.status !== "passed") {
    throw new Error(
      validation === null
        ? `Proposal ${proposal.id} cannot be accepted without a validation report`
        : `Proposal ${proposal.id} cannot be accepted because validation status is ${validation.status}`,
    );
  }

  const decision: DecisionRecord = {
    id: decisionId,
    uri: idToUri(decisionId),
    type: "decision",
    proposal_id: proposal.id,
    decision: input.decision,
    actor_id: actorId,
    rationale: input.rationale,
    decided_at: now,
    path: `decisions/${decisionId.replace(/:/g, "_").replace(/-/g, "_")}.yaml`,
  };
  if (input.commit) {
    decision.commit = input.commit;
  }

  const reviewedProposal: ProposalRecord = {
    ...proposal,
    status: input.decision === "accepted" ? "accepted" : input.decision === "rejected" ? "rejected" : "open",
  };

  await writeText(repo.root, decision.path, renderDecisionYaml(decision));
  await writeText(repo.root, proposal.path, renderProposalYaml(reviewedProposal));
  await appendEvent(repo.root, {
    type: "decision.created",
    actor_id: actorId,
    operation: "wiki.review_proposal",
    record_id: decision.id,
    record_type: "decision",
    occurred_at: now,
    data: {
      proposal_id: proposal.id,
      decision: decision.decision,
    },
  });
  await appendEvent(repo.root, {
    type: "proposal.reviewed",
    actor_id: actorId,
    operation: "wiki.review_proposal",
    record_id: proposal.id,
    record_type: "proposal",
    occurred_at: now,
    data: {
      decision_id: decision.id,
      decision: decision.decision,
      status: reviewedProposal.status,
    },
  });
  await rebuildDerivedIndexes(repo.root);

  return { proposal: reviewedProposal, decision };
}

export async function closeProposal(input: CloseProposalInput): Promise<CloseProposalResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.close_proposal",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: {
        proposal_id: input.proposalId,
        resolution: input.resolution ?? (input.supersededBy === undefined ? "closed" : "superseded"),
      },
    },
    () => closeProposalUnlocked(input),
  );
}

async function closeProposalUnlocked(input: CloseProposalInput): Promise<CloseProposalResult> {
  const repo = await loadRepository(input.root);
  const proposal = await readProposal(repo.root, input.proposalId);
  if (proposal.status === "applied") {
    throw new Error(`Applied proposal ${proposal.id} cannot be closed`);
  }
  if (proposal.status === "closed") {
    throw new Error(`Proposal ${proposal.id} is already closed`);
  }
  const actorId = input.actorId ?? "actor:user:local";
  assertOpenWikiId(actorId, "actor");
  const resolution = input.resolution ?? (input.supersededBy === undefined ? "closed" : "superseded");
  if (resolution === "superseded" && input.supersededBy === undefined) {
    throw new Error(`Proposal ${proposal.id} requires supersededBy when close resolution is superseded`);
  }
  if (input.supersededBy !== undefined) {
    assertOpenWikiId(input.supersededBy, "proposal");
    if (input.supersededBy === proposal.id) {
      throw new Error(`Proposal ${proposal.id} cannot supersede itself`);
    }
    await readProposal(repo.root, input.supersededBy);
  }

  const closedAt = isoNow();
  const closedProposal: ProposalRecord = {
    ...proposal,
    status: "closed",
    closed_at: closedAt,
    closed_by: actorId,
    close_resolution: resolution,
    close_rationale: input.rationale,
    ...(input.supersededBy === undefined ? {} : { superseded_by: input.supersededBy }),
  };

  await writeText(repo.root, proposal.path, renderProposalYaml(closedProposal));
  await appendEvent(repo.root, {
    type: "proposal.closed",
    actor_id: actorId,
    operation: "wiki.close_proposal",
    record_id: proposal.id,
    record_type: "proposal",
    occurred_at: closedAt,
    data: {
      status: "closed",
      close_resolution: resolution,
      rationale: input.rationale,
      ...(input.supersededBy === undefined ? {} : { superseded_by: input.supersededBy }),
    },
    subject_ids: input.supersededBy === undefined ? [proposal.id] : [proposal.id, input.supersededBy],
    subject_paths: [proposal.path, ...(proposal.target_path === undefined ? [] : [proposal.target_path])],
  });
  await rebuildDerivedIndexes(repo.root);

  return { proposal: closedProposal, closed: true };
}

export async function commentOnProposal(input: CommentOnProposalInput): Promise<CommentOnProposalResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.comment_on_proposal",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: {
        proposal_id: input.proposalId,
      },
    },
    () => commentOnProposalUnlocked(input),
  );
}

async function commentOnProposalUnlocked(input: CommentOnProposalInput): Promise<CommentOnProposalResult> {
  const repo = await loadRepository(input.root);
  const proposal = await readProposal(repo.root, input.proposalId);
  const actorId = input.actorId ?? "actor:user:local";
  assertOpenWikiId(actorId, "actor");
  const comment = await appendProposalComment(repo.root, {
    proposal_id: proposal.id,
    actor_id: actorId,
    body: input.body,
  });
  await appendEvent(repo.root, {
    type: "proposal.commented",
    actor_id: actorId,
    operation: "wiki.comment_on_proposal",
    record_id: proposal.id,
    record_type: "proposal",
    occurred_at: comment.created_at,
    data: {
      comment_id: comment.id,
    },
  });
  await rebuildDerivedIndexes(repo.root);
  return { proposal, comment };
}
