import { DEFAULT_OPENWIKI_SEARCH_CONFIG, fuseSearchRetrieverRuns, idToUri, openWikiOffsetCursor, openWikiProposalSectionIds, openWikiProposalTargetsPath, openWikiProposalTargetPaths, openWikiProposalUpdatedAt, openWikiSearchFacetsFromItems, openWikiSearchResponse, type ProposalRecord, type SearchBackendCapabilities, type SearchFacets, type SearchRequest, type SearchResponse, type SearchResult, type SearchRetriever } from "@openwiki/core";
import { canReadRecordReference, type PolicyContext } from "@openwiki/policy";
import type { LoadedOpenWikiRepo } from "@openwiki/repo";
import { postgresRuntimeSearchEnabled } from "./config.ts";
import { dateStringField, numberField, parseJsonStringArray, stringField } from "./rows.ts";
import { openCurrentPostgresRuntime } from "./sync.ts";
import type { PostgresSql } from "./types.ts";

const POSTGRES_SEARCH_SCAN_CAP = 25_000;
const POSTGRES_POLICY_SEARCH_SCAN_CAP = POSTGRES_SEARCH_SCAN_CAP;
const POSTGRES_LIKE_ESCAPE = "\\";

export async function searchCurrentPostgresRuntime(
  root: string,
  request: SearchRequest,
  options: { policyContext?: PolicyContext } = {},
): Promise<SearchResponse | undefined> {
  const opened = await openCurrentPostgresRuntime(root, postgresRuntimeSearchEnabled);
  if (!opened) {
    return undefined;
  }
  const { sql, repo, workspaceId } = opened;
  try {
    const query = request.query.trim();
    if (!query) {
      throw new Error("Search query cannot be empty");
    }
    const persona = request.persona ?? "default";
    const limit = Math.min(Math.max(request.limit ?? 20, 1), 200);
    const offset = Math.min(Math.max(Math.trunc(request.offset ?? 0), 0), 10000);
    const fetchLimit = Math.min(Math.max((limit + offset + 1) * 5, 100), POSTGRES_SEARCH_SCAN_CAP);
    const tokens = tokenizeSearchQuery(query);
    const containsQuery = escapePostgresLikePattern(query);
    const policyContext = options.policyContext;
    const backendCapabilities = postgresSearchCapabilities(policyContext === undefined ? "none" : "prefilter_batches");
    const searchRows = policyContext === undefined
      ? await postgresSearchRowsWithoutPolicy(sql, {
          workspaceId,
          query,
          containsQuery,
          request,
          visibleTarget: offset + limit + 1,
          batchLimit: fetchLimit,
          scanLimit: Math.max(POSTGRES_SEARCH_SCAN_CAP, offset + limit + 1),
        })
      : await postgresSearchRowsVisibleToPolicy(sql, repo, {
          workspaceId,
          query,
          containsQuery,
          request,
          policyContext,
          visibleTarget: Math.max(fetchLimit, offset + limit + 1),
          batchLimit: fetchLimit,
          scanLimit: Math.max(POSTGRES_POLICY_SEARCH_SCAN_CAP, offset + limit + 1),
        });
    const candidates = searchRows.rows
      .map((row) => postgresSearchCandidateFromRow(row, tokens, request))
      .filter((candidate): candidate is PostgresSearchCandidate => candidate !== undefined);
    const weights = defaultSearchWeights(persona);
    const fused = fuseSearchRetrieverRuns(
      [
        { retriever: "exact", ids: rankedPostgresIds(candidates, "exact") },
        { retriever: "bm25", ids: rankedPostgresIds(candidates, "fts") },
      ],
      weights,
      DEFAULT_OPENWIKI_SEARCH_CONFIG.rrf_k,
    );
    const candidateById = new Map(candidates.map((candidate) => [candidate.result.id, candidate]));
    const scored = fused
      .map((entry) => {
        const candidate = candidateById.get(entry.id);
        if (!candidate) {
          return undefined;
        }
        return {
          ...candidate.result,
          score: entry.explain.total_score,
          ...(request.include_explain
            ? {
                explain: {
                  retrieval: entry.explain,
                  backend: "postgres",
                  permission_filter: policyContext === undefined ? "not_requested" : "applied_before_fusion",
                  fts_rank: candidate.ftsRank,
                  exact_rank: candidate.exactRank,
                },
              }
            : {}),
        } satisfies SearchResult;
      })
      .filter((candidate): candidate is SearchResult => candidate !== undefined)
      .sort((left, right) => right.score - left.score || right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id));
    const windowed = scored.slice(offset, offset + limit);
    const relation = searchRows.scanCapped ? "capped" : "exact";
    return openWikiSearchResponse({
      serving_layer: "postgres",
      results: windowed,
      total: scored.length,
      total_relation: relation,
      truncated: scored.length > offset + limit,
      persona,
      facets: postgresSearchFacets(candidates),
      facets_relation: relation,
      ...(scored.length > offset + windowed.length ? { next_cursor: openWikiOffsetCursor(offset + windowed.length) } : {}),
      ...(request.include_explain
        ? {
            explain: {
              query_tokens: tokens,
              mode: request.mode ?? "lexical",
              fuzzy: false,
              rrf: { enabled: true, k: DEFAULT_OPENWIKI_SEARCH_CONFIG.rrf_k, overfetch: 5, fetch_limit: searchRows.scannedRows },
              retrievers_used: retrieversUsedForPostgres(candidates),
              retriever_stats: {
                exact: { enabled: true, weight: weights.exact, candidate_count: candidates.filter((candidate) => candidate.exactRank > 0).length },
                bm25: { enabled: true, weight: weights.bm25, candidate_count: candidates.filter((candidate) => candidate.ftsRank > 0).length },
                vector: { enabled: false, weight: weights.vector, candidate_count: 0 },
              },
              ranking_signals: ["postgres_runtime_search_documents", "postgres_fts", "permission_prefilter"],
              reranker: { enabled: false, applied: false, top_n: 0 },
              diagnostics: {
                backend: "postgres",
                candidate_strategy: policyContext === undefined ? "postgres_fts_lexical" : "postgres_fts_lexical_policy_batches",
                capabilities: backendCapabilities,
                disabled_retrievers: disabledPostgresSearchRetrievers(request),
                candidate_ids: candidates.length,
                record_json_reads: candidates.length,
                scanned_rows: searchRows.scannedRows,
                ...(policyContext === undefined
                  ? {}
                  : {
                      policy_scan_capped: searchRows.scanCapped,
                      policy_scan_cap_rows: POSTGRES_POLICY_SEARCH_SCAN_CAP,
                    }),
              },
            },
          }
        : {}),
    });
  } finally {
    await opened.close();
  }
}

