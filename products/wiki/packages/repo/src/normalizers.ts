import {
  assertOpenWikiId,
  idToUri,
  isoNow,
  pageId,
  uniqueStrings,
  type ClaimRecord,
  type DecisionRecord,
  type DecisionValue,
  type EventRecord,
  type FactRecord,
  type FactStatus,
  type InboxItemPayloadReference,
  type InboxItemProcessingState,
  type InboxItemRecord,
  type InboxItemStatus,
  type OpenQuestionRecord,
  type PageRecord,
  type ProposalCloseResolution,
  type ProposalCommentRecord,
  type ProposalRecord,
  type ProposalStatus,
  type RunRecord,
  type SourceRecord,
  type TakeRecord,
  type TakeResolution,
  type TakeStatus,
} from "@openwiki/core";
import type { Frontmatter } from "./frontmatter.ts";
import {
  inferPageType,
  objectValue,
  parseEnum,
  stringArrayValue,
  stringValue,
  titleFromPath,
} from "./io.ts";

export function openQuestionsFromPage(page: PageRecord): OpenQuestionRecord[] {
  const lines = page.body.split(/\r?\n/);
  const questions: OpenQuestionRecord[] = [];
  let inOpenQuestions = false;
  let sectionLevel = 0;

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 0;
      const title = heading[2] ?? "";
      if (/^open questions?$/i.test(title.trim())) {
        inOpenQuestions = true;
        sectionLevel = level;
        continue;
      }
      if (inOpenQuestions && level <= sectionLevel) {
        inOpenQuestions = false;
      }
    }

    if (!inOpenQuestions) {
      continue;
    }

    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (!bullet) {
      continue;
    }
    const question = (bullet[1] ?? "").trim();
    if (!question) {
      continue;
    }
    questions.push({
      id: `${page.id}:open-question:${questions.length + 1}`,
      question,
      page_id: page.id,
      page_title: page.title,
      page_uri: page.uri,
      path: page.path,
      topics: page.topics,
      updated_at: page.updated_at,
    });
  }

  return questions;
}

export function pageFromMarkdown(repoPath: string, frontmatter: Frontmatter, body: string): PageRecord {
  const title = stringValue(frontmatter.title, titleFromPath(repoPath));
  const pageType = stringValue(frontmatter.type, inferPageType(repoPath));
  const id = stringValue(frontmatter.id, pageId(pageType, title));
  assertOpenWikiId(id, "page");
  return {
    id,
    uri: idToUri(id),
    type: "page",
    page_type: pageType,
    title,
    summary: stringValue(frontmatter.summary, ""),
    body_format: "markdown",
    body: body.trim(),
    path: repoPath,
    source_ids: stringArrayValue(frontmatter.source_ids),
    claim_ids: stringArrayValue(frontmatter.claim_ids),
    status: stringValue(frontmatter.status, "draft"),
    topics: stringArrayValue(frontmatter.topics),
    created_at: stringValue(frontmatter.created_at, isoNow()),
    updated_at: stringValue(frontmatter.updated_at, isoNow()),
  };
}

export function sourceFromManifest(repoPath: string, manifest: Frontmatter): SourceRecord {
  const id = stringValue(manifest.id);
  assertOpenWikiId(id, "source");
  const source: SourceRecord = {
    id,
    uri: idToUri(id),
    type: "source",
    title: stringValue(manifest.title),
    source_type: stringValue(manifest.source_type, "manual"),
    retrieved_at: stringValue(manifest.retrieved_at, isoNow()),
    path: repoPath,
  };
  if (typeof manifest.url === "string" && manifest.url.trim()) {
    source.url = manifest.url;
  }
  if (typeof manifest.content_hash === "string" && manifest.content_hash.trim()) {
    source.content_hash = manifest.content_hash;
  }
  if (manifest.storage && typeof manifest.storage === "object" && !Array.isArray(manifest.storage)) {
    source.storage = manifest.storage;
  }
  if (manifest.trust && typeof manifest.trust === "object" && !Array.isArray(manifest.trust)) {
    source.trust = manifest.trust;
  }
  return source;
}

