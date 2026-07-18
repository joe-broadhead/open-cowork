import path from "node:path";
import {
  assertOpenWikiId,
  boundedOpenWikiListLimit,
  idToUri,
  isoNow,
  openWikiProposalSectionIds,
  openWikiProposalTargetsPath,
  openWikiProposalUpdatedAt,
  openWikiRepoRelativePath,
  slugify,
  validationReportFromUnknown,
  type ClaimRecord,
  type DecisionRecord,
  type FactRecord,
  type PageRecord,
  type ProposalCommentRecord,
  type ProposalRecord,
  type SourceRecord,
  type TakeRecord,
} from "@openwiki/core";
import { createContentStore } from "@openwiki/storage";
import { loadProposalComments } from "./loaders.ts";
import { loadRepository } from "./workspace.ts";
import {
  appendRepoTextFile,
  dateSequenceId,
  nextDailySequence,
  openRepoFileForRead,
  readOptionalTextArtifact,
  stringMetadata,
  verifySha256,
  withWorkspaceFileLock,
} from "./io.ts";
import {
  assertProposalDiffArtifactPath,
  assertProposalSnapshotArtifactPath,
  assertProposalValidationReportArtifactPath,
  assertSourceObjectArtifactPath,
  assertSourceRawArtifactPath,
} from "./artifacts.ts";
import type { AppendProposalCommentInput, ArtifactReadOptions, ClaimTrace, ListProposalsOptions, LoadedOpenWikiRepo, ProposalDetail, ProposalTextArtifact, SourceContentRead } from "./types.ts";

export async function readPage(root: string, idOrSlug: string): Promise<PageRecord> {
  const repo = await loadRepository(root);
  const match = repo.pages.find(
    (page) =>
      page.id === idOrSlug ||
      page.uri === idOrSlug ||
      page.path === idOrSlug ||
      page.id.endsWith(`:${slugify(idOrSlug)}`),
  );
  if (!match) {
    throw new Error(`Page not found: ${idOrSlug}`);
  }
  return match;
}

export async function readSource(root: string, id: string): Promise<SourceRecord> {
  const repo = await loadRepository(root);
  const match = repo.sources.find((source) => source.id === id || source.uri === id);
  if (!match) {
    throw new Error(`Source not found: ${id}`);
  }
  return match;
}

