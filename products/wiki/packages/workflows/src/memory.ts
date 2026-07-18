import path from "node:path";
import { rm } from "node:fs/promises";
import {
  assertOpenWikiId,
  idToUri,
  isoNow,
  OpenWikiPolicyDeniedError,
  uniqueStrings,
  type FactRecord,
  type ProposalRecord,
  type TakeRecord,
  type ValidationIssue,
  type ValidationReport,
} from "@openwiki/core";
import { canReadFactRecord, canReadTakeRecord, visibleRepositoryView, type PolicyContext } from "@openwiki/policy";
import { appendEvent, loadRepository, normalizeFact, normalizeTake } from "@openwiki/repo";
import { searchWiki } from "@openwiki/search";
import { rebuildDerivedIndexes } from "./derived-indexes.ts";
import { currentGitCommit } from "./git.ts";
import { dateSequenceId, nextDailySequence, renderProposalYaml, unifiedDiff } from "./format.ts";
import { writeText } from "./io.ts";
import { withWriteCoordination } from "./write-coordinator.ts";
import type {
  FindTrajectoryInput,
  FindTrajectoryResult,
  ForgetFactInput,
  ForgetFactResult,
  ListFactsInput,
  ListFactsResult,
  ListTakesInput,
  ListTakesResult,
  ProposeFactInput,
  ProposeFactResult,
  ProposeTakeInput,
  ProposeTakeResult,
  ReadFactInput,
  ReadFactResult,
  ReadTakeInput,
  ReadTakeResult,
  RecallWikiInput,
  RecallWikiResult,
  ResolveTakeInput,
  ResolveTakeResult,
  TakesScorecardInput,
  TakesScorecardResult,
  TrajectoryItem,
} from "./memory-types.ts";

const FACTS_LEDGER_PATH = "facts/facts.jsonl";
const TAKES_LEDGER_PATH = "takes/takes.jsonl";
const DEFAULT_RECALL_TYPES = ["fact", "take", "claim", "page", "source"] as const;
const MAX_MEMORY_LIST_LIMIT = 500;

export async function recallWiki(input: RecallWikiInput): Promise<RecallWikiResult> {
  const response = await searchWiki(
    input.root,
    {
      query: input.query,
      limit: boundedMemoryLimit(input.limit, 20),
      include_explain: input.includeExplain ?? false,
      include_highlights: input.includeHighlights ?? false,
      types: input.types ?? [...DEFAULT_RECALL_TYPES],
    },
    input.policyContext === undefined ? {} : { policyContext: input.policyContext },
  );
  return {
    query: input.query,
    response,
    hot_memory: response.results
      .filter((result) => result.type === "fact" || result.type === "take")
      .slice(0, 8)
      .map((result) => ({
        id: result.id,
        type: result.type as "fact" | "take",
        title: result.title,
        ...(result.summary === undefined ? {} : { summary: result.summary }),
        updated_at: result.updated_at,
      })),
  };
}

export async function listFacts(input: ListFactsInput): Promise<ListFactsResult> {
  const repo = await loadRepository(input.root);
  const visibleFacts = input.policyContext === undefined
    ? repo.facts
    : visibleRepositoryView(repo, input.policyContext).facts;
  const facts = visibleFacts
    .filter((fact) => stringFilterAllows(fact.status, input.statuses))
    .filter((fact) => stringFilterAllows(fact.kind, input.kinds))
    .filter((fact) => intersectsAll(fact.subject_ids, input.subjectIds))
    .filter((fact) => intersectsAll(fact.page_ids, input.pageIds))
    .filter((fact) => intersectsAll(fact.source_ids, input.sourceIds))
    .filter((fact) => intersectsAll(fact.claim_ids, input.claimIds))
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id));
  return { facts: facts.slice(0, boundedMemoryLimit(input.limit, 100)), total: facts.length };
}

export async function readFactWorkflow(input: ReadFactInput): Promise<ReadFactResult> {
  const repo = await loadRepository(input.root);
  const fact = repo.facts.find((candidate) => candidate.id === input.id || candidate.uri === input.id);
  if (fact === undefined || (input.policyContext !== undefined && !canReadFactRecord(repo, input.policyContext, fact))) {
    throw new Error(`Fact not found: ${input.id}`);
  }
  return { fact };
}