export function normalizeClaim(claim: Partial<ClaimRecord>): ClaimRecord {
  const id = stringValue(claim.id);
  assertOpenWikiId(id, "claim");
  const page_id = stringValue(claim.page_id);
  assertOpenWikiId(page_id, "page");
  const normalized: ClaimRecord = {
    id,
    uri: claim.uri ?? idToUri(id),
    type: "claim",
    text: stringValue(claim.text),
    page_id,
    source_ids: Array.isArray(claim.source_ids) ? claim.source_ids.map(String) : [],
    confidence: parseEnum(claim.confidence, ["low", "medium", "high"], "medium"),
    risk: parseEnum(claim.risk, ["low", "medium", "high"], "low"),
    status: parseEnum(claim.status, ["active", "stale", "disputed", "archived"], "active"),
  };
  if (claim.last_verified_at) {
    normalized.last_verified_at = claim.last_verified_at;
  }
  return normalized;
}

const FACT_STATUSES = ["active", "stale", "disputed", "forgotten", "archived"] as const;
const TAKE_STATUSES = ["open", "resolved", "archived"] as const;
const TAKE_RESOLUTIONS = ["correct", "incorrect", "partial", "unresolvable"] as const;

export function normalizeFact(fact: Partial<FactRecord>): FactRecord {
  const id = stringValue(fact.id);
  assertOpenWikiId(id, "fact");
  const subjectIds = normalizeStringArray(fact.subject_ids);
  subjectIds.forEach((subjectId) => assertOpenWikiId(subjectId));
  const pageIds = normalizeStringArray(fact.page_ids);
  pageIds.forEach((pageIdValue) => assertOpenWikiId(pageIdValue, "page"));
  const sourceIds = normalizeStringArray(fact.source_ids);
  sourceIds.forEach((sourceId) => assertOpenWikiId(sourceId, "source"));
  const claimIds = normalizeStringArray(fact.claim_ids);
  claimIds.forEach((claimId) => assertOpenWikiId(claimId, "claim"));
  const createdAt = stringValue(fact.created_at, isoNow());
  return {
    id,
    uri: fact.uri ?? idToUri(id),
    type: "fact",
    kind: stringValue(fact.kind, "note"),
    text: stringValue(fact.text),
    subject_ids: subjectIds,
    page_ids: pageIds,
    source_ids: sourceIds,
    claim_ids: claimIds,
    confidence: parseEnum(fact.confidence, ["low", "medium", "high"], "medium"),
    sensitivity: parseEnum(fact.sensitivity, ["public", "internal", "private"], "internal"),
    status: parseEnum(fact.status, FACT_STATUSES, "active") as FactStatus,
    ...(typeof fact.valid_from === "string" && fact.valid_from.trim() ? { valid_from: fact.valid_from } : {}),
    ...(typeof fact.valid_to === "string" && fact.valid_to.trim() ? { valid_to: fact.valid_to } : {}),
    created_at: createdAt,
    updated_at: stringValue(fact.updated_at, createdAt),
    path: stringValue(fact.path, "facts/facts.jsonl"),
  };
}

export function normalizeTake(take: Partial<TakeRecord>): TakeRecord {
  const id = stringValue(take.id);
  assertOpenWikiId(id, "take");
  const pageIds = normalizeStringArray(take.page_ids);
  pageIds.forEach((pageIdValue) => assertOpenWikiId(pageIdValue, "page"));
  const sourceIds = normalizeStringArray(take.source_ids);
  sourceIds.forEach((sourceId) => assertOpenWikiId(sourceId, "source"));
  const claimIds = normalizeStringArray(take.claim_ids);
  claimIds.forEach((claimId) => assertOpenWikiId(claimId, "claim"));
  const createdAt = stringValue(take.created_at, isoNow());
  const probability = boundedProbability(take.probability);
  const resolution = parseOptionalTakeResolution(take.resolution);
  const normalized: TakeRecord = {
    id,
    uri: take.uri ?? idToUri(id),
    type: "take",
    statement: stringValue(take.statement),
    rationale: stringValue(take.rationale, ""),
    probability,
    confidence: parseEnum(take.confidence, ["low", "medium", "high"], "medium"),
    status: parseEnum(take.status, TAKE_STATUSES, resolution === undefined ? "open" : "resolved") as TakeStatus,
    ...(typeof take.due_at === "string" && take.due_at.trim() ? { due_at: take.due_at } : {}),
    ...(typeof take.resolved_at === "string" && take.resolved_at.trim() ? { resolved_at: take.resolved_at } : {}),
    ...(resolution === undefined ? {} : { resolution }),
    page_ids: pageIds,
    source_ids: sourceIds,
    claim_ids: claimIds,
    created_at: createdAt,
    updated_at: stringValue(take.updated_at, take.resolved_at ?? createdAt),
    path: stringValue(take.path, "takes/takes.jsonl"),
  };
  const score = typeof take.score === "number" && Number.isFinite(take.score) ? take.score : takeScore(probability, resolution);
  if (score !== undefined) {
    normalized.score = score;
  }
  return normalized;
}