async function postgresSearchRowsWithoutPolicy(
  sql: PostgresSql,
  input: {
    workspaceId: string;
    query: string;
    containsQuery: string;
    request: SearchRequest;
    visibleTarget: number;
    batchLimit: number;
    scanLimit: number;
  },
): Promise<{ rows: Array<Record<string, unknown>>; scannedRows: number; scanCapped: boolean }> {
  const rows: Array<Record<string, unknown>> = [];
  let scannedRows = 0;
  let exhausted = false;
  const scanLimit = Math.min(Math.max(input.scanLimit, 1), POSTGRES_SEARCH_SCAN_CAP);
  while (rows.length < input.visibleTarget && scannedRows < scanLimit) {
    const batchLimit = Math.min(input.batchLimit, scanLimit - scannedRows);
    const batch = await postgresSearchRows(sql, {
      workspaceId: input.workspaceId,
      query: input.query,
      containsQuery: input.containsQuery,
      limit: batchLimit,
      offset: scannedRows,
    });
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    for (const row of batch) {
      if (postgresSearchRowMatchesRequest(row, input.request)) {
        rows.push(row);
      }
    }
    scannedRows += batch.length;
    if (batch.length < batchLimit) {
      exhausted = true;
      break;
    }
  }
  return { rows, scannedRows, scanCapped: !exhausted };
}