export async function listTakes(input: ListTakesInput): Promise<ListTakesResult> {
  const repo = await loadRepository(input.root);
  const visibleTakes = input.policyContext === undefined
    ? repo.takes
    : visibleRepositoryView(repo, input.policyContext).takes;
  const takes = visibleTakes
    .filter((take) => stringFilterAllows(take.status, input.statuses))
    .filter((take) => intersectsAll(take.page_ids, input.pageIds))
    .filter((take) => intersectsAll(take.source_ids, input.sourceIds))
    .filter((take) => intersectsAll(take.claim_ids, input.claimIds))
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id));
  return { takes: takes.slice(0, boundedMemoryLimit(input.limit, 100)), total: takes.length };
}

export async function readTakeWorkflow(input: ReadTakeInput): Promise<ReadTakeResult> {
  const repo = await loadRepository(input.root);
  const take = repo.takes.find((candidate) => candidate.id === input.id || candidate.uri === input.id);
  if (take === undefined || (input.policyContext !== undefined && !canReadTakeRecord(repo, input.policyContext, take))) {
    throw new Error(`Take not found: ${input.id}`);
  }
  return { take };
}

export async function takesScorecard(input: TakesScorecardInput): Promise<TakesScorecardResult> {
  const repo = await loadRepository(input.root);
  const takes = input.policyContext === undefined ? repo.takes : visibleRepositoryView(repo, input.policyContext).takes;
  const scored = takes.filter((take) => typeof take.score === "number" && Number.isFinite(take.score));
  const byConfidence = (["low", "medium", "high"] as const).map((confidence) => {
    const confidenceScored = scored.filter((take) => take.confidence === confidence);
    return {
      confidence,
      scored: confidenceScored.length,
      ...meanScoreField(confidenceScored),
    };
  });
  return {
    total: takes.length,
    scored: scored.length,
    open: takes.filter((take) => take.status === "open").length,
    resolved: takes.filter((take) => take.status === "resolved").length,
    archived: takes.filter((take) => take.status === "archived").length,
    unresolvable: takes.filter((take) => take.resolution === "unresolvable").length,
    ...meanScoreField(scored),
    by_confidence: byConfidence,
  };
}

export async function findTrajectory(input: FindTrajectoryInput): Promise<FindTrajectoryResult> {
  if (!input.id && !input.query?.trim()) {
    throw new Error("findTrajectory requires id or query");
  }
  const repo = await loadRepository(input.root);
  const visible = input.policyContext === undefined ? repo : visibleRepositoryView(repo, input.policyContext);
  const matchedIds = input.id === undefined
    ? await matchedIdsForTrajectoryQuery(input)
    : [input.id];
  const matchedIdSet = new Set(matchedIds);
  const items: TrajectoryItem[] = [];

  for (const fact of visible.facts) {
    const relation = relationForRefs(fact.id, [...fact.subject_ids, ...fact.page_ids, ...fact.source_ids, ...fact.claim_ids], matchedIdSet);
    if (relation !== undefined || textMatchesQuery(fact.text, input.query)) {
      items.push({
        id: fact.id,
        type: "fact",
        title: fact.text,
        path: fact.path,
        at: fact.valid_from ?? fact.created_at,
        relation: relation ?? "query_match",
      });
    }
  }
  for (const take of visible.takes) {
    const relation = relationForRefs(take.id, [...take.page_ids, ...take.source_ids, ...take.claim_ids], matchedIdSet);
    if (relation !== undefined || textMatchesQuery(`${take.statement}\n${take.rationale}`, input.query)) {
      items.push({
        id: take.id,
        type: "take",
        title: take.statement,
        summary: take.resolution === undefined ? `${take.status}; p=${take.probability}` : `${take.resolution}; p=${take.probability}`,
        path: take.path,
        at: take.resolved_at ?? take.due_at ?? take.created_at,
        relation: relation ?? "query_match",
      });
    }
  }
  for (const claim of visible.claims) {
    const relation = relationForRefs(claim.id, [claim.page_id, ...claim.source_ids], matchedIdSet);
    if (relation !== undefined || textMatchesQuery(claim.text, input.query)) {
      items.push({
        id: claim.id,
        type: "claim",
        title: claim.text,
        at: claim.last_verified_at ?? "",
        relation: relation ?? "query_match",
      });
    }
  }
  for (const proposal of visible.proposals) {
    const relation = relationForRefs(proposal.id, proposal.target_ids, matchedIdSet);
    if (relation !== undefined || textMatchesQuery(`${proposal.title}\n${proposal.rationale ?? ""}`, input.query)) {
      items.push({
        id: proposal.id,
        type: "proposal",
        title: proposal.title,
        path: proposal.path,
        at: proposal.applied_at ?? proposal.closed_at ?? proposal.created_at,
        relation: relation ?? "query_match",
      });
    }
  }
  for (const event of visible.events) {
    const relation = relationForRefs(event.id, [event.record_id, ...(event.subject_ids ?? [])].filter((value): value is string => value !== undefined), matchedIdSet);
    if (relation !== undefined || textMatchesQuery(`${event.type}\n${event.operation ?? ""}`, input.query)) {
      items.push({
        id: event.id,
        type: "event",
        title: event.type,
        path: event.path,
        at: event.occurred_at,
        relation: relation ?? "query_match",
      });
    }
  }

  const order = input.order ?? "asc";
  items.sort((left, right) => {
    const byTime = left.at.localeCompare(right.at);
    return order === "asc" ? byTime || left.id.localeCompare(right.id) : -byTime || left.id.localeCompare(right.id);
  });
  return {
    input: {
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(input.query === undefined ? {} : { query: input.query }),
    },
    matched_record_ids: matchedIds,
    items: items.slice(0, boundedMemoryLimit(input.limit, 100)),
    total: items.length,
  };
}