function boundedProbability(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return 0.5;
  }
  return Math.min(Math.max(numeric, 0), 1);
}

function parseOptionalTakeResolution(value: unknown): TakeResolution | undefined {
  return TAKE_RESOLUTIONS.includes(value as TakeResolution) ? (value as TakeResolution) : undefined;
}

function takeScore(probability: number, resolution: TakeResolution | undefined): number | undefined {
  if (resolution === undefined || resolution === "unresolvable") {
    return undefined;
  }
  const outcome = resolution === "correct" ? 1 : resolution === "partial" ? 0.5 : 0;
  return Number(((probability - outcome) ** 2).toFixed(6));
}

const INBOX_STATUSES = ["received", "queued", "processing", "proposed", "applied", "ignored", "failed", "superseded"] as const;

export function normalizeInboxItem(item: Partial<InboxItemRecord>): InboxItemRecord {
  const id = stringValue(item.id);
  assertOpenWikiId(id, "inbox");
  const normalized: InboxItemRecord = {
    id,
    uri: item.uri ?? idToUri(id),
    type: "inbox",
    title: stringValue(item.title, "Untitled inbox item"),
    inbox_kind: stringValue(item.inbox_kind, "note"),
    provider: stringValue(item.provider, "manual"),
    status: parseEnum(item.status, INBOX_STATUSES, "received") as InboxItemStatus,
    received_at: stringValue(item.received_at, isoNow()),
    updated_at: stringValue(item.updated_at, item.received_at ?? isoNow()),
    idempotency_key: stringValue(item.idempotency_key, id),
    path: stringValue(item.path, "inbox/items.jsonl"),
  };
  if (typeof item.adapter === "string" && item.adapter.trim()) {
    normalized.adapter = item.adapter;
  }
  if (typeof item.owner_actor_id === "string" && item.owner_actor_id.trim()) {
    assertOpenWikiId(item.owner_actor_id, "actor");
    normalized.owner_actor_id = item.owner_actor_id;
  }
  if (typeof item.submitted_by === "string" && item.submitted_by.trim()) {
    assertOpenWikiId(item.submitted_by, "actor");
    normalized.submitted_by = item.submitted_by;
  }
  if (typeof item.target_space_id === "string" && item.target_space_id.trim()) {
    normalized.target_space_id = item.target_space_id;
  }
  if (typeof item.target_path === "string" && item.target_path.trim()) {
    normalized.target_path = item.target_path;
  }
  if (typeof item.external_id === "string" && item.external_id.trim()) {
    normalized.external_id = item.external_id;
  }
  if (typeof item.origin === "string" && item.origin.trim()) {
    normalized.origin = item.origin;
  }
  if (typeof item.source_url === "string" && item.source_url.trim()) {
    normalized.source_url = item.source_url;
  }
  if (typeof item.content_hash === "string" && item.content_hash.trim()) {
    normalized.content_hash = item.content_hash;
  }
  const payload = normalizeInboxPayload(item.payload);
  if (payload !== undefined) {
    normalized.payload = payload;
  }
  const sourceIds = normalizeStringArray(item.source_ids);
  if (sourceIds.length > 0) {
    sourceIds.forEach((sourceId) => assertOpenWikiId(sourceId, "source"));
    normalized.source_ids = sourceIds;
  }
  const proposalIds = normalizeStringArray(item.proposal_ids);
  if (proposalIds.length > 0) {
    proposalIds.forEach((proposalId) => assertOpenWikiId(proposalId, "proposal"));
    normalized.proposal_ids = proposalIds;
  }
  const pageIds = normalizeStringArray(item.page_ids);
  if (pageIds.length > 0) {
    pageIds.forEach((pageIdValue) => assertOpenWikiId(pageIdValue, "page"));
    normalized.page_ids = pageIds;
  }
  const eventIds = normalizeStringArray(item.event_ids);
  if (eventIds.length > 0) {
    eventIds.forEach((eventId) => assertOpenWikiId(eventId, "event"));
    normalized.event_ids = eventIds;
  }
  const runIds = normalizeStringArray(item.run_ids);
  if (runIds.length > 0) {
    runIds.forEach((runId) => assertOpenWikiId(runId, "run"));
    normalized.run_ids = runIds;
  }
  const gitCommits = normalizeStringArray(item.git_commits);
  if (gitCommits.length > 0) {
    normalized.git_commits = gitCommits;
  }
  if (item.sensitivity === "public" || item.sensitivity === "internal" || item.sensitivity === "private") {
    normalized.sensitivity = item.sensitivity;
  }
  const processing = normalizeInboxProcessing(item.processing);
  if (processing !== undefined) {
    normalized.processing = processing;
  }
  if (item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)) {
    normalized.metadata = item.metadata;
  }
  if (item.validation_report && typeof item.validation_report === "object" && !Array.isArray(item.validation_report)) {
    normalized.validation_report = item.validation_report;
  }
  return normalized;
}

