import { boundedNumberQuery, numberQuery, offsetCursor, optionalGovernanceDetectorsQuery, optionalSearchParam, optionalStaleAfterDaysQuery, paginateOffsetItems, runStatusesQuery, searchOffsetFromCursor } from "./request.ts";
import type { HttpPolicyOptions, HttpRouteResult } from "./types.ts";
import { type EventRecord, filterEventRecords, filterRunsByStatuses, type GraphEdgeRecord, type GraphIndexResponse, type GraphNeighborhoodResponse, graphPathFromIndex, type GraphPathResponse, type GraphStaleResponse, humanLabel, isGraphSyntheticNode, type ProposalRecord, redactOpenWikiRunEventRecord, redactOpenWikiRunRecord, type RunRecord, runStatusCounts, type RunStatus, type SearchResponse } from "@openwiki/core";
import { diffVersions, getHistory, InvalidGitRevisionError, type RecentChangesResponse } from "@openwiki/git";
import { listCurrentIndexStoreProposals, listCurrentIndexStoreRecords, readCurrentIndexStoreGraph } from "@openwiki/index-store";
import { assertPathAuthorized, canReadDecisionRecord, canReadEventRecord, canReadInboxItemRecord, canReadPathExpression, canReadProposalRecord, canReadRecordId, canReadRunRecord, canReadSourceRecord, filterSearchResponseByVisibility, filterVisibleOpenQuestions, filterVisibleTopicSummaries, visibleRepositoryView } from "@openwiki/policy";
import { listCurrentPostgresEvents, listCurrentPostgresProposals, listCurrentPostgresRuns, postgresRuntimeReadEnabled, readCurrentPostgresRun, readPostgresRuntimeQueueHealth } from "@openwiki/postgres-runtime";
import { type ClaimTrace, listEvents, listGraphEdges, listInboxItems, listOpenQuestions, listProposals, type ListInboxItemsOptions, type ListProposalsOptions, listRuns, listTopics, loadRepository, readRun } from "@openwiki/repo";
import { filterGovernanceDetectorReportByVisibility, inboxProcessAuthorizationPath, runGovernanceDetectors } from "@openwiki/workflows";
import { badRequest, forbidden, httpCanSeeUnfilteredIndex, httpPolicyContext } from "./auth.ts";
import { HTTP_RUN_LIMIT_MAX } from "./constants.ts";
import type { RunDetailResponse, RunMonitorResponse } from "./misc.ts";
import { webHrefForRecord } from "./renderers/graph.ts";

export async function filterSearchResponseByPolicy(
  root: string,
  policy: HttpPolicyOptions,
  response: SearchResponse,
): Promise<SearchResponse> {
  if (httpCanSeeUnfilteredIndex(policy)) {
    return response;
  }
  const repo = await loadRepository(root);
  return filterSearchResponseByVisibility(repo, httpPolicyContext(policy), response);
}

export interface HttpRecordListItem {
  id: string;
  type: string;
  group: string;
  title: string;
  path?: string;
  summary?: string;
  status?: string;
  updated_at?: string;
  href?: string;
}

interface HttpRecordGroupSummary {
  id: string;
  label: string;
  type: string;
  count: number;
}

