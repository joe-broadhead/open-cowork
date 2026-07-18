import { createHash } from "node:crypto";
import {
  analyzeGraph,
  isoNow,
  redactOpenWikiRunRecord,
  type ProposalRecord,
  type RunRecord,
  type ValidationIssue,
} from "@openwiki/core";
import { rebuildIndexStore } from "@openwiki/index-store";
import { assertAuthorized, canReadRunRecord, type PolicyContext } from "@openwiki/policy";
import { appendEvent, graphOrphans, graphStale, listGraphEdges, loadRepository, type LoadedOpenWikiRepo } from "@openwiki/repo";
import { buildSearchIndex } from "@openwiki/search";
import { validateRepository } from "@openwiki/validation";
import { proposePageTypedLinks, suggestPageTypedLinks } from "./link-suggestions.ts";
import { runGovernanceDetectors } from "./governance.ts";
import { factCandidatesPhase, takeScoreCandidatesPhase } from "./dream-provider-candidates.ts";
import {
  assertCanProposeDreamPage,
  candidateVisibleFromPage,
  canProposeDreamPage,
  canSeePath,
  canSeeRecord,
  canSeeValidationIssue,
  dreamAggregateSubjectPaths,
  knownDreamRecord,
  visiblePages,
  visibleRepositoryCounts,
} from "./dream-cycle-visibility.ts";
import {
  DREAM_PHASE_REGISTRY,
  boundedDreamLimit,
  boundedDreamTimeout,
  parseDreamPhaseNames,
  type DreamPhaseDefinition,
  type DreamPhaseItem,
  type DreamPhaseName,
  type DreamPhaseResult,
  type DreamRunInput,
  type DreamRunOutput,
  type DreamRunReport,
} from "./dream-cycle-contract.ts";

export async function runDreamCycle(input: DreamRunInput): Promise<DreamRunOutput> {
  const repo = await loadRepository(input.root);
  const generatedAt = isoNow();
  const phaseNames = parseDreamPhaseNames(input.phases);
  const limit = boundedDreamLimit(input.maxRecords ?? input.limit);
  const createProposals = input.createProposals === true && input.dryRun !== true;
  const dryRun = createProposals ? false : true;
  const provider = input.provider?.trim();
  const context: DreamExecutionContext = {
    root: repo.root,
    workspaceId: repo.config.workspace_id,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    actorId: input.actorId ?? "actor:system:openwiki",
    generatedAt,
    limit,
    timeoutMs: boundedDreamTimeout(input.timeoutMs),
    dryRun,
    createProposals,
    providerEnabled: provider !== undefined && provider.length > 0,
    ...(provider === undefined || provider.length === 0 ? {} : { provider }),
    ...(input.schemaPack === undefined ? {} : { schemaPack: input.schemaPack }),
    ...(input.policyContext === undefined ? {} : { policyContext: input.policyContext }),
    phaseResults: [],
  };

  if (input.policyContext !== undefined) {
    assertAuthorized("wiki.dream_run", input.policyContext);
    if (createProposals) {
      assertAuthorized("wiki.propose_edit", input.policyContext);
    }
  }

  await appendDreamLifecycleEvent(context, "dream.started", { phases: phaseNames, dry_run: dryRun, create_proposals: createProposals });
  for (const phaseName of phaseNames) {
    await appendDreamLifecycleEvent(context, "dream.phase.started", { phase: phaseName });
    const result = await runDreamPhase(context, phaseName);
    context.phaseResults.push(result);
    await appendDreamPhaseEvent(context, result);
  }

  const report = dreamRunReport(context.phaseResults, generatedAt);
  const phaseSubjectPaths = uniqueStrings(context.phaseResults.flatMap((phase) => phase.subject_paths));
  const outputSubjectPaths = uniqueStrings([...dreamAggregateSubjectPaths(context, repo), ...phaseSubjectPaths]);
  const output: DreamRunOutput = {
    schema_version: "openwiki-dream-run-v1",
    ...(input.runId === undefined ? {} : { run_id: input.runId }),
    workspace_id: repo.config.workspace_id,
    generated_at: generatedAt,
    dry_run: dryRun,
    create_proposals: createProposals,
    provider_enabled: context.providerEnabled,
    ...(context.provider === undefined ? {} : { provider: context.provider }),
    ...(context.schemaPack === undefined ? {} : { schema_pack: context.schemaPack }),
    limit,
    phases: context.phaseResults,
    proposal_ids: uniqueStrings(context.phaseResults.flatMap((phase) => phase.proposal_ids)),
    subject_ids: uniqueStrings(context.phaseResults.flatMap((phase) => phase.subject_ids)),
    subject_paths: outputSubjectPaths,
    report,
  };
  await appendDreamLifecycleEvent(context, "dream.completed", {
    status: report.status,
    phase_count: report.phase_count,
    proposal_count: report.proposal_count,
  });
  return output;
}