function normalizeInboxPayload(value: unknown): InboxItemPayloadReference | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind === "object" ? "object" : record.kind === "git" ? "git" : undefined;
  const pathValue = typeof record.path === "string" && record.path.trim() ? record.path : undefined;
  if (kind === undefined || pathValue === undefined) {
    return undefined;
  }
  const payload: InboxItemPayloadReference = { kind, path: pathValue };
  if (typeof record.media_type === "string" && record.media_type.trim()) {
    payload.media_type = record.media_type;
  }
  if (typeof record.bytes === "number" && Number.isFinite(record.bytes) && record.bytes >= 0) {
    payload.bytes = record.bytes;
  }
  if (typeof record.content_hash === "string" && record.content_hash.trim()) {
    payload.content_hash = record.content_hash;
  }
  if (typeof record.backend === "string" && record.backend.trim()) {
    payload.backend = record.backend;
  }
  return payload;
}

function normalizeInboxProcessing(value: unknown): InboxItemProcessingState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const processing: InboxItemProcessingState = {};
  if (typeof record.ignored_reason === "string" && record.ignored_reason.trim()) {
    processing.ignored_reason = record.ignored_reason;
  }
  if (typeof record.error === "string" && record.error.trim()) {
    processing.error = record.error;
  }
  if (isInboxProcessingFailureCategory(record.failure_category)) {
    processing.failure_category = record.failure_category;
  }
  if (typeof record.next_action === "string" && record.next_action.trim()) {
    processing.next_action = record.next_action;
  }
  if (typeof record.retryable === "boolean") {
    processing.retryable = record.retryable;
  }
  if (typeof record.next_retry_at === "string" && record.next_retry_at.trim()) {
    processing.next_retry_at = record.next_retry_at;
  }
  if (typeof record.retry_count === "number" && Number.isInteger(record.retry_count) && record.retry_count >= 0) {
    processing.retry_count = record.retry_count;
  }
  if (typeof record.attempt_count === "number" && Number.isInteger(record.attempt_count) && record.attempt_count >= 0) {
    processing.attempt_count = record.attempt_count;
  }
  if (typeof record.last_processed_at === "string" && record.last_processed_at.trim()) {
    processing.last_processed_at = record.last_processed_at;
  }
  if (typeof record.processor === "string" && record.processor.trim()) {
    processing.processor = record.processor;
  }
  if (typeof record.run_id === "string" && record.run_id.trim()) {
    assertOpenWikiId(record.run_id, "run");
    processing.run_id = record.run_id;
  }
  return Object.keys(processing).length === 0 ? undefined : processing;
}

function isInboxProcessingFailureCategory(value: unknown): value is NonNullable<InboxItemProcessingState["failure_category"]> {
  return (
    value === "duplicate" ||
    value === "validation_failed" ||
    value === "payload_unavailable" ||
    value === "permission_denied" ||
    value === "provider_unavailable" ||
    value === "provider_timeout" ||
    value === "proposal_validation_failed" ||
    value === "sync_failed" ||
    value === "unknown_internal_error"
  );
}