function postgresSearchCapabilities(permissionFilter: SearchBackendCapabilities["permission_filter"]): SearchBackendCapabilities {
  return {
    backend: "postgres",
    retrievers: ["exact", "bm25"],
    unsupported_retrievers: ["ngram", "fuzzy", "graph", "vector"],
    fuzzy: false,
    ngram: false,
    graph: false,
    vector: false,
    permission_filter: permissionFilter,
    max_limit: 200,
    max_offset: 10000,
  };
}

function disabledPostgresSearchRetrievers(request: SearchRequest): SearchRetriever[] {
  const disabled = new Set<SearchRetriever>();
  if (request.mode === "hybrid") {
    disabled.add("ngram");
    disabled.add("graph");
    disabled.add("vector");
  }
  if (request.fuzzy === true) {
    disabled.add("fuzzy");
  }
  return [...disabled].sort();
}

async function postgresSearchRows(
  sql: PostgresSql,
  input: {
    workspaceId: string;
    query: string;
    containsQuery: string;
    limit: number;
    offset: number;
  },
): Promise<Array<Record<string, unknown>>> {
  const candidateLimit = input.limit + input.offset;
  return sql<Array<Record<string, unknown>>>`
    WITH search_query AS (
      SELECT websearch_to_tsquery('simple', ${input.query}) AS tsq
    ),
    fts_matches AS (
      SELECT
        d.workspace_id,
        d.record_id,
        ts_rank_cd(to_tsvector('simple', d.search_text), search_query.tsq) AS fts_rank
      FROM search_documents d
      CROSS JOIN search_query
      WHERE d.workspace_id = ${input.workspaceId}
        AND search_query.tsq @@ to_tsvector('simple', d.search_text)
      ORDER BY fts_rank DESC, d.record_id ASC
      LIMIT ${candidateLimit}
    ),
    exact_matches AS (
      SELECT
        r.workspace_id,
        r.record_id,
        CASE
          WHEN lower(r.record_id) = lower(${input.query}) OR lower(r.title) = lower(${input.query}) THEN 4
          WHEN lower(r.record_id) LIKE ${input.containsQuery} ESCAPE ${POSTGRES_LIKE_ESCAPE} OR lower(r.title) LIKE ${input.containsQuery} ESCAPE ${POSTGRES_LIKE_ESCAPE} OR lower(r.path) LIKE ${input.containsQuery} ESCAPE ${POSTGRES_LIKE_ESCAPE} THEN 2
          ELSE 0
        END AS exact_rank
      FROM records r
      WHERE r.workspace_id = ${input.workspaceId}
        AND (
          lower(r.record_id) = lower(${input.query})
          OR lower(r.title) = lower(${input.query})
          OR lower(r.record_id) LIKE ${input.containsQuery} ESCAPE ${POSTGRES_LIKE_ESCAPE}
          OR lower(r.title) LIKE ${input.containsQuery} ESCAPE ${POSTGRES_LIKE_ESCAPE}
          OR lower(r.path) LIKE ${input.containsQuery} ESCAPE ${POSTGRES_LIKE_ESCAPE}
        )
      LIMIT ${candidateLimit}
    ),
    candidate_ids AS (
      SELECT workspace_id, record_id FROM fts_matches
      UNION
      SELECT workspace_id, record_id FROM exact_matches
    )
    SELECT
      r.record_id,
      r.record_type,
      r.title,
      r.summary,
      r.uri,
      r.path,
      r.status,
      r.updated_at,
      d.search_text,
      d.topics_json,
      d.source_ids_json,
      COALESCE(f.fts_rank, 0) AS fts_rank,
      COALESCE(e.exact_rank, 0) AS exact_rank
    FROM candidate_ids c
    JOIN records r ON r.workspace_id = c.workspace_id AND r.record_id = c.record_id
    JOIN search_documents d ON d.workspace_id = c.workspace_id AND d.record_id = c.record_id
    LEFT JOIN fts_matches f ON f.workspace_id = c.workspace_id AND f.record_id = c.record_id
    LEFT JOIN exact_matches e ON e.workspace_id = c.workspace_id AND e.record_id = c.record_id
    WHERE r.workspace_id = ${input.workspaceId}
      AND (COALESCE(f.fts_rank, 0) > 0 OR COALESCE(e.exact_rank, 0) > 0)
    ORDER BY fts_rank DESC, exact_rank DESC, r.updated_at DESC, r.record_id ASC
    LIMIT ${input.limit}
    OFFSET ${input.offset}
  `;
}