export async function readSourceContent(
  root: string,
  id: string,
  options: ArtifactReadOptions = {},
): Promise<SourceContentRead> {
  const repo = await loadRepository(root);
  const source = repo.sources.find((candidate) => candidate.id === id || candidate.uri === id);
  if (!source) {
    throw new Error(`Source not found: ${id}`);
  }
  const storage = source.storage ?? {};
  let storagePath = typeof storage.path === "string" && storage.path.trim() ? storage.path : undefined;
  if (storagePath === undefined) {
    return { source, content: null, unavailable_reason: "not_captured" };
  }
  const kind = typeof storage.kind === "string" ? storage.kind : undefined;
  if (kind !== undefined && kind !== "git" && kind !== "object") {
    return { source, content: null, unavailable_reason: "unsupported_storage" };
  }
  const backend = stringMetadata(storage, "backend");
  if (backend === "s3" || backend === "minio") {
    try {
      storagePath = assertSourceObjectArtifactPath(storagePath);
    } catch {
      return { source, content: null, unavailable_reason: "invalid_storage" };
    }
    const store = await createContentStore(repo.root, { ...repo.config.runtime?.storage, backend });
    const object = await store.get(storagePath, options).catch((error: unknown) => {
      if (isMissingObjectStoreReadError(error)) {
        return undefined;
      }
      if (isInvalidObjectStoreReadError(error)) {
        return "invalid" as const;
      }
      throw error;
    });
    if (object === undefined) {
      return { source, content: null, unavailable_reason: "missing" };
    }
    if (object === "invalid") {
      return { source, content: null, unavailable_reason: "invalid_storage" };
    }
    const truncated = object.data.byteLength < object.bytes;
    const contentHash = stringMetadata(storage, "content_hash") ?? object.content_hash ?? source.content_hash;
    const hashVerified = truncated || contentHash === undefined ? undefined : verifySha256(object.data, contentHash);
    if (hashVerified === false) {
      return { source, content: null, unavailable_reason: "hash_mismatch" };
    }
    return {
      source,
      content: {
        path: object.path,
        ...(kind === undefined ? {} : { kind }),
        backend,
        ...(object.media_type === undefined ? {} : { media_type: object.media_type }),
        ...(contentHash === undefined ? {} : { content_hash: contentHash }),
        bytes: object.bytes,
        body: object.data.toString("utf8"),
        truncated,
        ...(hashVerified === undefined ? {} : { hash_verified: hashVerified }),
      },
    };
  }
  if (kind === "object") {
    try {
      storagePath = assertSourceObjectArtifactPath(storagePath);
    } catch {
      return { source, content: null, unavailable_reason: "invalid_storage" };
    }
  } else {
    let rawPath: string;
    try {
      rawPath = assertSourceRawArtifactPath(storagePath);
    } catch {
      return { source, content: null, unavailable_reason: "invalid_storage" };
    }
    await options.authorizePath?.(rawPath);
    storagePath = rawPath;
  }
  const resolvedRoot = path.resolve(root);
  const opened = await openRepoFileForRead(resolvedRoot, storagePath);
  if (opened === undefined) {
    return { source, content: null, unavailable_reason: "missing" };
  }
  const stats = opened.stats;

  const maxBytes = Math.min(Math.max(options.maxBytes ?? 128 * 1024, 0), 1024 * 1024);
  const readLimit = Math.min(stats.size, maxBytes + 1);
  const buffer = Buffer.alloc(readLimit);
  try {
    const { bytesRead } = await opened.handle.read(buffer, 0, readLimit, 0);
    const truncated = stats.size > maxBytes || bytesRead > maxBytes;
    const data = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    const contentHash = stringMetadata(storage, "content_hash") ?? source.content_hash;
    const mediaType = stringMetadata(storage, "media_type");
    const hashVerified = truncated || contentHash === undefined ? undefined : verifySha256(data, contentHash);
    if (hashVerified === false) {
      return { source, content: null, unavailable_reason: "hash_mismatch" };
    }
    return {
      source,
      content: {
        path: openWikiRepoRelativePath(resolvedRoot, opened.path),
        ...(kind === undefined ? {} : { kind }),
        ...(mediaType === undefined ? {} : { media_type: mediaType }),
        ...(contentHash === undefined ? {} : { content_hash: contentHash }),
        bytes: stats.size,
        body: data.toString("utf8"),
        truncated,
        ...(hashVerified === undefined ? {} : { hash_verified: hashVerified }),
      },
    };
  } finally {
    await opened.handle.close();
  }
}

function isMissingObjectStoreReadError(error: unknown): boolean {
  return error instanceof Error && /S3-compatible object read failed: HTTP (404|410)\b/u.test(error.message);
}

function isInvalidObjectStoreReadError(error: unknown): boolean {
  return error instanceof Error && /^Invalid S3 object (bucket|key|path)\b/u.test(error.message);
}

export async function readClaim(root: string, id: string): Promise<ClaimRecord> {
  const repo = await loadRepository(root);
  const match = repo.claims.find((claim) => claim.id === id || claim.uri === id);
  if (!match) {
    throw new Error(`Claim not found: ${id}`);
  }
  return match;
}

export async function readFact(root: string, id: string): Promise<FactRecord> {
  const repo = await loadRepository(root);
  const match = repo.facts.find((fact) => fact.id === id || fact.uri === id);
  if (!match) {
    throw new Error(`Fact not found: ${id}`);
  }
  return match;
}

export async function readTake(root: string, id: string): Promise<TakeRecord> {
  const repo = await loadRepository(root);
  const match = repo.takes.find((take) => take.id === id || take.uri === id);
  if (!match) {
    throw new Error(`Take not found: ${id}`);
  }
  return match;
}

export async function traceClaim(root: string, id: string): Promise<ClaimTrace> {
  const repo = await loadRepository(root);
  const claim = repo.claims.find((candidate) => candidate.id === id || candidate.uri === id);
  if (!claim) {
    throw new Error(`Claim not found: ${id}`);
  }
  const sourceIds = new Set(claim.source_ids);
  const sources = repo.sources.filter((source) => sourceIds.has(source.id));
  const foundSourceIds = new Set(sources.map((source) => source.id));
  const page = repo.pages.find((candidate) => candidate.id === claim.page_id) ?? null;
  const proposals = repo.proposals
    .filter(
      (proposal) =>
        proposal.target_ids.includes(claim.page_id) ||
        proposal.target_ids.includes(claim.id) ||
        (page?.path !== undefined && proposal.target_path === page.path),
    )
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
  const proposalIds = new Set(proposals.map((proposal) => proposal.id));
  const decisions = repo.decisions
    .filter((decision) => proposalIds.has(decision.proposal_id))
    .sort((left, right) => right.decided_at.localeCompare(left.decided_at) || right.id.localeCompare(left.id));
  return {
    claim,
    page,
    sources,
    missing_source_ids: claim.source_ids.filter((sourceId) => !foundSourceIds.has(sourceId)),
    proposals,
    decisions,
    evidence_summary: {
      source_count: sources.length,
      missing_source_count: claim.source_ids.length - sources.length,
      proposal_count: proposals.length,
      decision_count: decisions.length,
      accepted_decision_count: decisions.filter((decision) => decision.decision === "accepted").length,
      confidence: claim.confidence,
      risk: claim.risk,
      status: claim.status,
      ...(claim.last_verified_at === undefined ? {} : { last_verified_at: claim.last_verified_at }),
    },
  };
}