export function normalizeProposal(repoPath: string, proposal: Frontmatter): ProposalRecord {
  const id = stringValue(proposal.id);
  assertOpenWikiId(id, "proposal");
  const actor_id = stringValue(proposal.actor_id);
  assertOpenWikiId(actor_id, "actor");
  const diff = objectValue(proposal.diff);
  const normalized: ProposalRecord = {
    id,
    uri: stringValue(proposal.uri, idToUri(id)),
    type: "proposal",
    title: stringValue(proposal.title),
    status: parseEnum(proposal.status, ["open", "accepted", "rejected", "applied", "closed"], "open") as ProposalStatus,
    actor_id,
    target_ids: stringArrayValue(proposal.target_ids),
    diff: {
      format: "unified",
      path: stringValue(diff.path),
    },
    created_at: stringValue(proposal.created_at, isoNow()),
    path: repoPath,
  };
  if (typeof proposal.base_commit === "string" && proposal.base_commit.trim()) {
    normalized.base_commit = proposal.base_commit;
  }
  if (typeof proposal.target_path === "string" && proposal.target_path.trim()) {
    normalized.target_path = proposal.target_path;
  }
  if (typeof proposal.validation_report_path === "string" && proposal.validation_report_path.trim()) {
    normalized.validation_report_path = proposal.validation_report_path;
  }
  if (typeof proposal.snapshot_path === "string" && proposal.snapshot_path.trim()) {
    normalized.snapshot_path = proposal.snapshot_path;
  }
  if (proposal.snapshot_paths && typeof proposal.snapshot_paths === "object" && !Array.isArray(proposal.snapshot_paths)) {
    const snapshotPaths = Object.fromEntries(
      Object.entries(proposal.snapshot_paths)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
        .map(([key, value]) => [key, value]),
    );
    if (Object.keys(snapshotPaths).length > 0) {
      normalized.snapshot_paths = snapshotPaths;
    }
  }
  if (typeof proposal.rationale === "string" && proposal.rationale.trim()) {
    normalized.rationale = proposal.rationale;
  }
  if (typeof proposal.applied_at === "string" && proposal.applied_at.trim()) {
    normalized.applied_at = proposal.applied_at;
  }
  if (typeof proposal.applied_commit === "string" && proposal.applied_commit.trim()) {
    normalized.applied_commit = proposal.applied_commit;
  }
  if (typeof proposal.closed_at === "string" && proposal.closed_at.trim()) {
    normalized.closed_at = proposal.closed_at;
  }
  if (typeof proposal.closed_by === "string" && proposal.closed_by.trim()) {
    assertOpenWikiId(proposal.closed_by, "actor");
    normalized.closed_by = proposal.closed_by;
  }
  if (typeof proposal.close_resolution === "string" && proposal.close_resolution.trim()) {
    normalized.close_resolution = parseEnum(
      proposal.close_resolution,
      ["closed", "superseded", "withdrawn", "duplicate", "stale", "invalid"],
      "closed",
    ) as ProposalCloseResolution;
  }
  if (typeof proposal.close_rationale === "string" && proposal.close_rationale.trim()) {
    normalized.close_rationale = proposal.close_rationale;
  }
  if (typeof proposal.superseded_by === "string" && proposal.superseded_by.trim()) {
    assertOpenWikiId(proposal.superseded_by, "proposal");
    normalized.superseded_by = proposal.superseded_by;
  }
  return normalized;
}

export function normalizeProposalComment(comment: Partial<ProposalCommentRecord>): ProposalCommentRecord {
  const id = stringValue(comment.id);
  assertOpenWikiId(id, "comment");
  const proposal_id = stringValue(comment.proposal_id);
  assertOpenWikiId(proposal_id, "proposal");
  const actor_id = stringValue(comment.actor_id);
  assertOpenWikiId(actor_id, "actor");
  return {
    id,
    uri: comment.uri ?? idToUri(id),
    type: "comment",
    proposal_id,
    actor_id,
    body: stringValue(comment.body),
    created_at: stringValue(comment.created_at, isoNow()),
    path: stringValue(comment.path, "proposals/comments.jsonl"),
  };
}

