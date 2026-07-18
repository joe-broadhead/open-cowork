import { looksLikeOpenWikiRepoPath, openWikiEventVisibilitySubjectPaths, openWikiRunVisibilitySubjectPaths, openWikiSearchFacetsFromItems, openWikiVisibleSearchResponse, uniqueStrings, type ClaimRecord, type DecisionRecord, type EventRecord, type FactRecord, type GraphEdgeRecord, type InboxItemRecord, type OpenQuestionRecord, type OpenWikiPolicyBundle, type OpenWikiRole, type PageRecord, type ProposalCommentRecord, type ProposalRecord, type RunRecord, type SearchResponse, type SearchResult, type SourceRecord, type TakeRecord, type TopicSummary } from "@openwiki/core";
import type { PolicyContext, PolicyReadableRecordReference, PolicyVisibilityRepository, VisiblePolicyRepository } from "./types.ts";
import { canAccessPath, principalsForContext, sectionAllowedByContextBounds } from "./access.ts";
import { highestRole, roleAtLeast } from "./operations.ts";

export function visibleRepositoryView(repo: PolicyVisibilityRepository, context: PolicyContext): VisiblePolicyRepository {
  const pages = repo.pages.filter((page) => canReadPageRecord(repo, context, page));
  const sources = repo.sources.filter((source) => canReadSourceRecord(repo, context, source));
  const claims = repo.claims.filter((claim) => canReadClaimRecord(repo, context, claim));
  const facts = repo.facts.filter((fact) => canReadFactRecord(repo, context, fact));
  const takes = repo.takes.filter((take) => canReadTakeRecord(repo, context, take));
  const inbox = repo.inbox.filter((item) => canReadInboxItemRecord(repo, context, item));
  const proposals = repo.proposals.filter((proposal) => canReadProposalRecord(repo, context, proposal));
  const comments = repo.comments.filter((comment) => canReadCommentRecord(repo, context, comment));
  const decisions = repo.decisions.filter((decision) => canReadDecisionRecord(repo, context, decision));
  const events = repo.events.filter((event) => canReadEventRecord(repo, context, event));
  const runs = repo.runs.filter((run) => canReadRunRecord(repo, context, run));
  return { pages, sources, claims, facts, takes, inbox, proposals, comments, decisions, events, runs };
}

export function filterSearchResponseByVisibility(
  repo: PolicyVisibilityRepository,
  context: PolicyContext,
  response: SearchResponse,
): SearchResponse {
  const results = response.results
    .filter((result) => canReadSearchResult(repo, context, result))
    .map((result) => searchResultWithVisibleCitations(repo, context, result));
  const visible = openWikiVisibleSearchResponse({ response, visibleResults: results, facets: facetsFromVisibleResults(repo, results) });
  if (!contextHasReadBounds(context)) {
    return visible;
  }
  const sanitized = { ...visible };
  delete sanitized.explain;
  return sanitized;
}

function searchResultWithVisibleCitations(
  repo: PolicyVisibilityRepository,
  context: PolicyContext,
  result: SearchResult,
): SearchResult {
  const citations = result.citations.filter((citation) => {
    const sourceId = citation.source_id;
    if (typeof sourceId !== "string") {
      return true;
    }
    const source = repo.sources.find((candidate) => candidate.id === sourceId || candidate.uri === sourceId);
    return source === undefined ? false : canReadSourceRecord(repo, context, source);
  });
  return citations.length === result.citations.length ? result : { ...result, citations };
}

function facetsFromVisibleResults(repo: PolicyVisibilityRepository, results: SearchResult[]): NonNullable<SearchResponse["facets"]> {
  return openWikiSearchFacetsFromItems(results.map((result) => ({ id: result.id, type: result.type, ...searchFacetRecord(repo, result) })));
}