export async function proposeFact(input: ProposeFactInput): Promise<ProposeFactResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.propose_fact",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: { text: input.text.slice(0, 120) },
    },
    async () => {
      const repo = await loadRepository(input.root);
      const now = isoNow();
      const actorId = input.actorId ?? "actor:user:local";
      assertOpenWikiId(actorId, "actor");
      const fact = normalizeFact({
        id: input.id ?? dateSequenceId("fact", now, nextDailySequence(repo.facts.map((record) => record.id), "fact", now)),
        type: "fact",
        text: input.text,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.subjectIds === undefined ? {} : { subject_ids: input.subjectIds }),
        ...(input.pageIds === undefined ? {} : { page_ids: input.pageIds }),
        ...(input.sourceIds === undefined ? {} : { source_ids: input.sourceIds }),
        ...(input.claimIds === undefined ? {} : { claim_ids: input.claimIds }),
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        ...(input.sensitivity === undefined ? {} : { sensitivity: input.sensitivity }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.validFrom === undefined ? {} : { valid_from: input.validFrom }),
        ...(input.validTo === undefined ? {} : { valid_to: input.validTo }),
        created_at: now,
        updated_at: now,
        path: FACTS_LEDGER_PATH,
      });
      assertCanProposeFactLedgerChange(repo, input.policyContext, fact);
      const validation = validateFactProposal(fact, repo, undefined, now);
      const nextFacts = [...repo.facts, fact].sort(compareRecordIds);
      const proposal = await writeMemoryProposal({
        root: repo.root,
        actorId,
        now,
        operation: "wiki.propose_fact",
        title: `Record fact: ${truncateTitle(fact.text)}`,
        targetId: fact.id,
        ledgerPath: FACTS_LEDGER_PATH,
        oldJsonl: jsonl(repo.facts),
        newJsonl: jsonl(nextFacts),
        validation,
        ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
      });
      return { proposal: proposal.proposal, fact, validation: proposal.validation, diff: proposal.diff };
    },
  );
}