export async function postgresSearchRowsVisibleToPolicy(
  sql: PostgresSql,
  repo: LoadedOpenWikiRepo,
  input: {
    workspaceId: string;
    query: string;
    containsQuery: string;
    request: SearchRequest;
    policyContext: PolicyContext;
    visibleTarget: number;
    batchLimit: number;
    scanLimit: number;
  },
): Promise<{ rows: Array<Record<string, unknown>>; scannedRows: number; scanCapped: boolean }> {
  const rows: Array<Record<string, unknown>> = [];
  let scannedRows = 0;
  let exhausted = false;
  const scanLimit = Math.min(Math.max(input.scanLimit, 1), POSTGRES_POLICY_SEARCH_SCAN_CAP);
  while (rows.length < input.visibleTarget && scannedRows < scanLimit) {
    const batchLimit = Math.min(input.batchLimit, scanLimit - scannedRows);
    const batch = await postgresSearchRows(sql, {
      workspaceId: input.workspaceId,
      query: input.query,
      containsQuery: input.containsQuery,
      limit: batchLimit,
      offset: scannedRows,
    });
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    for (const row of batch) {
      if (postgresSearchRowMatchesRequest(row, input.request) && postgresSearchRowAllowedForPolicy(repo, row, input.policyContext)) {
        rows.push(row);
      }
    }
    scannedRows += batch.length;
    if (batch.length < batchLimit) {
      exhausted = true;
      break;
    }
  }
  return { rows, scannedRows, scanCapped: !exhausted };
}

export function escapePostgresLikePattern(query: string): string {
  let escaped = "";
  for (const character of query.toLowerCase()) {
    if (character === POSTGRES_LIKE_ESCAPE || character === "%" || character === "_") {
      escaped += POSTGRES_LIKE_ESCAPE;
    }
    escaped += character;
  }
  return `%${escaped}%`;
}

export function postgresSearchRowAllowedForPolicy(
  repo: LoadedOpenWikiRepo,
  row: Record<string, unknown>,
  context: PolicyContext,
): boolean {
  const id = stringField(row, "record_id") ?? "";
  const type = stringField(row, "record_type") ?? "record";
  const rowPath = stringField(row, "path");
  return canReadRecordReference(repo, context, {
    id,
    type,
    ...(rowPath === undefined ? {} : { path: rowPath }),
    source_ids: parseJsonStringArray(row.source_ids_json),
  });
}

function postgresSearchRowMatchesRequest(row: Record<string, unknown>, request: SearchRequest): boolean {
  const type = stringField(row, "record_type") ?? "record";
  const updatedAt = dateStringField(row, "updated_at") ?? "";
  const topics = parseJsonStringArray(row.topics_json);
  const status = stringField(row, "status");
  return typeAllowed(type, request.types) && searchFiltersAllowed(topics, status, updatedAt, request.filters);
}

interface PostgresSearchCandidate {
  result: SearchResult;
  status?: string;
  topics: string[];
  ftsRank: number;
  exactRank: number;
}