function searchFacetRecord(repo: PolicyVisibilityRepository, result: SearchResult): { status?: string; topics?: string[] } | undefined {
  if (result.type === "page") {
    const page = repo.pages.find((candidate) => candidate.id === result.id);
    return page === undefined ? undefined : { status: page.status, topics: page.topics };
  }
  if (result.type === "source") {
    return repo.sources.some((candidate) => candidate.id === result.id) ? { status: "active", topics: [] } : undefined;
  }
  if (result.type === "claim") {
    const claim = repo.claims.find((candidate) => candidate.id === result.id);
    const page = claim === undefined ? undefined : repo.pages.find((candidate) => candidate.id === claim.page_id);
    return claim === undefined ? undefined : { status: claim.status, topics: page?.topics ?? [] };
  }
  if (result.type === "fact") {
    const fact = repo.facts.find((candidate) => candidate.id === result.id);
    return fact === undefined ? undefined : { status: fact.status, topics: fact.page_ids.flatMap((pageId) => repo.pages.find((page) => page.id === pageId)?.topics ?? []) };
  }
  if (result.type === "take") {
    const take = repo.takes.find((candidate) => candidate.id === result.id);
    return take === undefined ? undefined : { status: take.status, topics: take.page_ids.flatMap((pageId) => repo.pages.find((page) => page.id === pageId)?.topics ?? []) };
  }
  if (result.type === "inbox") {
    const item = repo.inbox.find((candidate) => candidate.id === result.id);
    return item === undefined ? undefined : { status: item.status, topics: [] };
  }
  if (result.type === "proposal") {
    const proposal = repo.proposals.find((candidate) => candidate.id === result.id);
    return proposal === undefined ? undefined : { status: proposal.status, topics: [] };
  }
  if (result.type === "decision") {
    const decision = repo.decisions.find((candidate) => candidate.id === result.id);
    return decision === undefined ? undefined : { status: decision.decision, topics: [] };
  }
  if (result.type === "event") {
    const event = repo.events.find((candidate) => candidate.id === result.id);
    return event === undefined ? undefined : { status: event.type, topics: [] };
  }
  if (result.type === "run") {
    const run = repo.runs.find((candidate) => candidate.id === result.id);
    return run === undefined ? undefined : { status: run.status, topics: [] };
  }
  return undefined;
}

function canReadSearchResult(repo: PolicyVisibilityRepository, context: PolicyContext, result: SearchResult): boolean {
  const sourceIds = result.citations
    .map((citation) => citation.source_id)
    .filter((sourceId): sourceId is string => typeof sourceId === "string");
  return canReadRecordReference(repo, context, {
    id: result.id,
    type: result.type,
    ...(result.path === undefined ? {} : { path: result.path }),
    ...(sourceIds.length === 0 ? {} : { source_ids: sourceIds }),
  });
}

export function canReadGraphEdgeRecord(repo: PolicyVisibilityRepository, context: PolicyContext, edge: GraphEdgeRecord): boolean {
  return graphEndpointVisible(repo, context, edge.from_id) && graphEndpointVisible(repo, context, edge.to_id);
}

function graphEndpointVisible(repo: PolicyVisibilityRepository, context: PolicyContext, id: string): boolean {
  if (isGraphSyntheticId(id)) {
    return true;
  }
  return canReadRecordId(repo, context, id);
}

function isGraphSyntheticId(id: string): boolean {
  return id.startsWith("topic:") || id.startsWith("section:");
}

export function canReadRecordReference(
  repo: PolicyVisibilityRepository,
  context: PolicyContext,
  reference: PolicyReadableRecordReference,
): boolean {
  if (!sourceIdsAllowedByContext(context, reference.source_ids ?? [])) {
    return false;
  }
  if (canReadRecordId(repo, context, reference.id)) {
    return true;
  }
  if (knownRecordId(repo, reference.id)) {
    return false;
  }
  if (reference.type === "source_fragment") {
    const sourceAllowed = (reference.source_ids ?? []).length > 0 && (reference.source_ids ?? []).every((sourceId) => canReadRecordId(repo, context, sourceId));
    return sourceAllowed && (reference.path === undefined || canReadPathExpression(repo.policy, context, reference.path));
  }
  if (reference.type === "recent_change") {
    return reference.path !== undefined && canReadPathExpression(repo.policy, context, reference.path);
  }
  return reference.path !== undefined && canReadPathExpression(repo.policy, context, reference.path);
}