export async function listRecordsForHttp(root: string, policy: HttpPolicyOptions, url: URL): Promise<{ records: HttpRecordListItem[]; count: number; total: number; next_cursor?: string; groups?: HttpRecordGroupSummary[] }> {
  const requestedType = url.searchParams.get("type") ?? undefined;
  const prefix = (url.searchParams.get("prefix") ?? "").trim().toLowerCase();
  const requestedGroup = url.searchParams.get("group") ?? undefined;
  const groupBy = url.searchParams.get("group_by") ?? undefined;
  const limit = boundedNumberQuery(url, "limit", 50, 1, 500);
  const offset = searchOffsetFromCursor(url.searchParams.get("cursor")) ?? Math.max(numberQuery(url, "offset") ?? 0, 0);
  const indexedVisibility = indexStoreRecordVisibilityForPolicy(policy);
  if (indexedVisibility !== undefined) {
    const indexed = await listCurrentIndexStoreRecords(root, {
      ...(requestedType === undefined ? {} : { type: requestedType }),
      ...(requestedGroup === undefined ? {} : { group: requestedGroup }),
      ...(prefix ? { prefix } : {}),
      ...(groupBy === "page_type" || groupBy === "group" ? { groupBy } : {}),
      limit,
      offset,
      visibility: indexedVisibility,
    });
    if (indexed !== undefined) {
      return {
        records: indexed.records.map((record): HttpRecordListItem => ({
          ...record,
          href: webHrefForRecord(record.type, record.id) ?? `/api/v1/search?q=${encodeURIComponent(record.id)}`,
        })),
        count: indexed.count,
        total: indexed.total,
        ...(indexed.groups === undefined ? {} : { groups: indexed.groups }),
        ...(indexed.next_cursor === undefined ? {} : { next_cursor: indexed.next_cursor }),
      };
    }
  }
  const repo = await loadRepository(root);
  const visible = visibleRepositoryView(repo, httpPolicyContext(policy));
  const records = [
    ...visible.pages.map((page): HttpRecordListItem => ({
      id: page.id,
      type: "page",
      group: page.page_type,
      title: page.title,
      path: page.path,
      summary: page.summary ?? page.id,
      status: page.status,
      updated_at: page.updated_at,
      href: `/pages/${encodeURIComponent(page.id)}`,
    })),
    ...visible.sources.map((source): HttpRecordListItem => ({
      id: source.id,
      type: "source",
      group: "source",
      title: source.title,
      path: source.path,
      summary: source.source_type,
      updated_at: source.retrieved_at,
      href: `/sources/${encodeURIComponent(source.id)}`,
    })),
    ...visible.claims.map((claim): HttpRecordListItem => ({
      id: claim.id,
      type: "claim",
      group: "claim",
      title: claim.text,
      summary: `${claim.confidence} confidence / ${claim.risk} risk`,
      status: claim.status,
      ...(claim.last_verified_at === undefined ? {} : { updated_at: claim.last_verified_at }),
      href: `/claims/${encodeURIComponent(claim.id)}`,
    })),
    ...visible.inbox.map((item): HttpRecordListItem => ({
      id: item.id,
      type: "inbox",
      group: "inbox",
      title: item.title,
      path: item.payload?.path ?? item.path,
      summary: `${item.provider}/${item.inbox_kind}`,
      status: item.status,
      updated_at: item.updated_at,
      href: `/inbox/${encodeURIComponent(item.id)}`,
    })),
    ...visible.proposals.map((proposal): HttpRecordListItem => ({
      id: proposal.id,
      type: "proposal",
      group: "proposal",
      title: proposal.title,
      path: proposal.path,
      summary: proposal.rationale ?? proposal.target_ids.join(", "),
      status: proposal.status,
      updated_at: proposal.applied_at ?? proposal.closed_at ?? proposal.created_at,
      href: `/proposals/${encodeURIComponent(proposal.id)}`,
    })),
    ...visible.decisions.map((decision): HttpRecordListItem => ({
      id: decision.id,
      type: "decision",
      group: "decision",
      title: decision.decision,
      path: decision.path,
      summary: decision.rationale,
      updated_at: decision.decided_at,
      href: `/decisions/${encodeURIComponent(decision.id)}`,
    })),
    ...visible.runs.map((run): HttpRecordListItem => ({
      id: run.id,
      type: "run",
      group: "run",
      title: run.run_type,
      summary: run.status,
      status: run.status,
      updated_at: run.completed_at ?? run.started_at ?? run.created_at,
      href: `/runs/${encodeURIComponent(run.id)}`,
    })),
  ]
    .filter((record) => requestedType === undefined || record.type === requestedType)
    .filter((record) => requestedGroup === undefined || record.group === requestedGroup)
    .filter((record) => {
      if (!prefix) {
        return true;
      }
      const haystack = `${record.id} ${record.title} ${record.path ?? ""}`.toLowerCase();
      return haystack.includes(prefix);
    })
    .sort((left, right) => left.type.localeCompare(right.type) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  const groups = groupBy === "page_type" || groupBy === "group" ? groupRecordsForHttp(records) : undefined;
  const windowed = records.slice(offset, offset + limit);
  return {
    records: windowed,
    count: windowed.length,
    total: records.length,
    ...(groups === undefined ? {} : { groups }),
    ...(records.length > offset + windowed.length ? { next_cursor: offsetCursor(offset + windowed.length) } : {}),
  };
}

function groupRecordsForHttp(records: HttpRecordListItem[]): HttpRecordGroupSummary[] {
  const counts = new Map<string, HttpRecordGroupSummary>();
  for (const record of records) {
    const current = counts.get(record.group);
    if (current) {
      current.count += 1;
    } else {
      counts.set(record.group, { id: record.group, label: humanLabel(record.group), type: record.type, count: 1 });
    }
  }
  return [...counts.values()].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

function indexStoreRecordVisibilityForPolicy(policy: HttpPolicyOptions): "all" | "public" | undefined {
  if (httpCanSeeUnfilteredIndex(policy)) {
    return "all";
  }
  const principals = policy.principals ?? [];
  if (principals.length === 0 && (policy.role === undefined || policy.role === "viewer")) {
    return "public";
  }
  return undefined;
}

export async function authorizeHttpVisibleRecord(root: string, policy: HttpPolicyOptions, id: string): Promise<HttpRouteResult | undefined> {
  const repo = await loadRepository(root);
  if (canReadRecordId(repo, httpPolicyContext(policy), id)) {
    return undefined;
  }
  return forbidden(`OpenWiki record is not visible to this actor: ${id}`);
}

export async function authorizeHttpInboxAction(
  root: string,
  operation: "wiki.inbox_process" | "wiki.inbox_ignore" | "wiki.inbox_retry",
  policy: HttpPolicyOptions,
  id: string,
): Promise<HttpRouteResult | undefined> {
  const repo = await loadRepository(root);
  const context = httpPolicyContext(policy);
  const item = repo.inbox.find((candidate) => candidate.id === id || candidate.uri === id);
  if (item === undefined || !canReadInboxItemRecord(repo, context, item)) {
    return forbidden(`OpenWiki record is not visible to this actor: ${id}`);
  }
  try {
    assertPathAuthorized(operation, context, repo.policy, inboxProcessAuthorizationPath(item, repo.policy), "maintainer");
    return undefined;
  } catch (error) {
    if (error instanceof Error) {
      return forbidden(error.message);
    }
    throw error;
  }
}

export async function authorizeHttpInboxProcess(root: string, policy: HttpPolicyOptions, id: string): Promise<HttpRouteResult | undefined> {
  return authorizeHttpInboxAction(root, "wiki.inbox_process", policy, id);
}

export async function authorizeHttpInboxSubmit(
  root: string,
  policy: HttpPolicyOptions,
  input: { ownerActorId?: string; targetSpaceId?: string; targetPath?: string },
): Promise<HttpRouteResult | undefined> {
  const context = httpPolicyContext(policy);
  const canSubmitForAnotherOwner = context.role === "admin" || context.scopes.includes("wiki:admin") || context.scopes.includes("wiki:inbox:admin");
  if (input.ownerActorId !== undefined && input.ownerActorId !== context.actorId && !canSubmitForAnotherOwner) {
    return forbidden(`Submitting to inbox owner ${input.ownerActorId} requires wiki:inbox:admin.`);
  }
  if (input.targetSpaceId === undefined && input.targetPath === undefined) {
    return undefined;
  }
  const repo = await loadRepository(root);
  const sectionPath = input.targetSpaceId === undefined
    ? undefined
    : repo.policy.sections.find((section) => section.id === input.targetSpaceId)?.paths[0];
  if (input.targetSpaceId !== undefined && sectionPath === undefined) {
    return badRequest(`Unknown target_space_id '${input.targetSpaceId}'.`);
  }
  const targetPath = input.targetPath ?? sectionPath;
  if (targetPath === undefined) {
    return undefined;
  }
  try {
    assertPathAuthorized("wiki.inbox_submit", context, repo.policy, targetPath, "contributor");
    return undefined;
  } catch (error) {
    if (error instanceof Error) {
      return forbidden(error.message);
    }
    throw error;
  }
}

export async function listVisibleProposals(
  root: string,
  policy: HttpPolicyOptions,
  options: ListProposalsOptions & { offset?: number } = {},
): Promise<{ proposals: ProposalRecord[]; total: number; next_cursor?: string }> {
  const { limit, offset, ...filters } = options;
  if (httpCanSeeUnfilteredIndex(policy)) {
    const postgresPage = await listCurrentPostgresProposals(root, {
      ...filters,
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
    });
    if (postgresPage !== undefined) {
      const pageLimit = limit ?? postgresPage.proposals.length;
      const nextOffset = (offset ?? 0) + postgresPage.proposals.length;
      return {
        proposals: postgresPage.proposals,
        total: postgresPage.total,
        ...(postgresPage.proposals.length >= pageLimit && nextOffset < postgresPage.total ? { next_cursor: `offset:${nextOffset}` } : {}),
      };
    }
  }
  const response = (await listCurrentPostgresProposals(root, filters)) ?? (await listCurrentIndexStoreProposals(root, filters)) ?? (await listProposals(root, filters));
  if (httpCanSeeUnfilteredIndex(policy)) {
    const page = paginateOffsetItems(response.proposals, limit ?? response.proposals.length, offset ?? 0);
    return {
      proposals: page.items,
      total: response.total,
      ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
    };
  }
  const repo = await loadRepository(root);
  const visible = response.proposals.filter((proposal) => canReadProposalRecord(repo, httpPolicyContext(policy), proposal));
  const page = paginateOffsetItems(visible, limit ?? visible.length, offset ?? 0);
  return {
    proposals: page.items,
    total: visible.length,
    ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
  };
}

export async function listVisibleInboxItems(
  root: string,
  policy: HttpPolicyOptions,
  options: ListInboxItemsOptions & { offset?: number } = {},
): Promise<{ items: import("@openwiki/core").InboxItemRecord[]; total: number; next_cursor?: string }> {
  const { limit, offset, ...filters } = options;
  const response = await listInboxItems(root, filters);
  if (httpCanSeeUnfilteredIndex(policy)) {
    const page = paginateOffsetItems(response.items, limit ?? response.items.length, offset ?? 0);
    return {
      items: page.items,
      total: response.total,
      ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
    };
  }
  const repo = await loadRepository(root);
  const visible = response.items.filter((item) => canReadInboxItemRecord(repo, httpPolicyContext(policy), item));
  const page = paginateOffsetItems(visible, limit ?? visible.length, offset ?? 0);
  return {
    items: page.items,
    total: visible.length,
    ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
  };
}

export async function pagedHistory(root: string, id: string, url: URL): Promise<Awaited<ReturnType<typeof getHistory>> & { next_cursor?: string }> {
  const limit = boundedNumberQuery(url, "limit", 20, 1, 100);
  const offset = searchOffsetFromCursor(url.searchParams.get("cursor")) ?? Math.max(numberQuery(url, "offset") ?? 0, 0);
  const history = await getHistory(root, id, Math.min(offset + limit + 1, 100));
  const page = paginateOffsetItems(history.commits, limit, offset);
  return {
    ...history,
    commits: page.items,
    ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
  };
}

export async function diffVersionsRouteResult(root: string, id: string, url: URL): Promise<HttpRouteResult> {
  try {
    return {
      status: 200,
      body: await diffVersions({
        root,
        id,
        ...optionalSearchParam(url, "from", "from"),
        ...optionalSearchParam(url, "to", "to"),
      }),
    };
  } catch (error) {
    if (error instanceof InvalidGitRevisionError) {
      return badRequest(error.message);
    }
    throw error;
  }
}

export async function filterEventsByPolicy(
  root: string,
  policy: HttpPolicyOptions,
  response: { events: EventRecord[] },
): Promise<{ events: EventRecord[] }> {
  if (httpCanSeeUnfilteredIndex(policy)) {
    return response;
  }
  const repo = await loadRepository(root);
  const context = httpPolicyContext(policy);
  return { events: response.events.filter((event) => canReadEventRecord(repo, context, event)).map((event) => redactOpenWikiRunEventRecord(event)) };
}

export async function filterRunsByPolicy(root: string, policy: HttpPolicyOptions, response: { runs: RunRecord[] }): Promise<{ runs: RunRecord[] }> {
  if (httpCanSeeUnfilteredIndex(policy)) {
    return response;
  }
  const repo = await loadRepository(root);
  const context = httpPolicyContext(policy);
  return { runs: response.runs.filter((run) => canReadRunRecord(repo, context, run)).map((run) => redactOpenWikiRunRecord(run)) };
}

export async function listVisibleRuns(
  root: string,
  policy: HttpPolicyOptions,
  limit: number,
  options: { statuses?: RunStatus[] } = {},
): Promise<{ source: "postgres-runtime" | "parser"; runs: RunRecord[] }> {
  const postgresRuns = await listCurrentPostgresRuns(root, {
    limit,
    ...(options.statuses === undefined ? {} : { statuses: options.statuses }),
  });
  const response = postgresRuns ?? (await listRuns(root, limit));
  const filtered = await filterRunsByPolicy(root, policy, response);
  return { source: postgresRuns?.source ?? "parser", runs: filtered.runs };
}

export async function runMonitor(root: string, url: URL, policy: HttpPolicyOptions): Promise<RunMonitorResponse> {
  const repo = await loadRepository(root);
  const limit = boundedNumberQuery(url, "limit", 50, 1, HTTP_RUN_LIMIT_MAX);
  const statuses = runStatusesQuery(url) ?? [];
  const visible = await listVisibleRuns(root, policy, Math.max(limit, 500));
  const filteredSource = statuses.length === 0
    ? visible.runs
    : (await listVisibleRuns(root, policy, Math.max(limit, 500), { statuses })).runs;
  const filtered = filterRunsByStatuses(filteredSource, statuses.length === 0 ? undefined : statuses);
  const queue = httpCanSeeUnfilteredIndex(policy) ? await readPostgresRuntimeQueueHealth(root).catch(() => undefined) : undefined;
  return {
    generated_at: new Date().toISOString(),
    workspace_id: repo.config.workspace_id,
    source: visible.source,
    counts: runStatusCounts(visible.runs),
    filters: { statuses, limit },
    recent: filtered.slice(0, limit),
    ...(queue === undefined ? {} : { queue }),
  };
}

export async function runDetail(root: string, runId: string, policy: HttpPolicyOptions): Promise<RunDetailResponse | undefined> {
  const repo = await loadRepository(root);
  const context = httpPolicyContext(policy);
  const postgresDetail = await readCurrentPostgresRun(root, runId);
  const run = postgresDetail?.run ?? await readRun(root, runId).catch(() => undefined);
  if (run === undefined || !canReadRunRecord(repo, context, run)) {
    return undefined;
  }
  const eventSource = (await listCurrentPostgresEvents(root, { limit: 500, recordId: run.id })) ?? (await listEvents(root, 500));
  const filteredEvents = await filterEventsByPolicy(root, policy, eventSource);
  const events = filterEventRecords(filteredEvents.events, { recordId: run.id });
  return {
    source: postgresDetail?.source ?? "parser",
    run: redactOpenWikiRunRecord(run, { includeSensitiveOperationalMetadata: httpCanSeeUnfilteredIndex(policy) }),
    ...(postgresDetail?.job === undefined ? {} : { job: postgresDetail.job }),
    attempts: postgresDetail?.attempts ?? [],
    events,
  };
}

export async function filterRecentChangesByPolicy(
  root: string,
  policy: HttpPolicyOptions,
  response: RecentChangesResponse,
): Promise<RecentChangesResponse> {
  const repo = await loadRepository(root);
  const context = httpPolicyContext(policy);
  return {
    ...response,
    changes: response.changes.filter((change) =>
      change.files.length === 0 || change.files.every((file) => canReadPathExpression(repo.policy, context, file.path)),
    ),
  };
}

export async function filterTopicsByPolicy(root: string, policy: HttpPolicyOptions, response: Awaited<ReturnType<typeof listTopics>>): Promise<Awaited<ReturnType<typeof listTopics>>> {
  const repo = await loadRepository(root);
  return { topics: filterVisibleTopicSummaries(repo, httpPolicyContext(policy), response.topics) };
}

export async function filterOpenQuestionsByPolicy(
  root: string,
  policy: HttpPolicyOptions,
  response: Awaited<ReturnType<typeof listOpenQuestions>>,
): Promise<Awaited<ReturnType<typeof listOpenQuestions>>> {
  const repo = await loadRepository(root);
  return { open_questions: filterVisibleOpenQuestions(repo, httpPolicyContext(policy), response.open_questions) };
}

export async function governanceDetectorReport(root: string, url: URL, policy: HttpPolicyOptions): Promise<unknown> {
  const report = await runGovernanceDetectors({
    root,
    ...optionalGovernanceDetectorsQuery(url),
    ...optionalStaleAfterDaysQuery(url),
  });
  return filterGovernanceDetectorReportByVisibility(await loadRepository(root), httpPolicyContext(policy), report);
}

export async function filterGraphNeighborhoodByPolicy(root: string, policy: HttpPolicyOptions, response: GraphNeighborhoodResponse): Promise<GraphNeighborhoodResponse> {
  return { ...response, ...(await filterGraphIndexByPolicy(root, policy, response)) };
}

export async function filterGraphPathByPolicy(root: string, policy: HttpPolicyOptions, response: GraphPathResponse): Promise<GraphPathResponse> {
  if (!response.found) {
    return response;
  }
  const bounded = graphPathFromIndex(await filterGraphIndexByPolicy(root, policy, response), response.from_id, response.to_id);
  if (bounded.found || postgresRuntimeReadEnabled(process.env)) {
    return bounded;
  }
  const graph = (await readCurrentIndexStoreGraph(root)) ?? (await listGraphEdges(root));
  return graphPathFromIndex(await filterGraphIndexByPolicy(root, policy, graph), response.from_id, response.to_id);
}

export async function filterGraphIndexByPolicy(root: string, policy: HttpPolicyOptions, response: GraphIndexResponse): Promise<GraphIndexResponse> {
  if (httpCanSeeUnfilteredIndex(policy)) {
    return response;
  }
  const repo = await loadRepository(root);
  const context = httpPolicyContext(policy);
  const visibleRecordIds = visibleGraphRecordIds(repo, context);
  const edges = response.edges.filter((edge) => canReadGraphEdgeFast(visibleRecordIds, edge));
  const nodeIds = new Set<string>();
  for (const edge of edges) {
    nodeIds.add(edge.from_id);
    nodeIds.add(edge.to_id);
  }
  const nodes = response.nodes.filter((node) => nodeIds.has(node.id) || (!isGraphSyntheticNode(node.id) && visibleRecordIds.has(node.id)));
  return { nodes, edges };
}

function visibleGraphRecordIds(repo: Awaited<ReturnType<typeof loadRepository>>, context: ReturnType<typeof httpPolicyContext>): Set<string> {
  const visible = visibleRepositoryView(repo, context);
  const ids = new Set<string>([repo.config.workspace_id]);
  for (const record of [
    ...visible.pages,
    ...visible.sources,
    ...visible.claims,
    ...visible.inbox,
    ...visible.proposals,
    ...visible.comments,
    ...visible.decisions,
    ...visible.events,
    ...visible.runs,
  ]) {
    ids.add(record.id);
    ids.add(record.uri);
  }
  return ids;
}

function canReadGraphEdgeFast(visibleRecordIds: Set<string>, edge: GraphEdgeRecord): boolean {
  return graphEndpointVisibleFast(visibleRecordIds, edge.from_id) && graphEndpointVisibleFast(visibleRecordIds, edge.to_id);
}

function graphEndpointVisibleFast(visibleRecordIds: Set<string>, id: string): boolean {
  return isGraphSyntheticNode(id) || visibleRecordIds.has(id);
}

export async function filterGraphStaleByPolicy(root: string, policy: HttpPolicyOptions, response: GraphStaleResponse): Promise<GraphStaleResponse> {
  const repo = await loadRepository(root);
  const context = httpPolicyContext(policy);
  const pages = response.pages.filter((page) => canReadRecordId(repo, context, page.id));
  const claims = response.claims.filter((claim) => canReadRecordId(repo, context, claim.id));
  return { pages, claims, total: pages.length + claims.length };
}

export async function filterClaimTraceByPolicy(root: string, policy: HttpPolicyOptions, trace: ClaimTrace): Promise<ClaimTrace> {
  const repo = await loadRepository(root);
  const context = httpPolicyContext(policy);
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