export async function readProposal(root: string, id: string): Promise<ProposalRecord> {
  const repo = await loadRepository(root);
  const match = repo.proposals.find((proposal) => proposal.id === id || proposal.uri === id);
  if (!match) {
    throw new Error(`Proposal not found: ${id}`);
  }
  return match;
}

export async function listProposals(root: string, options: ListProposalsOptions = {}): Promise<{ proposals: ProposalRecord[]; total: number }> {
  const repo = await loadRepository(root);
  const statuses = options.statuses === undefined ? undefined : new Set(options.statuses);
  const proposals = repo.proposals
    .filter((proposal) => statuses === undefined || statuses.has(proposal.status))
    .filter((proposal) => options.actorId === undefined || proposal.actor_id === options.actorId)
    .filter((proposal) => options.targetId === undefined || proposal.target_ids.includes(options.targetId))
    .filter((proposal) => options.targetPath === undefined || openWikiProposalTargetsPath(proposal, options.targetPath, proposalTargetPathsForRepo(repo, proposal)))
    .filter((proposal) => options.sectionId === undefined || openWikiProposalSectionIds(proposal, repo.policy.sections, proposalTargetPathsForRepo(repo, proposal)).includes(options.sectionId))
    .filter((proposal) => options.updatedAfter === undefined || openWikiProposalUpdatedAt(proposal) >= options.updatedAfter)
    .filter((proposal) => options.updatedBefore === undefined || openWikiProposalUpdatedAt(proposal) <= options.updatedBefore)
    .sort((left, right) => openWikiProposalUpdatedAt(right).localeCompare(openWikiProposalUpdatedAt(left)) || right.id.localeCompare(left.id));
  const limit = boundedOpenWikiListLimit(options.limit, proposals.length, 1000);
  return {
    proposals: proposals.slice(0, limit),
    total: proposals.length,
  };
}

function proposalTargetPathsForRepo(repo: LoadedOpenWikiRepo, proposal: ProposalRecord): string[] {
  return proposal.target_ids.flatMap((targetId) => recordPathsForId(repo, targetId));
}

function recordPathsForId(repo: LoadedOpenWikiRepo, id: string): string[] {
  return [
    ...repo.pages.filter((record) => record.id === id).map((record) => record.path),
    ...repo.sources.filter((record) => record.id === id).map((record) => record.path),
    ...(repo.claims.some((record) => record.id === id) ? ["claims/claim-index.jsonl"] : []),
    ...repo.facts.filter((record) => record.id === id).map((record) => record.path),
    ...repo.takes.filter((record) => record.id === id).map((record) => record.path),
    ...repo.proposals.filter((record) => record.id === id).map((record) => record.path),
    ...repo.comments.filter((record) => record.id === id).map((record) => record.path),
    ...repo.decisions.filter((record) => record.id === id).map((record) => record.path),
    ...repo.events.filter((record) => record.id === id).map((record) => record.path),
    ...repo.runs.filter((record) => record.id === id).map((record) => record.path),
  ];
}

export function topicsForPage(repo: LoadedOpenWikiRepo, pageId: string): string[] {
  return repo.pages.find((page) => page.id === pageId)?.topics ?? [];
}

export async function readProposalDetail(root: string, id: string): Promise<ProposalDetail> {
  return readProposalDetailWithOptions(root, id);
}