export function canReadRecordId(repo: PolicyVisibilityRepository, context: PolicyContext, id: string): boolean {
  if (id.startsWith("workspace:")) {
    return true;
  }
  const page = repo.pages.find((candidate) => candidate.id === id || candidate.uri === id);
  if (page) {
    return canReadPageRecord(repo, context, page);
  }
  const source = repo.sources.find((candidate) => candidate.id === id || candidate.uri === id);
  if (source) {
    return canReadSourceRecord(repo, context, source);
  }
  const claim = repo.claims.find((candidate) => candidate.id === id || candidate.uri === id);
  if (claim) {
    return canReadClaimRecord(repo, context, claim);
  }
  const fact = repo.facts.find((candidate) => candidate.id === id || candidate.uri === id);
  if (fact) {
    return canReadFactRecord(repo, context, fact);
  }
  const take = repo.takes.find((candidate) => candidate.id === id || candidate.uri === id);
  if (take) {
    return canReadTakeRecord(repo, context, take);
  }
  const inboxItem = repo.inbox.find((candidate) => candidate.id === id || candidate.uri === id);
  if (inboxItem) {
    return canReadInboxItemRecord(repo, context, inboxItem);
  }
  const proposal = repo.proposals.find((candidate) => candidate.id === id || candidate.uri === id);
  if (proposal) {
    return canReadProposalRecord(repo, context, proposal);
  }
  const comment = repo.comments.find((candidate) => candidate.id === id || candidate.uri === id);
  if (comment) {
    return canReadCommentRecord(repo, context, comment);
  }
  const decision = repo.decisions.find((candidate) => candidate.id === id || candidate.uri === id);
  if (decision) {
    return canReadDecisionRecord(repo, context, decision);
  }
  const event = repo.events.find((candidate) => candidate.id === id || candidate.uri === id);
  if (event) {
    return canReadEventRecord(repo, context, event);
  }
  const run = repo.runs.find((candidate) => candidate.id === id || candidate.uri === id);
  if (run) {
    return canReadRunRecord(repo, context, run);
  }
  return false;
}

function knownRecordId(repo: PolicyVisibilityRepository, id: string): boolean {
  return (
    repo.pages.some((candidate) => candidate.id === id || candidate.uri === id) ||
    repo.sources.some((candidate) => candidate.id === id || candidate.uri === id) ||
    repo.claims.some((candidate) => candidate.id === id || candidate.uri === id) ||
    repo.facts.some((candidate) => candidate.id === id || candidate.uri === id) ||
    repo.takes.some((candidate) => candidate.id === id || candidate.uri === id) ||
    repo.inbox.some((candidate) => candidate.id === id || candidate.uri === id) ||
    repo.proposals.some((candidate) => candidate.id === id || candidate.uri === id) ||
    repo.comments.some((candidate) => candidate.id === id || candidate.uri === id) ||
    repo.decisions.some((candidate) => candidate.id === id || candidate.uri === id) ||
    repo.events.some((candidate) => candidate.id === id || candidate.uri === id) ||
    repo.runs.some((candidate) => candidate.id === id || candidate.uri === id)
  );
}

function canReadPageRecord(repo: PolicyVisibilityRepository, context: PolicyContext, page: PageRecord): boolean {
  return canAccessPath(repo.policy, context, page.path, "viewer") && sourceIdsAllowedByContext(context, page.source_ids);
}

export function canReadSourceRecord(repo: PolicyVisibilityRepository, context: PolicyContext, source: SourceRecord): boolean {
  return canAccessPath(repo.policy, context, source.path, "viewer") && sourceIdsAllowedByContext(context, [source.id]);
}

export function canReadClaimRecord(repo: PolicyVisibilityRepository, context: PolicyContext, claim: ClaimRecord): boolean {
  const page = repo.pages.find((candidate) => candidate.id === claim.page_id || candidate.claim_ids.includes(claim.id));
  return page !== undefined && canReadPageRecord(repo, context, page) && sourceIdsAllowedByContext(context, claim.source_ids);
}

export function canReadFactRecord(repo: PolicyVisibilityRepository, context: PolicyContext, fact: FactRecord): boolean {
  if (fact.status === "forgotten") {
    return false;
  }
  return (
    canAccessPath(repo.policy, context, fact.path, "viewer") &&
    fact.page_ids.every((pageId) => canReadRecordId(repo, context, pageId)) &&
    fact.source_ids.every((sourceId) => canReadRecordId(repo, context, sourceId)) &&
    fact.claim_ids.every((claimId) => canReadRecordId(repo, context, claimId)) &&
    fact.subject_ids.every((subjectId) => !knownRecordId(repo, subjectId) || canReadRecordId(repo, context, subjectId))
  );
}