export function normalizeDecision(repoPath: string, decision: Frontmatter): DecisionRecord {
  const id = stringValue(decision.id);
  assertOpenWikiId(id, "decision");
  const proposal_id = stringValue(decision.proposal_id);
  assertOpenWikiId(proposal_id, "proposal");
  const actor_id = stringValue(decision.actor_id);
  assertOpenWikiId(actor_id, "actor");
  const normalized: DecisionRecord = {
    id,
    uri: stringValue(decision.uri, idToUri(id)),
    type: "decision",
    proposal_id,
    decision: parseEnum(decision.decision, ["accepted", "rejected", "needs_changes"], "needs_changes") as DecisionValue,
    actor_id,
    rationale: stringValue(decision.rationale, ""),
    decided_at: stringValue(decision.decided_at, isoNow()),
    path: repoPath,
  };
  if (typeof decision.commit === "string" && decision.commit.trim()) {
    normalized.commit = decision.commit;
  }
  return normalized;
}

export function normalizeEvent(event: Partial<EventRecord>): EventRecord {
  const id = stringValue(event.id);
  assertOpenWikiId(id, "event");
  const normalized: EventRecord = {
    id,
    uri: event.uri ?? idToUri(id),
    type: stringValue(event.type),
    workspace_id: stringValue(event.workspace_id),
    occurred_at: stringValue(event.occurred_at, isoNow()),
    path: stringValue(event.path, "events/events.jsonl"),
  };
  if (event.actor_id) {
    assertOpenWikiId(event.actor_id, "actor");
    normalized.actor_id = event.actor_id;
  }
  if (event.operation) {
    normalized.operation = event.operation;
  }
  if (event.record_id) {
    normalized.record_id = event.record_id;
  }
  if (event.record_type) {
    normalized.record_type = event.record_type;
  }
  if (event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
    normalized.data = event.data;
  }
  const subjectIds = normalizeStringArray(event.subject_ids);
  if (subjectIds.length > 0) {
    normalized.subject_ids = subjectIds;
  }
  const subjectPaths = normalizeStringArray(event.subject_paths);
  if (subjectPaths.length > 0) {
    normalized.subject_paths = subjectPaths;
  }
  if (event.sensitivity === "public" || event.sensitivity === "internal" || event.sensitivity === "private") {
    normalized.sensitivity = event.sensitivity;
  }
  return normalized;
}

export function normalizeRun(run: Partial<RunRecord>): RunRecord {
  const id = stringValue(run.id);
  assertOpenWikiId(id, "run");
  const actor_id = stringValue(run.actor_id, "actor:system:openwiki");
  assertOpenWikiId(actor_id, "actor");
  const workspace_id = stringValue(run.workspace_id);
  assertOpenWikiId(workspace_id, "workspace");
  const normalized: RunRecord = {
    id,
    uri: run.uri ?? idToUri(id),
    type: "run",
    run_type: stringValue(run.run_type),
    status: parseEnum(run.status, ["queued", "running", "succeeded", "failed"], "queued"),
    actor_id,
    workspace_id,
    created_at: stringValue(run.created_at, isoNow()),
    path: stringValue(run.path, "runs/runs.jsonl"),
  };
  if (run.started_at) {
    normalized.started_at = run.started_at;
  }
  if (run.completed_at) {
    normalized.completed_at = run.completed_at;
  }
  if (run.input && typeof run.input === "object" && !Array.isArray(run.input)) {
    normalized.input = run.input;
  }
  if (run.output && typeof run.output === "object" && !Array.isArray(run.output)) {
    normalized.output = run.output;
  }
  if (run.error) {
    normalized.error = run.error;
  }
  const subjectIds = normalizeStringArray(run.subject_ids);
  if (subjectIds.length > 0) {
    normalized.subject_ids = subjectIds;
  }
  const subjectPaths = normalizeStringArray(run.subject_paths);
  if (subjectPaths.length > 0) {
    normalized.subject_paths = subjectPaths;
  }
  if (run.sensitivity === "public" || run.sensitivity === "internal" || run.sensitivity === "private") {
    normalized.sensitivity = run.sensitivity;
  }
  return normalized;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? uniqueStrings(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0), { omitEmpty: true }) : [];
}
