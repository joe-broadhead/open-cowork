import { listRecentChanges } from "@openwiki/git";
import { createRun, runLocalJob } from "@openwiki/jobs";
import {
  graphCurrentIndexStoreNeighbors,
  graphCurrentIndexStoreOrphans,
  graphCurrentIndexStorePath,
  graphCurrentIndexStoreRelated,
  graphCurrentIndexStoreStale,
  listCurrentIndexStoreProposals,
  readCurrentIndexStoreGraph,
} from "@openwiki/index-store";
import {
  graphCurrentPostgresNeighbors,
  graphCurrentPostgresOrphans,
  graphCurrentPostgresPath,
  graphCurrentPostgresRelated,
  graphCurrentPostgresStale,
  listCurrentPostgresEvents,
  listCurrentPostgresOpenQuestions,
  listCurrentPostgresProposals,
  listCurrentPostgresRuns,
  listCurrentPostgresTopics,
  postgresRuntimeReadEnabled,
} from "@openwiki/postgres-runtime";
import {
  canReadDecisionRecord,
  canReadEventRecord,
  canReadGraphEdgeRecord,
  canReadInboxItemRecord,
  canReadPathExpression,
  canReadProposalRecord,
  canReadRecordId,
  canReadRunRecord,
  canReadSourceRecord,
  filterVisibleOpenQuestions,
  filterVisibleTopicSummaries,
} from "@openwiki/policy";
import {
  graphBacklinks,
  graphNeighbors,
  graphOrphans,
  graphPath,
  graphRelated,
  graphStale,
  listEvents,
  listGraphEdges,
  listInboxItems,
  listOpenQuestions,
  listProposals,
  listRuns,
  listTopics,
  loadRepository,
  traceClaim,
} from "@openwiki/repo";
import {
  assertSourceFetchBudgetForRoot,
  closeProposal,
  commentOnProposal,
  createSynthesis,
  filterGovernanceDetectorReportByVisibility,
  ingestSource,
  proposeEdit,
  proposePolicyChange,
  proposeSectionPolicy,
  proposeSource,
  proposeSynthesis,
  reviewProposal,
  runGovernanceDetectors,
  submitInboxItem,
} from "@openwiki/workflows";
import {
  analyzeGraph,
  graphPathFromIndex,
  type InboxItemStatus,
  isGraphSyntheticNode,
  redactOpenWikiRunEventRecord,
  redactOpenWikiRunRecord,
  type GraphIndexResponse,
  type GraphNeighborhoodResponse,
  type GraphPathResponse,
  type GraphStaleResponse,
} from "@openwiki/core";
import {
  boundedOptionalNumberParam,
  decisionParam,
  optionalBooleanParam,
  optionalCloseResolutionParam,
  optionalConnectorKindParam,
  optionalGovernanceDetectorsParam,
  optionalGraphDirectionParam,
  optionalNumberParam,
  optionalObjectParam,
  optionalProposalStatusArrayParam,
  optionalStaleAfterDaysParam,
  optionalStringArrayParam,
  optionalStringParam,
  optionalVisibilityParam,
  policyFileParam,
  stringArrayParam,
  stringParam,
} from "./params.ts";
import { MCP_GRAPH_LIST_LIMIT_MAX, MCP_PROPOSAL_LIMIT_MAX, type McpPolicyContext } from "./types.ts";