export function canReadTakeRecord(repo: PolicyVisibilityRepository, context: PolicyContext, take: TakeRecord): boolean {
  return (
    canAccessPath(repo.policy, context, take.path, "viewer") &&
    take.page_ids.every((pageId) => canReadRecordId(repo, context, pageId)) &&
    take.source_ids.every((sourceId) => canReadRecordId(repo, context, sourceId)) &&
    take.claim_ids.every((claimId) => canReadRecordId(repo, context, claimId))
  );
}

export function canReadInboxItemRecord(repo: PolicyVisibilityRepository, context: PolicyContext, item: InboxItemRecord): boolean {
  if (!inboxProviderAllowedByContext(context, item.provider) || !sourceIdsAllowedByContext(context, item.source_ids ?? [])) {
    return false;
  }
  if (context.scopes.includes("wiki:admin") || context.scopes.includes("wiki:inbox:admin")) {
    return true;
  }
  if (!context.scopes.includes("wiki:inbox:read")) {
    return false;
  }
  if (item.owner_actor_id !== undefined && context.actorId !== undefined && item.owner_actor_id === context.actorId) {
    return true;
  }
  if (item.submitted_by !== undefined && context.actorId !== undefined && item.submitted_by === context.actorId) {
    return true;
  }
  if (item.target_space_id !== undefined) {
    return canAccessSection(repo.policy, context, item.target_space_id, "viewer");
  }
  if (item.target_path !== undefined) {
    return canAccessPath(repo.policy, context, item.target_path, "viewer");
  }
  return false;
}

export function canReadProposalRecord(repo: PolicyVisibilityRepository, context: PolicyContext, proposal: ProposalRecord): boolean {
  if (proposal.target_path) {
    return canAccessPath(repo.policy, context, proposal.target_path, "viewer");
  }
  if (proposal.target_ids.length > 0) {
    return proposal.target_ids.every((targetId) => canReadRecordId(repo, context, targetId));
  }
  return canAccessPath(repo.policy, context, proposal.path, "viewer");
}

function canReadCommentRecord(repo: PolicyVisibilityRepository, context: PolicyContext, comment: ProposalCommentRecord): boolean {
  const proposal = repo.proposals.find((candidate) => candidate.id === comment.proposal_id);
  return proposal !== undefined && canReadProposalRecord(repo, context, proposal);
}

export function canReadDecisionRecord(repo: PolicyVisibilityRepository, context: PolicyContext, decision: DecisionRecord): boolean {
  const proposal = repo.proposals.find((candidate) => candidate.id === decision.proposal_id);
  return proposal !== undefined && canReadProposalRecord(repo, context, proposal);
}

export function canReadEventRecord(repo: PolicyVisibilityRepository, context: PolicyContext, event: EventRecord): boolean {
  const explicitIds = event.subject_ids ?? [];
  const explicitPaths = event.subject_paths ?? [];
  const fallbackPaths = explicitPaths.length > 0 ? [] : openWikiEventVisibilitySubjectPaths({ data: event.data });
  if (explicitIds.length > 0 || explicitPaths.length > 0) {
    return (
      explicitIds.every((id) => canReadRecordId(repo, context, id)) &&
      [...explicitPaths, ...fallbackPaths].every((repoPath) => canAccessPath(repo.policy, context, repoPath, "viewer"))
    );
  }
  if (event.record_id && canReadRecordId(repo, context, event.record_id)) {
    return fallbackPaths.every((repoPath) => canAccessPath(repo.policy, context, repoPath, "viewer"));
  }
  if (fallbackPaths.length > 0) {
    return fallbackPaths.every((repoPath) => canAccessPath(repo.policy, context, repoPath, "viewer"));
  }
  return canAccessPath(repo.policy, context, event.path, "viewer");
}

export function canReadRunRecord(repo: PolicyVisibilityRepository, context: PolicyContext, run: RunRecord): boolean {
  const explicitIds = run.subject_ids ?? [];
  const explicitPaths = run.subject_paths ?? [];
  const fallbackPaths = explicitPaths.length > 0 ? [] : openWikiRunVisibilitySubjectPaths({ input: run.input, output: run.output });
  if (explicitIds.length > 0 || explicitPaths.length > 0) {
    return (
      explicitIds.every((id) => canReadRecordId(repo, context, id)) &&
      [...explicitPaths, ...fallbackPaths].every((repoPath) => canAccessPath(repo.policy, context, repoPath, "viewer"))
    );
  }
  if (fallbackPaths.length > 0) {
    return fallbackPaths.every((repoPath) => canAccessPath(repo.policy, context, repoPath, "viewer"));
  }
  return canAccessPath(repo.policy, context, run.path, "viewer");
}