export async function proposeTake(input: ProposeTakeInput): Promise<ProposeTakeResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.propose_take",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: { statement: input.statement.slice(0, 120) },
    },
    async () => {
      const repo = await loadRepository(input.root);
      const now = isoNow();
      const actorId = input.actorId ?? "actor:user:local";
      assertOpenWikiId(actorId, "actor");
      const take = normalizeTake({
        id: input.id ?? dateSequenceId("take", now, nextDailySequence(repo.takes.map((record) => record.id), "take", now)),
        type: "take",
        statement: input.statement,
        ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
        ...(input.probability === undefined ? {} : { probability: input.probability }),
        ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.dueAt === undefined ? {} : { due_at: input.dueAt }),
        ...(input.pageIds === undefined ? {} : { page_ids: input.pageIds }),
        ...(input.sourceIds === undefined ? {} : { source_ids: input.sourceIds }),
        ...(input.claimIds === undefined ? {} : { claim_ids: input.claimIds }),
        created_at: now,
        updated_at: now,
        path: TAKES_LEDGER_PATH,
      });
      assertCanProposeTakeLedgerChange(repo, input.policyContext, take);
      const validation = validateTakeProposal(take, repo, undefined, now);
      const nextTakes = [...repo.takes, take].sort(compareRecordIds);
      const proposal = await writeMemoryProposal({
        root: repo.root,
        actorId,
        now,
        operation: "wiki.propose_take",
        title: `Record take: ${truncateTitle(take.statement)}`,
        targetId: take.id,
        ledgerPath: TAKES_LEDGER_PATH,
        oldJsonl: jsonl(repo.takes),
        newJsonl: jsonl(nextTakes),
        validation,
        ...(input.proposalRationale === undefined ? {} : { rationale: input.proposalRationale }),
      });
      return { proposal: proposal.proposal, take, validation: proposal.validation, diff: proposal.diff };
    },
  );
}

export async function resolveTake(input: ResolveTakeInput): Promise<ResolveTakeResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.resolve_take",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: { take_id: input.id, resolution: input.resolution },
    },
    async () => {
      const repo = await loadRepository(input.root);
      const existing = repo.takes.find((candidate) => candidate.id === input.id || candidate.uri === input.id);
      if (existing === undefined) {
        throw new Error(`Take not found: ${input.id}`);
      }
      assertCanProposeTakeLedgerChange(repo, input.policyContext, existing);
      const now = isoNow();
      const actorId = input.actorId ?? "actor:user:local";
      assertOpenWikiId(actorId, "actor");
      const take = normalizeTake({
        ...existing,
        status: "resolved",
        resolution: input.resolution,
        resolved_at: input.resolvedAt ?? now,
        updated_at: now,
      });
      assertCanProposeTakeLedgerChange(repo, input.policyContext, take);
      const validation = validateTakeProposal(take, repo, existing, now);
      const nextTakes = repo.takes.map((candidate) => candidate.id === existing.id ? take : candidate).sort(compareRecordIds);
      const proposal = await writeMemoryProposal({
        root: repo.root,
        actorId,
        now,
        operation: "wiki.resolve_take",
        title: `Resolve take: ${truncateTitle(take.statement)}`,
        targetId: take.id,
        ledgerPath: TAKES_LEDGER_PATH,
        oldJsonl: jsonl(repo.takes),
        newJsonl: jsonl(nextTakes),
        validation,
        ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
      });
      return { proposal: proposal.proposal, take, validation: proposal.validation, diff: proposal.diff };
    },
  );
}

export async function forgetFact(input: ForgetFactInput): Promise<ForgetFactResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.forget_fact",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: { fact_id: input.id },
    },
    async () => {
      const repo = await loadRepository(input.root);
      const existing = repo.facts.find((candidate) => candidate.id === input.id || candidate.uri === input.id);
      if (existing === undefined) {
        throw new Error(`Fact not found: ${input.id}`);
      }
      assertCanProposeFactLedgerChange(repo, input.policyContext, existing);
      const now = isoNow();
      const actorId = input.actorId ?? "actor:user:local";
      assertOpenWikiId(actorId, "actor");
      const fact = normalizeFact({
        ...existing,
        status: "forgotten",
        valid_to: input.validTo ?? now,
        updated_at: now,
      });
      assertCanProposeFactLedgerChange(repo, input.policyContext, fact, { allowForgottenTarget: true });
      const validation = validateFactProposal(fact, repo, existing, now);
      const nextFacts = repo.facts.map((candidate) => candidate.id === existing.id ? fact : candidate).sort(compareRecordIds);
      const proposal = await writeMemoryProposal({
        root: repo.root,
        actorId,
        now,
        operation: "wiki.forget_fact",
        title: `Forget fact: ${truncateTitle(fact.text)}`,
        targetId: fact.id,
        ledgerPath: FACTS_LEDGER_PATH,
        oldJsonl: jsonl(repo.facts),
        newJsonl: jsonl(nextFacts),
        validation,
        rationale: input.rationale ?? "Mark the fact forgotten in the canonical facts ledger. This does not rewrite Git history or purge external copies.",
      });
      return { proposal: proposal.proposal, fact, validation: proposal.validation, diff: proposal.diff };
    },
  );
}