export async function dreamRunStatus(root: string, options: { runId?: string; limit?: number; policyContext?: PolicyContext; includeSensitiveOperationalMetadata?: boolean } = {}): Promise<{
  generated_at: string;
  run?: RunRecord;
  runs: RunRecord[];
}> {
  const repo = await loadRepository(root);
  const limit = boundedDreamLimit(options.limit);
  const runs = repo.runs
    .filter((run) => run.run_type === "dream.run")
    .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
  const visibleRuns = options.policyContext === undefined
    ? runs
    : runs
      .filter((candidate) => canReadRunRecord(repo, options.policyContext as PolicyContext, candidate))
      .map((candidate) => redactOpenWikiRunRecord(candidate, {
        ...(options.includeSensitiveOperationalMetadata === undefined ? {} : { includeSensitiveOperationalMetadata: options.includeSensitiveOperationalMetadata }),
      }));
  const run = options.runId === undefined ? undefined : visibleRuns.find((candidate) => candidate.id === options.runId || candidate.uri === options.runId);
  return {
    generated_at: isoNow(),
    ...(run === undefined ? {} : { run }),
    runs: options.runId === undefined ? visibleRuns.slice(0, limit) : run === undefined ? [] : [run],
  };
}

export async function dreamRunReportForRun(root: string, runId: string | undefined): Promise<{
  generated_at: string;
  run: RunRecord;
  report: unknown;
}> {
  const status = await dreamRunStatus(root, { ...(runId === undefined ? {} : { runId }), limit: 1 });
  const run = runId === undefined ? status.runs[0] : status.run;
  if (run === undefined) {
    throw new Error(runId === undefined ? "No dream.run records found" : `Dream run not found: ${runId}`);
  }
  const output = run.output;
  return {
    generated_at: isoNow(),
    run,
    report: output && typeof output === "object" && "report" in output ? (output as { report?: unknown }).report : output,
  };
}

interface DreamExecutionContext {
  root: string;
  workspaceId: string;
  runId?: string;
  actorId: string;
  generatedAt: string;
  limit: number;
  timeoutMs: number;
  dryRun: boolean;
  createProposals: boolean;
  providerEnabled: boolean;
  provider?: string;
  schemaPack?: string;
  policyContext?: PolicyContext;
  phaseDeadlineMs?: number;
  phaseAbortSignal?: AbortSignal;
  phaseResults: DreamPhaseResult[];
}