export function filterVisibleOpenQuestions(
  repo: PolicyVisibilityRepository,
  context: PolicyContext,
  questions: OpenQuestionRecord[],
): OpenQuestionRecord[] {
  return questions.filter((question) => canReadRecordId(repo, context, question.page_id));
}

export function filterVisibleTopicSummaries(
  repo: PolicyVisibilityRepository,
  context: PolicyContext,
  topics: TopicSummary[],
): TopicSummary[] {
  const visiblePages = repo.pages.filter((page) => canReadPageRecord(repo, context, page));
  const visiblePageIds = new Set(visiblePages.map((page) => page.id));
  const visibleClaims = new Set(repo.claims.filter((claim) => canReadClaimRecord(repo, context, claim)).map((claim) => claim.id));
  const visibleSourceIds = new Set(repo.sources.filter((source) => canReadSourceRecord(repo, context, source)).map((source) => source.id));
  return topics
    .map((topic) => {
      const pageIds = topic.page_ids.filter((pageId) => visiblePageIds.has(pageId));
      const sourceIds = topic.source_ids.filter((sourceId) => visibleSourceIds.has(sourceId));
      const claimCount = visiblePages
        .filter((page) => pageIds.includes(page.id))
        .reduce((count, page) => count + page.claim_ids.filter((claimId) => visibleClaims.has(claimId)).length, 0);
      const updatedAt = visiblePages
        .filter((page) => pageIds.includes(page.id))
        .reduce((latest, page) => (page.updated_at > latest ? page.updated_at : latest), "");
      return {
        ...topic,
        page_count: pageIds.length,
        page_ids: pageIds,
        claim_count: claimCount,
        source_count: sourceIds.length,
        source_ids: sourceIds,
        updated_at: updatedAt,
      };
    })
    .filter((topic) => topic.page_count > 0);
}

export function canReadPathExpression(policy: OpenWikiPolicyBundle, context: PolicyContext, pathExpression: string): boolean {
  const repoPaths = splitPathExpression(pathExpression);
  return repoPaths.length > 0 && repoPaths.every((repoPath) => canAccessPath(policy, context, repoPath, "viewer"));
}

function splitPathExpression(pathExpression: string): string[] {
  return uniqueStrings(
    pathExpression
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(looksLikeOpenWikiRepoPath),
  );
}

function canAccessSection(
  policy: OpenWikiPolicyBundle,
  context: PolicyContext,
  sectionId: string,
  requiredRole: OpenWikiRole,
): boolean {
  if (!sectionAllowedByContextBounds(context, sectionId)) {
    return false;
  }
  const principals = new Set(principalsForContext(context));
  const roles = policy.grants
    .filter((grant) => grant.section === sectionId && principals.has(grant.principal))
    .map((grant) => grant.role);
  const role = highestRole(roles);
  return role !== undefined && roleAtLeast(role, requiredRole);
}

function sourceIdsAllowedByContext(context: PolicyContext, sourceIds: readonly string[]): boolean {
  const allowed = context.bounds?.sourceIds;
  if (allowed === undefined || sourceIds.length === 0) {
    return true;
  }
  const allowedSet = new Set(allowed);
  return sourceIds.every((sourceId) => allowedSet.has(sourceId));
}

function inboxProviderAllowedByContext(context: PolicyContext, provider: string): boolean {
  const allowed = context.bounds?.inboxProviders;
  return allowed === undefined || allowed.includes(provider);
}

function contextHasReadBounds(context: PolicyContext): boolean {
  const bounds = context.bounds;
  return Boolean(
    bounds !== undefined &&
      (
        bounds.sourceIds !== undefined ||
        bounds.pathPrefixes !== undefined ||
        bounds.sectionIds !== undefined ||
        bounds.inboxProviders !== undefined ||
        bounds.operations !== undefined ||
        bounds.toolModes !== undefined
      ),
  );
}