function postgresSearchCandidateFromRow(
  row: Record<string, unknown>,
  tokens: string[],
  request: SearchRequest,
): PostgresSearchCandidate | undefined {
  const id = stringField(row, "record_id") ?? "";
  const type = stringField(row, "record_type") ?? "record";
  const title = stringField(row, "title") ?? id;
  const summary = stringField(row, "summary");
  const rowPath = stringField(row, "path");
  const uri = stringField(row, "uri") ?? idToUri(id);
  const updatedAt = dateStringField(row, "updated_at") ?? "";
  const searchText = [stringField(row, "search_text") ?? "", title, summary ?? "", id].join(" ").toLowerCase();
  const topics = parseJsonStringArray(row.topics_json);
  const sourceIds = parseJsonStringArray(row.source_ids_json);
  const status = stringField(row, "status");
  if (!typeAllowed(type, request.types) || !searchFiltersAllowed(topics, status, updatedAt, request.filters)) {
    return undefined;
  }
  const ftsRank = numberField(row, "fts_rank");
  const exactRank = numberField(row, "exact_rank");
  if (ftsRank <= 0 && exactRank <= 0) {
    return undefined;
  }
  return {
    result: {
      id,
      type,
      title,
      ...(summary === undefined ? {} : { summary }),
      uri,
      ...(rowPath === undefined ? {} : { path: rowPath }),
      score: 0,
      matched_fields: ftsRank > 0 ? ["postgres.search_documents.fts"] : ["postgres.search_documents.exact"],
      citations: sourceIds.map((sourceId) => ({ source_id: sourceId })),
      updated_at: updatedAt,
      ...(request.include_highlights ? { highlights: { body: tokens.filter((token) => searchText.includes(token)) } } : {}),
    },
    ...(status === undefined ? {} : { status }),
    topics,
    ftsRank,
    exactRank,
  };
}

function postgresSearchFacets(candidates: PostgresSearchCandidate[]): SearchFacets {
  return openWikiSearchFacetsFromItems(candidates.map((candidate) => ({
    id: candidate.result.id,
    type: candidate.result.type,
    ...(candidate.status === undefined ? {} : { status: candidate.status }),
    topics: candidate.topics,
  })));
}

function rankedPostgresIds(candidates: PostgresSearchCandidate[], mode: "exact" | "fts"): string[] {
  const score = mode === "exact" ? (candidate: PostgresSearchCandidate) => candidate.exactRank : (candidate: PostgresSearchCandidate) => candidate.ftsRank;
  return candidates
    .filter((candidate) => score(candidate) > 0)
    .sort(
      (left, right) =>
        score(right) - score(left) ||
        right.result.updated_at.localeCompare(left.result.updated_at) ||
        left.result.id.localeCompare(right.result.id),
    )
    .map((candidate) => candidate.result.id);
}

function defaultSearchWeights(persona: SearchRequest["persona"]): Record<SearchRetriever, number> {
  const key = persona ?? "default";
  return { ...DEFAULT_OPENWIKI_SEARCH_CONFIG.persona_weights[key] };
}

function retrieversUsedForPostgres(candidates: PostgresSearchCandidate[]): SearchRetriever[] {
  const used: SearchRetriever[] = [];
  if (candidates.some((candidate) => candidate.exactRank > 0)) {
    used.push("exact");
  }
  if (candidates.some((candidate) => candidate.ftsRank > 0)) {
    used.push("bm25");
  }
  return used;
}

function tokenizeSearchQuery(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9:_-]+/u).map((token) => token.trim()).filter(Boolean);
}

export function typeAllowed(type: string, types: string[] | undefined): boolean {
  return types === undefined || types.length === 0 || types.includes(type);
}

function searchFiltersAllowed(
  topics: string[],
  status: string | undefined,
  updatedAt: string,
  filters: SearchRequest["filters"] | undefined,
): boolean {
  if (!filters) {
    return true;
  }
  if (filters.topics !== undefined && filters.topics.length > 0 && !filters.topics.some((topic) => topics.includes(topic))) {
    return false;
  }
  if (filters.status !== undefined && filters.status.length > 0 && (status === undefined || !filters.status.includes(status))) {
    return false;
  }
  if (filters.updated_after !== undefined && updatedAt < filters.updated_after) {
    return false;
  }
  return true;
}

export function proposalTargetsPath(proposal: ProposalRecord, targetPath: string): boolean {
  return openWikiProposalTargetsPath(proposal, targetPath);
}

export function proposalSectionIds(proposal: ProposalRecord, sections: Array<{ id: string; paths: string[] }>): string[] {
  return openWikiProposalSectionIds(proposal, sections);
}

export function proposalTargetPaths(proposal: ProposalRecord): string[] {
  return openWikiProposalTargetPaths(proposal);
}

export function proposalUpdatedAt(proposal: ProposalRecord): string {
  return openWikiProposalUpdatedAt(proposal);
}