export async function readProposalDetailWithOptions(root: string, id: string, options: { authorizePath?: (repoPath: string) => Promise<void> | void } = {}): Promise<ProposalDetail> {
  const resolved = path.resolve(root);
  const proposal = await readProposal(resolved, id);
  const detail: ProposalDetail = {
    proposal,
    comments: (await loadProposalComments(resolved)).filter((comment) => comment.proposal_id === proposal.id),
  };
  const diffPath = assertProposalDiffArtifactPath(proposal.diff.path);
  await options.authorizePath?.(diffPath);
  const diff = await readOptionalTextArtifact(resolved, diffPath);
  if (diff !== undefined) {
    detail.diff = diff;
  }
  if (proposal.snapshot_path !== undefined) {
    const snapshotPath = assertProposalSnapshotArtifactPath(proposal.snapshot_path);
    await options.authorizePath?.(snapshotPath);
    const snapshot = await readOptionalTextArtifact(resolved, snapshotPath);
    if (snapshot !== undefined) {
      detail.snapshot = snapshot;
    }
  }
  if (proposal.snapshot_paths !== undefined) {
    const snapshots: Record<string, ProposalTextArtifact> = {};
    for (const [key, snapshotPath] of Object.entries(proposal.snapshot_paths)) {
      const checkedSnapshotPath = assertProposalSnapshotArtifactPath(snapshotPath);
      await options.authorizePath?.(checkedSnapshotPath);
      const snapshot = await readOptionalTextArtifact(resolved, checkedSnapshotPath);
      if (snapshot !== undefined) {
        snapshots[key] = snapshot;
      }
    }
    if (Object.keys(snapshots).length > 0) {
      detail.snapshots = snapshots;
    }
  }
  if (proposal.validation_report_path !== undefined) {
    const validationReportPath = assertProposalValidationReportArtifactPath(proposal.validation_report_path);
    await options.authorizePath?.(validationReportPath);
    const artifact = await readOptionalTextArtifact(resolved, validationReportPath);
    if (artifact !== undefined) {
      detail.validation_report = validationReportFromUnknown(JSON.parse(artifact.body) as unknown, proposal.validation_report_path);
    }
  }
  const snapshotStatus = await proposalSnapshotStatus(resolved, proposal, detail);
  if (snapshotStatus !== undefined) {
    detail.snapshot_status = snapshotStatus;
  }
  return detail;
}

async function proposalSnapshotStatus(root: string, proposal: ProposalRecord, detail: ProposalDetail): Promise<ProposalDetail["snapshot_status"]> {
  if (proposal.target_path === undefined || detail.snapshot === undefined) {
    return undefined;
  }
  const current = await readOptionalTextArtifact(root, proposal.target_path);
  if (current === undefined) {
    return { status: "missing", target_paths: [proposal.target_path], stale_paths: [proposal.target_path] };
  }
  const stale = current.body !== detail.snapshot.body;
  return {
    status: stale ? "stale" : "current",
    target_paths: [proposal.target_path],
    stale_paths: stale ? [proposal.target_path] : [],
  };
}

export async function listProposalComments(
  root: string,
  proposalId: string,
  limit?: number,
): Promise<{ comments: ProposalCommentRecord[]; total: number }> {
  const proposal = await readProposal(root, proposalId);
  const comments = (await loadProposalComments(path.resolve(root))).filter((comment) => comment.proposal_id === proposal.id);
  const max = Math.max(limit ?? comments.length, 0);
  return {
    comments: comments.slice(0, max),
    total: comments.length,
  };
}

export async function appendProposalComment(
  root: string,
  input: AppendProposalCommentInput,
): Promise<ProposalCommentRecord> {
  const resolved = path.resolve(root);
  return withWorkspaceFileLock(resolved, "proposal-comments", async () => {
    const proposal = await readProposal(resolved, input.proposal_id);
    const comments = await loadProposalComments(resolved);
    const createdAt = input.created_at ?? isoNow();
    const sequence = nextDailySequence(comments.map((comment) => comment.id), "comment", createdAt);
    const commentId = dateSequenceId("comment", createdAt, sequence);
    const actorId = input.actor_id ?? "actor:user:local";
    assertOpenWikiId(actorId, "actor");
    const body = input.body.trim();
    if (!body) {
      throw new Error("Proposal comment body cannot be empty");
    }
    const comment: ProposalCommentRecord = {
      id: commentId,
      uri: idToUri(commentId),
      type: "comment",
      proposal_id: proposal.id,
      actor_id: actorId,
      body,
      created_at: createdAt,
      path: "proposals/comments.jsonl",
    };

    await appendRepoTextFile(resolved, comment.path, `${JSON.stringify(comment)}\n`);
    return comment;
  });
}

export async function readDecision(root: string, id: string): Promise<DecisionRecord> {
  const repo = await loadRepository(root);
  const match = repo.decisions.find((decision) => decision.id === id || decision.uri === id);
  if (!match) {
    throw new Error(`Decision not found: ${id}`);
  }
  return match;
}