interface MemoryProposalInput {
  root: string;
  actorId: string;
  now: string;
  operation: "wiki.propose_fact" | "wiki.propose_take" | "wiki.resolve_take" | "wiki.forget_fact";
  title: string;
  targetId: string;
  ledgerPath: typeof FACTS_LEDGER_PATH | typeof TAKES_LEDGER_PATH;
  oldJsonl: string;
  newJsonl: string;
  validation: ValidationReport;
  rationale?: string;
}

async function writeMemoryProposal(input: MemoryProposalInput): Promise<{ proposal: ProposalRecord; validation: ValidationReport; diff: string }> {
  const repo = await loadRepository(input.root);
  const sequence = nextDailySequence(repo.proposals.map((proposal) => proposal.id), "proposal", input.now);
  const proposalId = dateSequenceId("proposal", input.now, sequence);
  const proposalStem = proposalId.replace(/:/g, "_").replace(/-/g, "_");
  const proposalPath = `proposals/${proposalStem}.yaml`;
  const diffPath = `proposals/diffs/${proposalStem}.diff`;
  const reportPath = `proposals/reports/${proposalStem}.json`;
  const snapshotPath = `proposals/snapshots/${proposalStem}/${path.basename(input.ledgerPath)}`;
  const diff = unifiedDiff(input.ledgerPath, input.oldJsonl, input.newJsonl);
  const validation: ValidationReport = {
    ...input.validation,
    id: `${proposalId}:validation`,
    proposal_id: proposalId,
  };
  const proposal: ProposalRecord = {
    id: proposalId,
    uri: idToUri(proposalId),
    type: "proposal",
    title: input.title,
    status: "open",
    actor_id: input.actorId,
    target_ids: [input.targetId],
    target_path: input.ledgerPath,
    diff: { format: "unified", path: diffPath },
    snapshot_path: snapshotPath,
    validation_report_path: reportPath,
    created_at: input.now,
    path: proposalPath,
  };
  const baseCommit = await currentGitCommit(repo.root);
  if (baseCommit !== undefined) {
    proposal.base_commit = baseCommit;
  }
  if (input.rationale !== undefined) {
    proposal.rationale = input.rationale;
  }

  await writeArtifacts(repo.root, [
    { path: diffPath, body: diff },
    { path: snapshotPath, body: input.newJsonl },
    { path: reportPath, body: `${JSON.stringify(validation, null, 2)}\n` },
    { path: proposalPath, body: renderProposalYaml(proposal) },
  ]);
  await appendEvent(repo.root, {
    type: "proposal.created",
    actor_id: input.actorId,
    operation: input.operation,
    record_id: proposal.id,
    record_type: "proposal",
    occurred_at: input.now,
    subject_ids: [input.targetId],
    subject_paths: [input.ledgerPath],
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

function assertCanProposeFactLedgerChange(
  repo: Awaited<ReturnType<typeof loadRepository>>,
  context: PolicyContext | undefined,
  target: FactRecord,
  options: { allowForgottenTarget?: boolean } = {},
): void {
  if (context === undefined || canBypassLedgerVisibility(context)) {
    return;
  }
  const hiddenExisting = repo.facts.find((fact) => !canReadFactRecord(repo, context, fact));
  if (hiddenExisting !== undefined) {
    throw new OpenWikiPolicyDeniedError("Fact ledger proposal requires visibility to every existing fact record");
  }
  if (options.allowForgottenTarget === true && target.status === "forgotten") {
    const visibleBeforeForget = canReadFactRecord(repo, context, { ...target, status: "active" });
    if (!visibleBeforeForget) {
      throw new OpenWikiPolicyDeniedError("Fact ledger proposal references records outside the caller's visibility");
    }
    return;
  }
  if (!canReadFactRecord(repo, context, target)) {
    throw new OpenWikiPolicyDeniedError("Fact ledger proposal references records outside the caller's visibility");
  }
}

function assertCanProposeTakeLedgerChange(
  repo: Awaited<ReturnType<typeof loadRepository>>,
  context: PolicyContext | undefined,
  target: TakeRecord,
): void {
  if (context === undefined || canBypassLedgerVisibility(context)) {
    return;
  }
  const hiddenExisting = repo.takes.find((take) => !canReadTakeRecord(repo, context, take));
  if (hiddenExisting !== undefined) {
    throw new OpenWikiPolicyDeniedError("Take ledger proposal requires visibility to every existing take record");
  }
  if (!canReadTakeRecord(repo, context, target)) {
    throw new OpenWikiPolicyDeniedError("Take ledger proposal references records outside the caller's visibility");
  }
}

function canBypassLedgerVisibility(context: PolicyContext): boolean {
  return context.bounds === undefined && context.scopes.includes("wiki:admin");
}

function validateFactProposal(
  fact: FactRecord,
  repo: Awaited<ReturnType<typeof loadRepository>>,
  existing: FactRecord | undefined,
  checkedAt: string,
): ValidationReport {
  const issues: ValidationIssue[] = [];
  if (!fact.text.trim()) {
    issues.push({ severity: "error", code: "fact.text.empty", message: "Fact text cannot be empty.", path: fact.path });
  }
  if (existing === undefined && repo.facts.some((candidate) => candidate.id === fact.id)) {
    issues.push({ severity: "error", code: "fact.id.duplicate", message: `Fact ID '${fact.id}' already exists.`, path: fact.path });
  }
  const knownIds = knownRecordIds(repo);
  for (const subjectId of fact.subject_ids) {
    if (!knownIds.has(subjectId)) {
      issues.push({ severity: "warning", code: "fact.subject.unknown", message: `Fact subject '${subjectId}' is not present in this wiki.`, path: fact.path });
    }
  }
  pushMissingRefs(issues, fact.path, "page", fact.page_ids, new Set(repo.pages.map((page) => page.id)));
  pushMissingRefs(issues, fact.path, "source", fact.source_ids, new Set(repo.sources.map((source) => source.id)));
  pushMissingRefs(issues, fact.path, "claim", fact.claim_ids, new Set(repo.claims.map((claim) => claim.id)));
  if (fact.status === "forgotten" && fact.valid_to === undefined) {
    issues.push({ severity: "warning", code: "fact.forgotten.valid_to.missing", message: "Forgotten facts should include valid_to.", path: fact.path });
  }
  return validationReport(`${fact.id}:validation`, fact.id, checkedAt, issues);
}

function validateTakeProposal(
  take: TakeRecord,
  repo: Awaited<ReturnType<typeof loadRepository>>,
  existing: TakeRecord | undefined,
  checkedAt: string,
): ValidationReport {
  const issues: ValidationIssue[] = [];
  if (!take.statement.trim()) {
    issues.push({ severity: "error", code: "take.statement.empty", message: "Take statement cannot be empty.", path: take.path });
  }
  if (existing === undefined && repo.takes.some((candidate) => candidate.id === take.id)) {
    issues.push({ severity: "error", code: "take.id.duplicate", message: `Take ID '${take.id}' already exists.`, path: take.path });
  }
  if (take.probability < 0 || take.probability > 1) {
    issues.push({ severity: "error", code: "take.probability.range", message: "Take probability must be between 0 and 1.", path: take.path });
  }
  if (take.status === "resolved" && take.resolution === undefined) {
    issues.push({ severity: "error", code: "take.resolution.missing", message: "Resolved takes require a resolution.", path: take.path });
  }
  if (take.resolution !== undefined && take.status !== "resolved") {
    issues.push({ severity: "warning", code: "take.resolution.status", message: "Takes with a resolution should have status resolved.", path: take.path });
  }
  pushMissingRefs(issues, take.path, "page", take.page_ids, new Set(repo.pages.map((page) => page.id)));
  pushMissingRefs(issues, take.path, "source", take.source_ids, new Set(repo.sources.map((source) => source.id)));
  pushMissingRefs(issues, take.path, "claim", take.claim_ids, new Set(repo.claims.map((claim) => claim.id)));
  return validationReport(`${take.id}:validation`, take.id, checkedAt, issues);
}

function validationReport(id: string, proposalOrRecordId: string, checkedAt: string, issues: ValidationIssue[]): ValidationReport {
  return {
    id,
    proposal_id: proposalOrRecordId,
    checked_at: checkedAt,
    status: issues.some((issue) => issue.severity === "error") ? "failed" : "passed",
    issues,
  };
}

function pushMissingRefs(
  issues: ValidationIssue[],
  pathValue: string,
  kind: "page" | "source" | "claim",
  ids: string[],
  known: Set<string>,
): void {
  for (const id of ids) {
    if (!known.has(id)) {
      issues.push({
        severity: "warning",
        code: `${kind}.reference.unknown`,
        message: `${kind} reference '${id}' is not present in this wiki.`,
        path: pathValue,
      });
    }
  }
}

function knownRecordIds(repo: Awaited<ReturnType<typeof loadRepository>>): Set<string> {
  return new Set([
    ...repo.pages.map((record) => record.id),
    ...repo.sources.map((record) => record.id),
    ...repo.claims.map((record) => record.id),
    ...repo.facts.map((record) => record.id),
    ...repo.takes.map((record) => record.id),
    ...repo.proposals.map((record) => record.id),
    ...repo.decisions.map((record) => record.id),
    ...repo.events.map((record) => record.id),
    ...repo.runs.map((record) => record.id),
  ]);
}

function jsonl(records: Array<FactRecord | TakeRecord>): string {
  if (records.length === 0) {
    return "";
  }
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function writeArtifacts(root: string, artifacts: Array<{ path: string; body: string }>): Promise<void> {
  const writtenPaths: string[] = [];
  try {
    for (const artifact of artifacts) {
      await writeText(root, artifact.path, artifact.body);
      writtenPaths.push(artifact.path);
    }
  } catch (error) {
    await Promise.all(writtenPaths.map((artifactPath) => rm(path.join(root, artifactPath), { force: true }).catch(() => undefined)));
    throw error;
  }
}

async function matchedIdsForTrajectoryQuery(input: FindTrajectoryInput): Promise<string[]> {
  const query = input.query?.trim();
  if (!query) {
    return [];
  }
  const response = await searchWiki(
    input.root,
    { query, types: [...DEFAULT_RECALL_TYPES], limit: boundedMemoryLimit(input.limit, 50) },
    input.policyContext === undefined ? {} : { policyContext: input.policyContext },
  );
  return uniqueStrings(response.results.map((result) => result.id), { omitEmpty: true });
}

function relationForRefs(id: string, refs: string[], matchedIds: Set<string>): string | undefined {
  if (matchedIds.has(id)) {
    return "self";
  }
  const matchedRef = refs.find((ref) => matchedIds.has(ref));
  return matchedRef === undefined ? undefined : `references:${matchedRef}`;
}

function textMatchesQuery(text: string, query: string | undefined): boolean {
  const normalized = query?.trim().toLocaleLowerCase();
  return normalized === undefined || normalized === "" ? false : text.toLocaleLowerCase().includes(normalized);
}

function intersectsAll(values: string[], required: string[] | undefined): boolean {
  if (required === undefined || required.length === 0) {
    return true;
  }
  const set = new Set(values);
  return required.every((value) => set.has(value));
}

function stringFilterAllows<T extends string>(value: T, allowed: T[] | undefined): boolean {
  return allowed === undefined || allowed.length === 0 || allowed.includes(value);
}

function meanScoreField(takes: TakeRecord[]): { brier_score?: number } {
  if (takes.length === 0) {
    return {};
  }
  const total = takes.reduce((sum, take) => sum + (take.score ?? 0), 0);
  return { brier_score: Number((total / takes.length).toFixed(6)) };
}

function boundedMemoryLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), 0), MAX_MEMORY_LIST_LIMIT);
}

function compareRecordIds(left: { id: string }, right: { id: string }): number {
  return left.id.localeCompare(right.id);
}

function truncateTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`;
}