export async function proposeEditFromMcp(root: string, args: Record<string, unknown>, authenticatedActorId?: string): Promise<unknown> {
  const title = optionalStringParam(args, "title");
  const summary = optionalStringParam(args, "summary");
  const actorId = authenticatedActorId ?? optionalStringParam(args, "actor_id");
  const rationale = optionalStringParam(args, "rationale");
  return proposeEdit({
    root,
    pageId: stringParam(args, "page_id"),
    body: stringParam(args, "body"),
    ...(title === undefined ? {} : { title }),
    ...(summary === undefined ? {} : { summary }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(rationale === undefined ? {} : { rationale }),
  });
}

export async function proposeSynthesisFromMcp(root: string, args: Record<string, unknown>, authenticatedActorId?: string): Promise<unknown> {
  const pageType = optionalStringParam(args, "page_type");
  const summary = optionalStringParam(args, "summary");
  const topics = optionalStringArrayParam(args, "topics");
  const sourceIds = optionalStringArrayParam(args, "source_ids");
  const actorId = authenticatedActorId ?? optionalStringParam(args, "actor_id");
  const rationale = optionalStringParam(args, "rationale");
  return proposeSynthesis({
    root,
    title: stringParam(args, "title"),
    body: stringParam(args, "body"),
    ...(pageType === undefined ? {} : { pageType }),
    ...(summary === undefined ? {} : { summary }),
    ...(topics === undefined ? {} : { topics }),
    ...(sourceIds === undefined ? {} : { sourceIds }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(rationale === undefined ? {} : { rationale }),
  });
}

export async function createSynthesisFromMcp(root: string, args: Record<string, unknown>, authenticatedActorId?: string): Promise<unknown> {
  const pageType = optionalStringParam(args, "page_type");
  const summary = optionalStringParam(args, "summary");
  const topics = optionalStringArrayParam(args, "topics");
  const sourceIds = optionalStringArrayParam(args, "source_ids");
  const actorId = authenticatedActorId ?? optionalStringParam(args, "actor_id");
  const rationale = optionalStringParam(args, "rationale");
  const decisionRationale = optionalStringParam(args, "decision_rationale");
  const commit = optionalBooleanParam(args, "commit");
  const message = optionalStringParam(args, "message");
  return createSynthesis({
    root,
    title: stringParam(args, "title"),
    body: stringParam(args, "body"),
    ...(pageType === undefined ? {} : { pageType }),
    ...(summary === undefined ? {} : { summary }),
    ...(topics === undefined ? {} : { topics }),
    ...(sourceIds === undefined ? {} : { sourceIds }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(rationale === undefined ? {} : { rationale }),
    ...(decisionRationale === undefined ? {} : { decisionRationale }),
    ...(commit === undefined ? {} : { commit }),
    ...(message === undefined ? {} : { message }),
  });
}

export async function proposePolicyFromMcp(root: string, args: Record<string, unknown>, authenticatedActorId?: string): Promise<unknown> {
  const actorId = authenticatedActorId ?? optionalStringParam(args, "actor_id");
  const rationale = optionalStringParam(args, "rationale");
  return proposePolicyChange({
    root,
    policyFile: policyFileParam(args, "policy_file"),
    body: stringParam(args, "body"),
    ...(actorId === undefined ? {} : { actorId }),
    ...(rationale === undefined ? {} : { rationale }),
  });
}

export async function proposeSectionPolicyFromMcp(root: string, args: Record<string, unknown>, authenticatedActorId?: string): Promise<unknown> {
  const visibility = optionalVisibilityParam(args, "visibility");
  const ownerPrincipal = optionalStringParam(args, "owner_principal");
  const actorId = authenticatedActorId ?? optionalStringParam(args, "actor_id");
  const rationale = optionalStringParam(args, "rationale");
  return proposeSectionPolicy({
    root,
    sectionId: stringParam(args, "section_id"),
    title: stringParam(args, "title"),
    paths: stringArrayParam(args, "paths"),
    ...(visibility === undefined ? {} : { visibility }),
    ...(ownerPrincipal === undefined ? {} : { ownerPrincipal }),
    viewerPrincipals: optionalStringArrayParam(args, "viewer_principals") ?? [],
    contributorPrincipals: optionalStringArrayParam(args, "contributor_principals") ?? [],
    researcherPrincipals: optionalStringArrayParam(args, "researcher_principals") ?? [],
    reviewerPrincipals: optionalStringArrayParam(args, "reviewer_principals") ?? [],
    maintainerPrincipals: optionalStringArrayParam(args, "maintainer_principals") ?? [],
    adminPrincipals: optionalStringArrayParam(args, "admin_principals") ?? [],
    requiredReviewerPrincipals: optionalStringArrayParam(args, "required_reviewer_principals") ?? [],
    ...(actorId === undefined ? {} : { actorId }),
    ...(rationale === undefined ? {} : { rationale }),
  });
}

export async function proposeSourceFromMcp(root: string, args: Record<string, unknown>, authenticatedActorId?: string): Promise<unknown> {
  const sourceType = optionalStringParam(args, "source_type");
  const url = optionalStringParam(args, "url");
  const contentHash = optionalStringParam(args, "content_hash");
  const actorId = authenticatedActorId ?? optionalStringParam(args, "actor_id");
  const rationale = optionalStringParam(args, "rationale");
  const retrievedAt = optionalStringParam(args, "retrieved_at");
  const trust = optionalObjectParam(args, "trust");
  return proposeSource({
    root,
    title: stringParam(args, "title"),
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(url === undefined ? {} : { url }),
    ...(contentHash === undefined ? {} : { contentHash }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(rationale === undefined ? {} : { rationale }),
    ...(retrievedAt === undefined ? {} : { retrievedAt }),
    ...(trust === undefined ? {} : { trust }),
  });
}

export async function reviewProposalFromMcp(root: string, args: Record<string, unknown>, authenticatedActorId?: string): Promise<unknown> {
  const actorId = authenticatedActorId ?? optionalStringParam(args, "actor_id");
  return reviewProposal({
    root,
    proposalId: stringParam(args, "proposal_id"),
    decision: decisionParam(args, "decision"),
    rationale: stringParam(args, "rationale"),
    ...(actorId === undefined ? {} : { actorId }),
  });
}

export async function closeProposalFromMcp(root: string, args: Record<string, unknown>, authenticatedActorId?: string): Promise<unknown> {
  const actorId = authenticatedActorId ?? optionalStringParam(args, "actor_id");
  const resolution = optionalCloseResolutionParam(args, "resolution");
  const supersededBy = optionalStringParam(args, "superseded_by");
  return closeProposal({
    root,
    proposalId: stringParam(args, "proposal_id"),
    rationale: stringParam(args, "rationale"),
    ...(actorId === undefined ? {} : { actorId }),
    ...(resolution === undefined ? {} : { resolution }),
    ...(supersededBy === undefined ? {} : { supersededBy }),
  });
}

export async function commentOnProposalFromMcp(root: string, args: Record<string, unknown>, authenticatedActorId?: string): Promise<unknown> {
  const actorId = authenticatedActorId ?? optionalStringParam(args, "actor_id");
  return commentOnProposal({
    root,
    proposalId: stringParam(args, "proposal_id"),
    body: stringParam(args, "body"),
    ...(actorId === undefined ? {} : { actorId }),
  });
}

export async function ingestSourceFromMcp(root: string, args: Record<string, unknown>, authenticatedActorId?: string): Promise<unknown> {
  const sourceType = optionalStringParam(args, "source_type");
  const url = optionalStringParam(args, "url");
  const content = optionalStringParam(args, "content");
  const actorId = authenticatedActorId ?? optionalStringParam(args, "actor_id");
  return ingestSource({
    root,
    title: stringParam(args, "title"),
    ...(sourceType === undefined ? {} : { sourceType }),
    ...(url === undefined ? {} : { url }),
    ...(content === undefined ? {} : { content }),
    ...(actorId === undefined ? {} : { actorId }),
  });
}

export async function listProposalsFromMcp(root: string, args: Record<string, unknown>, context: McpPolicyContext): Promise<unknown> {
  const statuses = optionalProposalStatusArrayParam(args, "statuses");
  const actorId = optionalStringParam(args, "actor_id");
  const targetId = optionalStringParam(args, "target_id");
  const targetPath = optionalStringParam(args, "target_path");
  const sectionId = optionalStringParam(args, "section_id");
  const updatedAfter = optionalStringParam(args, "updated_after");
  const limit = boundedOptionalNumberParam(args, "limit", MCP_PROPOSAL_LIMIT_MAX);
  const repo = await loadRepository(root);
  const filters = {
    ...(statuses === undefined ? {} : { statuses }),
    ...(actorId === undefined ? {} : { actorId }),
    ...(targetId === undefined ? {} : { targetId }),
    ...(targetPath === undefined ? {} : { targetPath }),
    ...(sectionId === undefined ? {} : { sectionId }),
    ...(updatedAfter === undefined ? {} : { updatedAfter }),
  };
  const response = (await listCurrentPostgresProposals(root, filters)) ?? (await listCurrentIndexStoreProposals(root, filters)) ?? (await listProposals(root, filters));
  const proposals = response.proposals.filter((proposal) => canReadProposalRecord(repo, context, proposal));
  return { proposals: proposals.slice(0, limit ?? Math.min(proposals.length, MCP_PROPOSAL_LIMIT_MAX)), total: proposals.length };
}

export async function listRecentChangesForMcp(root: string, limit: number | undefined, context: McpPolicyContext): Promise<unknown> {
  const repo = await loadRepository(root);
  const response = await listRecentChanges(root, limit);
  return {
    ...response,
    changes: response.changes.filter((change) =>
      change.files.length === 0 || change.files.every((file) => canReadPathExpression(repo.policy, context, file.path)),
    ),
  };
}

export async function listEventsForMcp(root: string, limit: number | undefined, context: McpPolicyContext): Promise<unknown> {
  const repo = await loadRepository(root);
  const response = (await listCurrentPostgresEvents(root, limit)) ?? (await listEvents(root, limit));
  const includeSensitiveOperationalMetadata = context.role === "admin" || context.scopes.includes("wiki:admin");
  return {
    events: response.events
      .filter((event) => canReadEventRecord(repo, context, event))
      .map((event) => redactOpenWikiRunEventRecord(event, { includeSensitiveOperationalMetadata })),
  };
}

export async function listRunsForMcp(root: string, limit: number | undefined, context: McpPolicyContext): Promise<unknown> {
  const repo = await loadRepository(root);
  const response = (await listCurrentPostgresRuns(root, limit)) ?? (await listRuns(root, limit));
  return {
    runs: response.runs
      .filter((run) => canReadRunRecord(repo, context, run))
      .map((run) => redactOpenWikiRunRecord(run, { includeSensitiveOperationalMetadata: context.role === "admin" || context.scopes.includes("wiki:admin") })),
  };
}

export async function listTopicsForMcp(root: string, context: McpPolicyContext): Promise<unknown> {
  const repo = await loadRepository(root);
  const response = (await listCurrentPostgresTopics(root)) ?? (await listTopics(root));
  return { topics: filterVisibleTopicSummaries(repo, context, response.topics) };
}

export async function listOpenQuestionsForMcp(root: string, context: McpPolicyContext): Promise<unknown> {
  const repo = await loadRepository(root);
  const response = (await listCurrentPostgresOpenQuestions(root)) ?? (await listOpenQuestions(root));
  return { open_questions: filterVisibleOpenQuestions(repo, context, response.open_questions) };
}

export async function listInboxForMcp(root: string, args: Record<string, unknown>, context: McpPolicyContext): Promise<unknown> {
  const statuses = optionalInboxStatusArrayParam(args, "statuses");
  const ownerActorId = optionalStringParam(args, "owner_actor_id");
  const provider = optionalStringParam(args, "provider");
  const inboxKind = optionalStringParam(args, "kind");
  const targetSpaceId = optionalStringParam(args, "target_space_id");
  const limit = boundedOptionalNumberParam(args, "limit", MCP_PROPOSAL_LIMIT_MAX);
  const repo = await loadRepository(root);
  const response = await listInboxItems(root, {
    ...(statuses === undefined ? {} : { statuses }),
    ...(ownerActorId === undefined ? {} : { ownerActorId }),
    ...(provider === undefined ? {} : { provider }),
    ...(inboxKind === undefined ? {} : { inboxKind }),
    ...(targetSpaceId === undefined ? {} : { targetSpaceId }),
    ...(limit === undefined ? {} : { limit }),
  });
  const items = response.items.filter((item) => canReadInboxItemRecord(repo, context, item));
  return { items, total: items.length };
}

export async function submitInboxFromMcp(root: string, args: Record<string, unknown>, actorId: string | undefined): Promise<unknown> {
  const content = optionalStringParam(args, "content");
  const inboxKind = optionalStringParam(args, "kind");
  const provider = optionalStringParam(args, "provider");
  const adapter = optionalStringParam(args, "adapter");
  const ownerActorId = optionalStringParam(args, "owner_actor_id") ?? actorId;
  const submittedBy = actorId ?? ownerActorId;
  const targetSpaceId = optionalStringParam(args, "target_space_id");
  const targetPath = optionalStringParam(args, "target_path");
  const externalId = optionalStringParam(args, "external_id");
  const sourceUrl = optionalStringParam(args, "source_url");
  const idempotencyKey = optionalStringParam(args, "idempotency_key");
  const metadata = optionalObjectParam(args, "metadata");
  return submitInboxItem({
    root,
    title: stringParam(args, "title"),
    ...(content === undefined ? {} : { content }),
    ...(inboxKind === undefined ? {} : { inboxKind }),
    ...(provider === undefined ? {} : { provider }),
    ...(adapter === undefined ? {} : { adapter }),
    ...(ownerActorId === undefined ? {} : { ownerActorId }),
    ...(submittedBy === undefined ? {} : { submittedBy }),
    ...(targetSpaceId === undefined ? {} : { targetSpaceId }),
    ...(targetPath === undefined ? {} : { targetPath }),
    ...(externalId === undefined ? {} : { externalId }),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function optionalInboxStatusArrayParam(params: Record<string, unknown>, key: string): InboxItemStatus[] | undefined {
  const values = optionalStringArrayParam(params, key);
  return values === undefined ? undefined : values.map(inboxStatusParam);
}

function inboxStatusParam(value: string): InboxItemStatus {
  if (
    value === "received" ||
    value === "queued" ||
    value === "processing" ||
    value === "proposed" ||
    value === "applied" ||
    value === "ignored" ||
    value === "failed" ||
    value === "superseded"
  ) {
    return value;
  }
  throw new Error(`Invalid inbox status '${value}'`);
}

export async function governanceDetectorsForMcp(
  root: string,
  args: Record<string, unknown>,
  context: McpPolicyContext,
): Promise<unknown> {
  const report = await runGovernanceDetectors({
    root,
    ...optionalGovernanceDetectorsParam(args),
    ...optionalStaleAfterDaysParam(args),
  });
  return filterGovernanceDetectorReportByVisibility(await loadRepository(root), context, report);
}

export async function graphNeighborsForMcp(root: string, args: Record<string, unknown>, context: McpPolicyContext): Promise<unknown> {
  const direction = optionalGraphDirectionParam(args, "direction");
  const depth = optionalNumberParam(args, "depth");
  const limit = optionalNumberParam(args, "limit");
  return filterGraphNeighborhoodForMcp(
    root,
    context,
    (await graphCurrentPostgresNeighbors(root, stringParam(args, "id"), {
      ...(direction === undefined ? {} : { direction }),
      ...(depth === undefined ? {} : { depth }),
      ...(limit === undefined ? {} : { limit }),
    })) ??
      (await graphCurrentIndexStoreNeighbors(root, stringParam(args, "id"), {
        ...(direction === undefined ? {} : { direction }),
        ...(depth === undefined ? {} : { depth }),
        ...(limit === undefined ? {} : { limit }),
      })) ??
      (await graphNeighbors(root, stringParam(args, "id"), {
        ...(direction === undefined ? {} : { direction }),
        ...(depth === undefined ? {} : { depth }),
        ...(limit === undefined ? {} : { limit }),
      })),
  );
}

export async function graphBacklinksForMcp(root: string, args: Record<string, unknown>, context: McpPolicyContext): Promise<unknown> {
  const limit = optionalNumberParam(args, "limit");
  return filterGraphNeighborhoodForMcp(
    root,
    context,
    (await graphCurrentPostgresNeighbors(root, stringParam(args, "id"), { direction: "in", depth: 1, ...(limit === undefined ? {} : { limit }) })) ??
      (await graphCurrentIndexStoreNeighbors(root, stringParam(args, "id"), { direction: "in", depth: 1, ...(limit === undefined ? {} : { limit }) })) ??
      (await graphBacklinks(root, stringParam(args, "id"), limit === undefined ? {} : { limit })),
  );
}

export async function graphRelatedForMcp(root: string, args: Record<string, unknown>, context: McpPolicyContext): Promise<unknown> {
  const limit = optionalNumberParam(args, "limit");
  return filterGraphNeighborhoodForMcp(
    root,
    context,
    (await graphCurrentPostgresRelated(root, stringParam(args, "id"), limit === undefined ? {} : { limit })) ??
      (await graphCurrentIndexStoreRelated(root, stringParam(args, "id"), limit === undefined ? {} : { limit })) ??
      (await graphRelated(root, stringParam(args, "id"), limit === undefined ? {} : { limit })),
  );
}

export async function graphPathForMcp(root: string, args: Record<string, unknown>, context: McpPolicyContext): Promise<unknown> {
  const result = (await graphCurrentPostgresPath(root, stringParam(args, "from_id"), stringParam(args, "to_id"))) ?? (await graphCurrentIndexStorePath(root, stringParam(args, "from_id"), stringParam(args, "to_id"))) ?? (await graphPath(root, stringParam(args, "from_id"), stringParam(args, "to_id")));
  return filterGraphPathForMcp(root, context, result);
}

export async function graphOrphansForMcp(root: string, args: Record<string, unknown>, context: McpPolicyContext): Promise<unknown> {
  const repo = await loadRepository(root);
  const limit = boundedOptionalNumberParam(args, "limit", MCP_GRAPH_LIST_LIMIT_MAX) ?? MCP_GRAPH_LIST_LIMIT_MAX;
  const response = (await graphCurrentPostgresOrphans(root)) ?? (await graphCurrentIndexStoreOrphans(root)) ?? (await graphOrphans(root));
  const pages = response.pages.filter((page) => canReadRecordId(repo, context, page.id));
  return { pages: pages.slice(0, limit), total: pages.length };
}

export async function graphStaleForMcp(root: string, args: Record<string, unknown>, context: McpPolicyContext): Promise<unknown> {
  const repo = await loadRepository(root);
  const limit = boundedOptionalNumberParam(args, "limit", MCP_GRAPH_LIST_LIMIT_MAX) ?? MCP_GRAPH_LIST_LIMIT_MAX;
  const response = (await graphCurrentPostgresStale(root)) ?? (await graphCurrentIndexStoreStale(root)) ?? (await graphStale(root));
  const pages = response.pages.filter((page) => canReadRecordId(repo, context, page.id));
  const claims = response.claims.filter((claim) => canReadRecordId(repo, context, claim.id));
  return { pages: pages.slice(0, limit), claims: claims.slice(0, limit), total: pages.length + claims.length } satisfies GraphStaleResponse;
}

export async function graphReportForMcp(root: string, args: Record<string, unknown>, context: McpPolicyContext, graph: GraphIndexResponse): Promise<unknown> {
  const limit = boundedOptionalNumberParam(args, "limit", 100) ?? 10;
  return analyzeGraph(await filterGraphIndexForMcp(root, context, graph), { limit });
}

async function filterGraphNeighborhoodForMcp(root: string, context: McpPolicyContext, result: GraphNeighborhoodResponse): Promise<GraphNeighborhoodResponse> {
  const filtered = await filterGraphIndexForMcp(root, context, result);
  return { ...result, ...filtered };
}

async function filterGraphPathForMcp(root: string, context: McpPolicyContext, result: GraphPathResponse): Promise<GraphPathResponse> {
  if (!result.found) {
    return result;
  }
  const bounded = graphPathFromIndex(await filterGraphIndexForMcp(root, context, result), result.from_id, result.to_id);
  if (bounded.found || postgresRuntimeReadEnabled(process.env)) {
    return bounded;
  }
  const graph = (await readCurrentIndexStoreGraph(root)) ?? (await listGraphEdges(root));
  return graphPathFromIndex(await filterGraphIndexForMcp(root, context, graph), result.from_id, result.to_id);
}

export async function filterGraphIndexForMcp(root: string, context: McpPolicyContext, result: GraphIndexResponse): Promise<GraphIndexResponse> {
  const repo = await loadRepository(root);
  const edges = result.edges.filter((edge) => canReadGraphEdgeRecord(repo, context, edge));
  const nodeIds = new Set<string>();
  for (const edge of edges) {
    nodeIds.add(edge.from_id);
    nodeIds.add(edge.to_id);
  }
  const nodes = result.nodes.filter((node) => nodeIds.has(node.id) || (!isGraphSyntheticNode(node.id) && canReadRecordId(repo, context, node.id)));
  return { nodes, edges };
}

export async function traceClaimForMcp(root: string, id: string, context: McpPolicyContext): Promise<unknown> {
  const repo = await loadRepository(root);
  const trace = await traceClaim(root, id);
  const sources = trace.sources.filter((source) => canReadSourceRecord(repo, context, source));
  const proposals = trace.proposals.filter((proposal) => canReadProposalRecord(repo, context, proposal));
  const decisions = trace.decisions.filter((decision) => canReadDecisionRecord(repo, context, decision));
  return {
    ...trace,
    page: trace.page && canReadRecordId(repo, context, trace.page.id) ? trace.page : null,
    sources,
    proposals,
    decisions,
    evidence_summary: {
      ...trace.evidence_summary,
      source_count: sources.length,
      proposal_count: proposals.length,
      decision_count: decisions.length,
      accepted_decision_count: decisions.filter((decision) => decision.decision === "accepted").length,
    },
  };
}

export async function fetchSourceFromMcp(root: string, args: Record<string, unknown>, authenticatedActorId?: string): Promise<unknown> {
  const url = optionalStringParam(args, "url");
  const sourceType = optionalStringParam(args, "source_type");
  const actorId = authenticatedActorId ?? optionalStringParam(args, "actor_id");
  const connectorKind = optionalConnectorKindParam(args, "connector_kind");
  const connectorId = optionalStringParam(args, "connector_id");
  const credentialRef = optionalStringParam(args, "credential_ref");
  const githubOwner = optionalStringParam(args, "github_owner");
  const githubRepo = optionalStringParam(args, "github_repo");
  const gitlabProject = optionalStringParam(args, "gitlab_project");
  const sourcePath = optionalStringParam(args, "source_path");
  const ref = optionalStringParam(args, "ref");
  const maxBytes = optionalNumberParam(args, "max_bytes");
  const timeoutMs = optionalNumberParam(args, "timeout_ms");
  const input = {
    title: stringParam(args, "title"),
    ...(url === undefined ? {} : { url }),
    ...(sourceType === undefined ? {} : { source_type: sourceType }),
    ...(connectorKind === undefined ? {} : { connector_kind: connectorKind }),
    ...(connectorId === undefined ? {} : { connector_id: connectorId }),
    ...(credentialRef === undefined ? {} : { credential_ref: credentialRef }),
    ...(githubOwner === undefined ? {} : { github_owner: githubOwner }),
    ...(githubRepo === undefined ? {} : { github_repo: githubRepo }),
    ...(gitlabProject === undefined ? {} : { gitlab_project: gitlabProject }),
    ...(sourcePath === undefined ? {} : { source_path: sourcePath }),
    ...(ref === undefined ? {} : { ref }),
    ...(maxBytes === undefined ? {} : { max_bytes: maxBytes }),
    ...(timeoutMs === undefined ? {} : { timeout_ms: timeoutMs }),
  };
  const runInput = {
    root,
    runType: "source.fetch",
    ...(actorId === undefined ? {} : { actorId }),
    input,
  };
  await assertSourceFetchBudgetForRoot(root, {
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  if (optionalBooleanParam(args, "wait") === true) {
    return runLocalJob(runInput);
  }
  return { run: await createRun(runInput) };
}