async function runDreamPhase(context: DreamExecutionContext, phase: DreamPhaseName): Promise<DreamPhaseResult> {
  const definition = DREAM_PHASE_REGISTRY[phase];
  const startedAt = isoNow();
  const startMs = Date.now();
  try {
    const partial = await executeDreamPhaseWithTimeout(context, phase, context.timeoutMs);
    return finalizePhaseResult(context, definition, startedAt, startMs, partial);
  } catch (error) {
    return finalizePhaseResult(context, definition, startedAt, startMs, {
      status: "failed",
      summary: `${phase} failed`,
      counts: {},
      items: [],
      proposal_ids: [],
      subject_ids: [],
      subject_paths: [],
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function executeDreamPhaseWithTimeout(
  context: DreamExecutionContext,
  phase: DreamPhaseName,
  timeoutMs: number,
): ReturnType<typeof executeDreamPhase> {
  const abortController = new AbortController();
  const phaseContext: DreamExecutionContext = { ...context, phaseDeadlineMs: Date.now() + timeoutMs, phaseAbortSignal: abortController.signal };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      executeDreamPhase(phaseContext, phase),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          reject(new Error(`Dream phase ${phase} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function executeDreamPhase(
  context: DreamExecutionContext,
  phase: DreamPhaseName,
): Promise<Omit<DreamPhaseResult, "phase" | "started_at" | "completed_at" | "duration_ms" | "idempotency_key" | "timeout_ms" | "scopes" | "may_create_proposals" | "dry_run">> {
  switch (phase) {
    case "lint":
      return lintPhase(context);
    case "index_refresh":
      return indexRefreshPhase(context);
    case "stale_claims":
      return staleClaimsPhase(context);
    case "missing_backlinks":
      return missingBacklinksPhase(context);
    case "thin_pages":
      return thinPagesPhase(context);
    case "orphan_pages":
      return orphanPagesPhase(context);
    case "link_suggestions":
      return linkSuggestionsPhase(context);
    case "fact_candidates":
      return factCandidatesPhase(context);
    case "take_score_candidates":
      return takeScoreCandidatesPhase(context);
    case "report":
      return reportPhase(context);
  }
}

async function lintPhase(context: DreamExecutionContext) {
  const report = await validateRepository(context.root);
  const repo = await repositoryForPolicy(context);
  const visibleIssues = repo === undefined ? report.issues : report.issues.filter((issue) => canSeeValidationIssue(context, repo, issue));
  const visibleCounts = repo === undefined ? report.counts : visibleRepositoryCounts(context, repo);
  return {
    status: visibleIssues.some((issue) => issue.severity === "error") ? "failed" as const : "succeeded" as const,
    summary: `Repository validation found ${visibleIssues.length} visible issue(s).`,
    counts: {
      issue_count: visibleIssues.length,
      pages: visibleCounts.pages,
      sources: visibleCounts.sources,
      claims: visibleCounts.claims,
      proposals: visibleCounts.proposals,
    },
    items: visibleIssues.slice(0, context.limit).map(validationIssueItem),
    proposal_ids: [],
    subject_ids: [],
    subject_paths: uniqueStrings(visibleIssues.flatMap((issue) => issue.path ?? []).slice(0, context.limit)),
  };
}

async function indexRefreshPhase(context: DreamExecutionContext) {
  const [search, indexStore] = await Promise.all([buildSearchIndex(context.root), rebuildIndexStore(context.root)]);
  const repo = await repositoryForPolicy(context);
  if (repo !== undefined) {
    const counts = visibleRepositoryCounts(context, repo);
    const graph = await listGraphEdges(context.root);
    const visibleEdgeCount = graph.edges.filter((edge) => canSeeRecord(context, repo, edge.from_id) && canSeeRecord(context, repo, edge.to_id)).length;
    const visibleRecordCount = counts.pages + counts.sources + counts.claims + counts.proposals;
    return {
      status: "succeeded" as const,
      summary: `Refreshed search and graph indexes; returning ${visibleRecordCount} visible records and ${visibleEdgeCount} visible edges.`,
      counts: {
        search_record_count: visibleRecordCount,
        index_store_record_count: visibleRecordCount,
        index_store_edge_count: visibleEdgeCount,
      },
      items: [],
      proposal_ids: [],
      subject_ids: [],
      subject_paths: [],
    };
  }
  return {
    status: "succeeded" as const,
    summary: `Refreshed search (${search.recordCount} records) and graph index (${indexStore.edgeCount} edges).`,
    counts: {
      search_record_count: search.recordCount,
      index_store_record_count: indexStore.recordCount,
      index_store_edge_count: indexStore.edgeCount,
    },
    items: [],
    proposal_ids: [],
    subject_ids: [],
    subject_paths: [],
  };
}

async function staleClaimsPhase(context: DreamExecutionContext) {
  const [governance, stale] = await Promise.all([
    runGovernanceDetectors({ root: context.root, detectors: ["stale_claim"] }),
    graphStale(context.root),
  ]);
  const repo = await repositoryForPolicy(context);
  const findings = repo === undefined
    ? governance.findings
    : governance.findings.filter((finding) =>
      canSeeRecord(context, repo, finding.record_id) ||
      (!knownDreamRecord(repo, finding.record_id) && finding.path !== undefined && canSeePath(context, repo, finding.path))
    );
  const staleClaims = repo === undefined ? stale.claims : stale.claims.filter((claim) => canSeeRecord(context, repo, claim.id));
  const stalePages = repo === undefined ? stale.pages : stale.pages.filter((page) => canSeeRecord(context, repo, page.id));
  const items: DreamPhaseItem[] = findings.slice(0, context.limit).map((finding) => ({
    id: finding.record_id,
    record_type: finding.record_type,
    ...(finding.path === undefined ? {} : { path: finding.path }),
    ...(finding.reasons === undefined ? {} : { reason_codes: finding.reasons }),
    ...(finding.target === undefined || (repo !== undefined && !canSeeRecord(context, repo, finding.target)) ? {} : { candidate_ids: [finding.target] }),
  }));
  return {
    status: "succeeded" as const,
    summary: `Found ${findings.length} visible stale or disputed claim finding(s).`,
    counts: {
      finding_count: findings.length,
      stale_claim_count: staleClaims.length,
      stale_page_count: stalePages.length,
    },
    items,
    proposal_ids: [],
    subject_ids: uniqueStrings(items.map((item) => item.id)),
    subject_paths: uniqueStrings(items.flatMap((item) => item.path ?? [])),
  };
}

async function missingBacklinksPhase(context: DreamExecutionContext) {
  const [repo, graph] = await Promise.all([loadRepository(context.root), listGraphEdges(context.root)]);
  const pagesForPolicy = visiblePages(context, repo);
  const pageIds = new Set(pagesForPolicy.map((page) => page.id));
  const inboundPageLinks = new Set(
    graph.edges
      .filter((edge) => edge.edge_type === "page_link" && pageIds.has(edge.to_id))
      .filter((edge) => canSeeRecord(context, repo, edge.from_id) && canSeeRecord(context, repo, edge.to_id))
      .map((edge) => edge.to_id),
  );
  const pages = pagesForPolicy
    .filter((page) => !inboundPageLinks.has(page.id))
    .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id))
    .slice(0, context.limit);
  const analysis = analyzeGraph(graph, { limit: context.limit });
  const visibleMissingLinkCount = analysis.candidate_missing_links.filter((candidate) => canSeeRecord(context, repo, candidate.from_id) && canSeeRecord(context, repo, candidate.to_id)).length;
  const items = pages.map((page): DreamPhaseItem => ({
    id: page.id,
    record_type: "page",
    path: page.path,
    title: page.title,
    reason_codes: ["no_incoming_page_links"],
  }));
  return {
    status: "succeeded" as const,
    summary: `Found ${pagesForPolicy.length - inboundPageLinks.size} visible page(s) without canonical incoming links.`,
    counts: {
      missing_backlink_count: pagesForPolicy.length - inboundPageLinks.size,
      candidate_missing_link_count: visibleMissingLinkCount,
    },
    items,
    proposal_ids: [],
    subject_ids: uniqueStrings(items.map((item) => item.id)),
    subject_paths: uniqueStrings(items.flatMap((item) => item.path ?? [])),
  };
}

async function thinPagesPhase(context: DreamExecutionContext) {
  const repo = await loadRepository(context.root);
  const thinPages = visiblePages(context, repo)
    .map((page) => ({
      page,
      bodyChars: page.body.trim().length,
      reasons: thinPageReasons(page.body.trim().length, page.source_ids.length, page.claim_ids.length),
    }))
    .filter((entry) => entry.reasons.length > 0)
    .sort((left, right) => left.bodyChars - right.bodyChars || left.page.path.localeCompare(right.page.path))
    .slice(0, context.limit);
  const items = thinPages.map((entry): DreamPhaseItem => ({
    id: entry.page.id,
    record_type: "page",
    path: entry.page.path,
    title: entry.page.title,
    reason_codes: entry.reasons,
    counts: {
      body_chars: entry.bodyChars,
      source_count: entry.page.source_ids.length,
      claim_count: entry.page.claim_ids.length,
    },
  }));
  return {
    status: "succeeded" as const,
    summary: `Found ${thinPages.length} thin page candidate(s).`,
    counts: { thin_page_count: thinPages.length },
    items,
    proposal_ids: [],
    subject_ids: uniqueStrings(items.map((item) => item.id)),
    subject_paths: uniqueStrings(items.flatMap((item) => item.path ?? [])),
  };
}

async function orphanPagesPhase(context: DreamExecutionContext) {
  const [repo, orphans] = await Promise.all([loadRepository(context.root), graphOrphans(context.root)]);
  const visibleOrphans = orphans.pages.filter((page) => canSeeRecord(context, repo, page.id));
  const items = visibleOrphans.slice(0, context.limit).map((page): DreamPhaseItem => ({
    id: page.id,
    record_type: page.record_type,
    ...(page.path === undefined ? {} : { path: page.path }),
    title: page.title,
    reason_codes: ["no_page_to_page_edges"],
  }));
  return {
    status: "succeeded" as const,
    summary: `Found ${visibleOrphans.length} visible orphan page(s).`,
    counts: { orphan_page_count: visibleOrphans.length },
    items,
    proposal_ids: [],
    subject_ids: uniqueStrings(items.map((item) => item.id)),
    subject_paths: uniqueStrings(items.flatMap((item) => item.path ?? [])),
  };
}

async function linkSuggestionsPhase(context: DreamExecutionContext) {
  const repo = await loadRepository(context.root);
  const pages = visiblePages(context, repo)
    .filter((page) => !context.createProposals || canProposeDreamPage(context, repo, page.path))
    .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id))
    .slice(0, context.limit);
  const items: DreamPhaseItem[] = [];
  const proposalIds: string[] = [];
  for (const page of pages) {
    assertDreamPhaseWithinDeadline(context, "link_suggestions");
    const suggestions = await suggestPageTypedLinks({ root: context.root, pageId: page.id });
    assertDreamPhaseWithinDeadline(context, "link_suggestions");
    const candidateCount = suggestions.candidates.length;
    const collisionCount = suggestions.collisions.length;
    if (candidateCount === 0 && collisionCount === 0) {
      continue;
    }
    const candidateIds = uniqueStrings([
      ...suggestions.candidates.map((candidate) => candidate.to_id),
      ...suggestions.collisions.flatMap((collision) => collision.candidate_ids),
    ]);
    const visibleCandidateIds = candidateIds.filter((candidateId) => canSeeRecord(context, repo, candidateId) && candidateVisibleFromPage(repo, page.path, candidateId));
    if (visibleCandidateIds.length === 0) {
      continue;
    }
    const visibleCandidateCount = suggestions.candidates.filter((candidate) => canSeeRecord(context, repo, candidate.to_id) && candidateVisibleFromPage(repo, page.path, candidate.to_id)).length;
    const visibleCollisionCount = suggestions.collisions.filter((collision) => collision.candidate_ids.some((candidateId) => canSeeRecord(context, repo, candidateId) && candidateVisibleFromPage(repo, page.path, candidateId))).length;
    const item: DreamPhaseItem = {
      id: page.id,
      record_type: "page",
      path: page.path,
      title: page.title,
      reason_codes: ["typed_link_candidates"],
      candidate_ids: visibleCandidateIds.slice(0, 10),
      counts: {
        candidate_count: visibleCandidateCount,
        collision_count: visibleCollisionCount,
      },
    };
    if (context.createProposals) {
      if (visibleCandidateIds.length !== candidateIds.length) {
        items.push(item);
        continue;
      }
      assertCanProposeDreamPage(context, repo, page.path);
      assertDreamPhaseWithinDeadline(context, "link_suggestions");
      const idempotencyKey = targetIdempotencyKey("link_suggestions", page.id, candidateIds);
      const existing = await findExistingDreamProposal(context.root, page.id, idempotencyKey);
      assertDreamPhaseWithinDeadline(context, "link_suggestions");
      const proposal = existing ?? (await proposePageTypedLinks({
        root: context.root,
        pageId: page.id,
        actorId: context.actorId,
        proposalTitle: `Dream link suggestions for ${page.title}`,
        ...(context.phaseAbortSignal === undefined ? {} : { abortSignal: context.phaseAbortSignal }),
        rationale: dreamProposalRationale(context, "link_suggestions", page.id, idempotencyKey),
      })).proposal;
      proposalIds.push(proposal.id);
      item.proposal_id = proposal.id;
      item.proposal_status = proposal.status;
    }
    items.push(item);
  }
  return {
    status: "succeeded" as const,
    summary: `Found typed-link suggestions on ${items.length} page(s).`,
    counts: {
      pages_scanned: pages.length,
      pages_with_suggestions: items.length,
      proposal_count: proposalIds.length,
    },
    items,
    proposal_ids: uniqueStrings(proposalIds),
    subject_ids: uniqueStrings([...items.map((item) => item.id), ...proposalIds]),
    subject_paths: uniqueStrings(items.flatMap((item) => item.path ?? [])),
  };
}

function reportPhase(context: DreamExecutionContext) {
  const report = dreamRunReport(context.phaseResults, isoNow());
  return {
    status: "succeeded" as const,
    summary: `Dream report: ${report.status}; ${report.next_actions.length} next action(s).`,
    counts: {
      failed_phase_count: report.failed_phase_count,
      skipped_phase_count: report.skipped_phase_count,
      item_count: report.item_count,
      proposal_count: report.proposal_count,
    },
    items: report.next_actions.map((action, index): DreamPhaseItem => ({
      id: `dream:next-action:${index + 1}`,
      record_type: "dream_next_action",
      title: action,
    })),
    proposal_ids: [],
    subject_ids: [],
    subject_paths: [],
  };
}

function finalizePhaseResult(
  context: DreamExecutionContext,
  definition: DreamPhaseDefinition,
  startedAt: string,
  startMs: number,
  partial: Omit<DreamPhaseResult, "phase" | "started_at" | "completed_at" | "duration_ms" | "idempotency_key" | "timeout_ms" | "scopes" | "may_create_proposals" | "dry_run">,
): DreamPhaseResult {
  const completedAt = isoNow();
  return {
    phase: definition.name,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: Date.now() - startMs,
    idempotency_key: phaseIdempotencyKey(context, definition.name),
    timeout_ms: context.timeoutMs,
    scopes: definition.scopes,
    may_create_proposals: definition.may_create_proposals,
    dry_run: context.dryRun,
    ...partial,
    proposal_ids: uniqueStrings(partial.proposal_ids),
    subject_ids: uniqueStrings(partial.subject_ids),
    subject_paths: uniqueStrings(partial.subject_paths),
  };
}

function dreamRunReport(phases: DreamPhaseResult[], generatedAt: string): DreamRunReport {
  const failed = phases.filter((phase) => phase.status === "failed");
  const skipped = phases.filter((phase) => phase.status === "skipped");
  const proposalIds = uniqueStrings(phases.flatMap((phase) => phase.proposal_ids));
  const actionablePhases = phases.filter((phase) => phase.phase !== "report");
  const itemCount = actionablePhases.reduce((count, phase) => count + phase.items.length, 0);
  const nextActions: string[] = [];
  if (failed.length > 0) {
    nextActions.push(`Review failed phases: ${failed.map((phase) => phase.phase).join(", ")}.`);
  }
  if (proposalIds.length > 0) {
    nextActions.push(`Review ${proposalIds.length} dream-created proposal(s) before applying.`);
  }
  const attentionPhases = phases.filter((phase) => phase.items.length > 0 && phase.status === "succeeded" && phase.phase !== "report");
  if (attentionPhases.length > 0) {
    nextActions.push(`Triage ${attentionPhases.map((phase) => phase.phase).join(", ")} findings.`);
  }
  if (skipped.length > 0) {
    nextActions.push(`Skipped provider or future-model phases: ${skipped.map((phase) => phase.phase).join(", ")}.`);
  }
  if (nextActions.length === 0) {
    nextActions.push("No maintenance action is currently required.");
  }
  return {
    status: failed.length === 0 && itemCount === 0 ? "passed" : "attention",
    generated_at: generatedAt,
    phase_count: phases.length,
    failed_phase_count: failed.length,
    skipped_phase_count: skipped.length,
    item_count: itemCount,
    proposal_count: proposalIds.length,
    next_actions: nextActions,
  };
}

async function appendDreamLifecycleEvent(
  context: DreamExecutionContext,
  type: "dream.started" | "dream.completed" | "dream.phase.started",
  data: Record<string, unknown>,
): Promise<void> {
  if (context.runId === undefined) {
    return;
  }
  await appendEvent(context.root, {
    type,
    actor_id: context.actorId,
    operation: "wiki.dream_run",
    record_id: context.runId,
    record_type: "run",
    data: {
      run_type: "dream.run",
      ...data,
    },
    subject_ids: [context.runId],
    subject_paths: ["runs/runs.jsonl"],
  });
}

async function appendDreamPhaseEvent(context: DreamExecutionContext, result: DreamPhaseResult): Promise<void> {
  if (context.runId === undefined) {
    return;
  }
  await appendEvent(context.root, {
    type: result.status === "failed" ? "dream.phase.failed" : result.status === "skipped" ? "dream.phase.skipped" : "dream.phase.succeeded",
    actor_id: context.actorId,
    operation: "wiki.dream_run",
    record_id: context.runId,
    record_type: "run",
    data: {
      run_type: "dream.run",
      phase: result.phase,
      status: result.status,
      summary: result.summary,
      counts: result.counts,
      proposal_ids: result.proposal_ids,
      idempotency_key: result.idempotency_key,
      ...(result.skipped_reason === undefined ? {} : { skipped_reason: result.skipped_reason }),
      ...(result.error === undefined ? {} : { error: result.error }),
    },
    subject_ids: uniqueStrings([context.runId, ...result.subject_ids]),
    subject_paths: uniqueStrings(["runs/runs.jsonl", ...result.subject_paths]),
  });
}

function validationIssueItem(issue: ValidationIssue): DreamPhaseItem {
  return {
    id: issue.code,
    record_type: "validation_issue",
    ...(issue.path === undefined ? {} : { path: issue.path }),
    reason_codes: [issue.severity, issue.code],
  };
}

function thinPageReasons(bodyChars: number, sourceCount: number, claimCount: number): string[] {
  const reasons: string[] = [];
  if (bodyChars < 320) {
    reasons.push("body_under_320_chars");
  }
  if (sourceCount === 0) {
    reasons.push("no_sources");
  }
  if (claimCount === 0) {
    reasons.push("no_claims");
  }
  return reasons;
}

async function findExistingDreamProposal(root: string, pageId: string, idempotencyKey: string): Promise<ProposalRecord | undefined> {
  const repo = await loadRepository(root);
  return repo.proposals.find(
    (proposal) =>
      proposal.status === "open" &&
      proposal.target_ids.includes(pageId) &&
      proposal.rationale !== undefined &&
      proposal.rationale.includes(idempotencyKey),
  );
}

function dreamProposalRationale(
  context: DreamExecutionContext,
  phase: DreamPhaseName,
  targetId: string,
  idempotencyKey: string,
): string {
  return [
    `OpenWiki dream cycle phase ${phase} produced deterministic maintenance suggestions for review.`,
    `Source run: ${context.runId ?? "direct"}.`,
    `Target: ${targetId}.`,
    `Idempotency key: ${idempotencyKey}.`,
    "This proposal does not directly mutate canonical content; review and apply it through the normal proposal flow.",
  ].join(" ");
}

function phaseIdempotencyKey(context: DreamExecutionContext, phase: DreamPhaseName): string {
  return stableKey(["openwiki:dream:v1", context.workspaceId, phase, context.generatedAt.slice(0, 10)]);
}

function targetIdempotencyKey(phase: DreamPhaseName, targetId: string, candidateIds: string[]): string {
  return stableKey(["openwiki:dream:v1", phase, targetId, ...candidateIds.sort()]);
}

function stableKey(parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
  return `${parts[0]}:${hash}`;
}

async function repositoryForPolicy(context: DreamExecutionContext): Promise<LoadedOpenWikiRepo | undefined> {
  return context.policyContext === undefined ? undefined : loadRepository(context.root);
}

function assertDreamPhaseWithinDeadline(context: DreamExecutionContext, phase: DreamPhaseName): void {
  if (context.phaseAbortSignal?.aborted === true || (context.phaseDeadlineMs !== undefined && Date.now() > context.phaseDeadlineMs)) {
    throw new Error(`Dream phase ${phase} timed out after ${context.timeoutMs}ms`);
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return values.filter((value, index, array) => value.trim().length > 0 && array.indexOf(value) === index);
}
