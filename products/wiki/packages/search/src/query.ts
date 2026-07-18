import { type IndexRecord, searchIndexRecordFromJson } from "./records.ts";
import {
  openWikiOffsetCursor,
  openWikiRuntimeModeFromEnvOrProfile,
  openWikiRuntimeModeRequiresHostedStores,
  OpenWikiValidationError,
  openWikiSearchFacetsFromItems,
  openWikiSearchResponse,
  type SearchFacets,
  type SearchBackendCapabilities,
  type SearchPersona,
  type SearchRequest,
  type SearchResponse,
  type SearchRetriever,
  tokenizeOpenWikiText,
} from "@openwiki/core";
import { type PolicyContext } from "@openwiki/policy";
import { searchCurrentPostgresRuntime } from "@openwiki/postgres-runtime";
import { type LoadedOpenWikiRepo, readConfig } from "@openwiki/repo";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { exists, loadRepositoryForSearchIndex, readAllRecords, readSearchIndexMetadata } from "./cache.ts";
import { embeddingEnabled } from "./chunks.ts";
import { resolveSearchConfig } from "./config.ts";
import { filtersAllowed, typeAllowed } from "./filters.ts";
import { buildSearchIndex } from "./indexer.ts";
import { rankingSignalMultiplier, rankingSignalsForRecord } from "./ranking-signals.ts";
import { buildSearchExplain, compareSearchCandidates, enabledRetrievers, resultFromRecord } from "./ranking.ts";
import { indexRecordAllowedForPolicy } from "./record-builders.ts";
import { runRetrievers, weightedRrf } from "./retrievers.ts";
import { facetsFromRows, indexedRetrieverRows, rowsById, uniqueIds } from "./sqlite.ts";
import { isRecoverableIndexError, roundScore } from "./text.ts";
import { SEARCH_RETRIEVERS, SQLITE_SEARCH_OFFSET_MAX, type IndexedSearchResult, type IndexedSearchRow, type RankedCandidate, type ResolvedSearchConfig, type RetrieverRun, type RetrieverStats, type SearchExplainSettings, type SearchIndexMetadata, type SearchWikiOptions } from "./types.ts";

export async function searchWiki(root: string, request: SearchRequest, options: SearchWikiOptions = {}): Promise<SearchResponse> {
  const postgresResponse = await searchCurrentPostgresRuntime(root, request, {
    ...(options.policyContext === undefined ? {} : { policyContext: options.policyContext }),
  });
  if (postgresResponse !== undefined) {
    return postgresResponse;
  }
  const resolvedRoot = path.resolve(root);
  const dbPath = path.join(resolvedRoot, ".openwiki", "index", "openwiki.sqlite");
  const config = await readConfig(resolvedRoot);
  const runtimeMode = openWikiRuntimeModeFromEnvOrProfile(process.env, config.runtime?.profile);
  const hostedStoresRequired = openWikiRuntimeModeRequiresHostedStores(runtimeMode);
  const allowIndexBuild = options.allowIndexBuild ?? !hostedStoresRequired;
  const allowFullScanFallback = options.allowFullScanFallback ?? !hostedStoresRequired;
  if (!(await exists(dbPath))) {
    if (!allowIndexBuild) {
      throw new OpenWikiValidationError(`Search index is missing and request-path rebuilds are disabled in ${runtimeMode} runtime mode; run a worker/index sync or configure OPENWIKI_SEARCH_BACKEND=postgres`);
    }
    await buildSearchIndex(resolvedRoot);
  }

  const query = request.query.trim();
  if (!query) {
    throw new OpenWikiValidationError("Search query cannot be empty");
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const db = new DatabaseSync(dbPath);
    const startedAt = performance.now();
    try {
      const metadata = await readSearchIndexMetadata(db, dbPath);
      const repo = await loadRepositoryForSearchIndex(resolvedRoot, dbPath, metadata);
      const searchConfig = resolveSearchConfig(repo.config.search);
      if (query.length > searchConfig.max_query_length) {
        throw new OpenWikiValidationError(`Search query exceeds max_query_length ${searchConfig.max_query_length}`);
      }
      const persona = request.persona ?? searchConfig.default_persona;
      const limit = Math.min(Math.max(request.limit ?? searchConfig.default_limit, 1), searchConfig.max_limit);
      const offset = Math.min(Math.max(Math.trunc(request.offset ?? 0), 0), SQLITE_SEARCH_OFFSET_MAX);
      const fetchLimit = Math.min((limit + offset) * searchConfig.overfetch, searchConfig.max_limit * searchConfig.overfetch);
      const mode = request.mode ?? "hybrid";
      const queryTokens = tokenizeOpenWikiText(query);
      const fuzzyEnabled = Boolean(request.fuzzy && searchConfig.enabled_retrievers.fuzzy);
      const weights = searchConfig.persona_weights[persona];
      const indexed = indexedSearchResponse({
        db,
        repo,
        request,
        ...(options.policyContext === undefined ? {} : { policyContext: options.policyContext }),
        query,
        queryTokens,
        persona,
        mode,
        fuzzyEnabled,
        searchConfig,
        weights,
        limit,
        offset,
        fetchLimit,
        metadata,
        startedAt,
      });
      if (indexed.complete) {
        return indexed.response;
      }
      if (!allowFullScanFallback) {
        throw new OpenWikiValidationError(`Search full-scan fallback is disabled in ${runtimeMode} runtime mode; use indexed lexical search or configure OPENWIKI_SEARCH_BACKEND=postgres`);
      }

      const records = readAllRecords(db);
      const candidateRecords = records.filter(
        (record) =>
          typeAllowed(record.type, request.types) &&
          filtersAllowed(record, request.filters) &&
          indexRecordAllowedForPolicy(repo, record, options.policyContext),
      );
      const facets = searchFacets(candidateRecords);
      const candidateIds = new Set(candidateRecords.map((record) => record.id));
      const { runs, retrieverStats } = runRetrievers({
        db,
        records: candidateRecords,
        candidateIds,
        pages: repo.pages,
        sources: repo.sources,
        claims: repo.claims,
        query,
        fetchLimit,
        mode,
        fuzzyEnabled,
        searchConfig,
        weights,
      });
      const rankings = runs
        .filter((run) => run.ids.length > 0)
        .map((run) => [run.retriever, run.ids] as [SearchRetriever, string[]]);
      const fused = weightedRrf(rankings, weights, searchConfig.rrf_k);
      const recordById = new Map(candidateRecords.map((record) => [record.id, record]));
      const candidates: RankedCandidate[] = [];
      for (const { id, explain } of fused) {
        const record = recordById.get(id);
        if (record) {
          const signals = rankingSignalsForRecord(record, repo.sources, repo.claims, repo.proposals, repo.decisions);
          candidates.push({
            record,
            retrieval: explain,
            ranking_signals: signals,
            final_score: explain.total_score * rankingSignalMultiplier(signals),
          });
        }
      }
      candidates.sort(compareSearchCandidates);

      const windowed = candidates.slice(offset, offset + limit);
      const retrieversUsed = runs.filter((run) => run.ids.length > 0).map((run) => run.retriever);
      const explainSettings: SearchExplainSettings = {
        mode,
        fuzzy: fuzzyEnabled,
        rrf_k: searchConfig.rrf_k,
        overfetch: searchConfig.overfetch,
        enabled_retrievers: enabledRetrievers(mode, fuzzyEnabled, searchConfig),
      };
      const results = windowed.map((candidate) => resultFromRecord(candidate, request, explainSettings));
      const response = openWikiSearchResponse({
        serving_layer: "sqlite",
        results,
        total: candidates.length,
        total_relation: "exact",
        truncated: candidates.length > offset + limit,
        persona,
        facets,
        facets_relation: "exact",
        ...(candidates.length > offset + results.length ? { next_cursor: openWikiOffsetCursor(offset + results.length) } : {}),
      });
      if (request.include_explain) {
        response.explain = buildSearchExplain({
          mode,
          fuzzyEnabled,
          fetchLimit,
          rrfK: searchConfig.rrf_k,
          overfetch: searchConfig.overfetch,
          retrieverStats,
          retrieversUsed,
          queryTokens,
          diagnostics: {
            backend: "sqlite",
            candidate_strategy: "full_scan_fallback",
            capabilities: sqliteSearchCapabilities(searchConfig, options.policyContext === undefined ? "none" : "post_filter"),
            disabled_retrievers: disabledSqliteSearchRetrievers(request, mode, fuzzyEnabled, searchConfig),
            index_content_hash: metadata.contentHash,
            index_record_count: metadata.recordCount,
            ...(embeddingEnabled(searchConfig)
              ? {
                  embedding_model: searchConfig.embedding.model,
                  embedding_dimensions: searchConfig.embedding.dimensions,
                  embedding_provider: searchConfig.embedding.provider,
                }
              : {}),
            candidate_ids: candidateRecords.length,
            record_json_reads: records.length,
            scanned_rows: records.length,
            elapsed_ms: roundScore(performance.now() - startedAt),
          },
        });
      }
      return response;
    } catch (error) {
      if (attempt === 0 && isRecoverableIndexError(error)) {
        if (!allowIndexBuild) {
          throw new OpenWikiValidationError(`Search index is stale or unreadable and request-path rebuilds are disabled in ${runtimeMode} runtime mode; run a worker/index sync or configure OPENWIKI_SEARCH_BACKEND=postgres`);
        }
        await buildSearchIndex(resolvedRoot);
        continue;
      }
      throw error;
    } finally {
      db.close();
    }
  }

  throw new OpenWikiValidationError("Search index could not be read");
}

function searchFacets(records: IndexRecord[]): SearchFacets {
  return openWikiSearchFacetsFromItems(records.map((record) => ({ id: record.id, type: record.type, status: record.status, topics: record.topics })));
}

function indexedSearchResponse(input: {
  db: DatabaseSync;
  repo: LoadedOpenWikiRepo;
  request: SearchRequest;
  policyContext?: PolicyContext;
  query: string;
  queryTokens: string[];
  persona: SearchPersona;
  mode: "lexical" | "hybrid";
  fuzzyEnabled: boolean;
  searchConfig: ResolvedSearchConfig;
  weights: Record<SearchRetriever, number>;
  limit: number;
  offset: number;
  fetchLimit: number;
  metadata: SearchIndexMetadata;
  startedAt: number;
}): IndexedSearchResult {
  if (!canUseIndexedCandidateSearch(input)) {
    return { complete: false, response: emptySearchResponse(input) };
  }

  const rowSearch = indexedRetrieverRows(input);
  const runs: RetrieverRun[] = [];
  const retrieverStats: Partial<Record<SearchRetriever, RetrieverStats>> = {};
  const pushRun = (retriever: SearchRetriever, enabled: boolean, rows: IndexedSearchRow[]): void => {
    const ids = uniqueIds(rows.map((row) => row.id)).slice(0, input.fetchLimit);
    retrieverStats[retriever] = {
      enabled,
      weight: input.weights[retriever] ?? 1,
      candidate_count: ids.length,
    };
    if (enabled) {
      runs.push({ retriever, ids });
    }
  };

  pushRun("exact", input.searchConfig.enabled_retrievers.exact, rowSearch.exactRows);
  pushRun("bm25", input.searchConfig.enabled_retrievers.bm25, rowSearch.bm25Rows);
  retrieverStats.ngram = {
    enabled: input.searchConfig.enabled_retrievers.ngram,
    weight: input.weights.ngram ?? 1,
    candidate_count: 0,
  };
  retrieverStats.fuzzy = {
    enabled: input.fuzzyEnabled,
    weight: input.weights.fuzzy ?? 1,
    candidate_count: 0,
  };
  retrieverStats.graph = {
    enabled: input.mode === "hybrid" && input.searchConfig.enabled_retrievers.graph,
    weight: input.weights.graph ?? 1,
    candidate_count: 0,
  };
  pushRun(
    "vector",
    input.mode === "hybrid" && input.searchConfig.enabled_retrievers.vector && embeddingEnabled(input.searchConfig),
    rowSearch.vectorRows,
  );

  const rankings = runs
    .filter((run) => run.ids.length > 0)
    .map((run) => [run.retriever, run.ids] as [SearchRetriever, string[]]);
  const fused = weightedRrf(rankings, input.weights, input.searchConfig.rrf_k);
  const rowById = rowsById([...rowSearch.exactRows, ...rowSearch.bm25Rows, ...rowSearch.vectorRows]);
  const recordsById = new Map<string, IndexRecord>();
  let recordJsonReads = 0;
  for (const { id } of fused) {
    const row = rowById.get(id);
    if (!row || recordsById.has(id)) {
      continue;
    }
    const record = searchIndexRecordFromJson(row.json);
    recordJsonReads += 1;
    if (
      typeAllowed(record.type, input.request.types) &&
      filtersAllowed(record, input.request.filters) &&
      indexRecordAllowedForPolicy(input.repo, record, input.policyContext)
    ) {
      recordsById.set(id, record);
    }
  }

  const candidates: RankedCandidate[] = [];
  for (const { id, explain } of fused) {
    const record = recordsById.get(id);
    if (!record) {
      continue;
    }
    const signals = rankingSignalsForRecord(record, input.repo.sources, input.repo.claims, input.repo.proposals, input.repo.decisions);
    candidates.push({
      record,
      retrieval: explain,
      ranking_signals: signals,
      final_score: explain.total_score * rankingSignalMultiplier(signals),
    });
  }
  candidates.sort(compareSearchCandidates);

  const fallbackCouldAddResults =
    input.searchConfig.enabled_retrievers.ngram ||
    (input.mode === "hybrid" && input.searchConfig.enabled_retrievers.graph);
  const complete =
    candidates.length === 0 && fallbackCouldAddResults
      ? false
      : rowSearch.exhausted ||
        candidates.length >= input.offset + input.limit ||
        !fallbackCouldAddResults;
  if (!complete) {
    return { complete: false, response: emptySearchResponse(input) };
  }

  const windowed = candidates.slice(input.offset, input.offset + input.limit);
  const retrieversUsed = runs.filter((run) => run.ids.length > 0).map((run) => run.retriever);
  const explainSettings: SearchExplainSettings = {
    mode: input.mode,
    fuzzy: input.fuzzyEnabled,
    rrf_k: input.searchConfig.rrf_k,
    overfetch: input.searchConfig.overfetch,
    enabled_retrievers: enabledRetrievers(input.mode, input.fuzzyEnabled, input.searchConfig),
  };
  const results = windowed.map((candidate) => resultFromRecord(candidate, input.request, explainSettings));
  const hasMore = candidates.length > input.offset + input.limit || !rowSearch.exhausted;
  const indexedRelation = rowSearch.exhausted ? "exact" : "capped";
  const response = openWikiSearchResponse({
    serving_layer: "sqlite",
    results,
    total: candidates.length,
    total_relation: indexedRelation,
    truncated: hasMore,
    persona: input.persona,
    facets: facetsFromRows([...rowSearch.exactRows, ...rowSearch.bm25Rows, ...rowSearch.vectorRows]),
    facets_relation: indexedRelation,
    ...(hasMore && results.length > 0 ? { next_cursor: openWikiOffsetCursor(input.offset + results.length) } : {}),
  });
  if (input.request.include_explain) {
    response.explain = buildSearchExplain({
      mode: input.mode,
      fuzzyEnabled: input.fuzzyEnabled,
      fetchLimit: input.fetchLimit,
      rrfK: input.searchConfig.rrf_k,
      overfetch: input.searchConfig.overfetch,
      retrieverStats,
      retrieversUsed,
      queryTokens: input.queryTokens,
      diagnostics: {
        backend: "sqlite",
        candidate_strategy: rowSearch.vectorRows.length > 0 ? "indexed_hybrid_vector" : "indexed_lexical",
        capabilities: sqliteSearchCapabilities(input.searchConfig, input.policyContext === undefined ? "none" : "post_filter"),
        disabled_retrievers: disabledSqliteSearchRetrievers(input.request, input.mode, input.fuzzyEnabled, input.searchConfig, rowSearch.disabledRetrievers),
        index_content_hash: input.metadata.contentHash,
        index_record_count: input.metadata.recordCount,
        ...(embeddingEnabled(input.searchConfig)
          ? {
              embedding_model: input.searchConfig.embedding.model,
              embedding_dimensions: input.searchConfig.embedding.dimensions,
              embedding_provider: input.searchConfig.embedding.provider,
            }
          : {}),
        candidate_ids: rowById.size,
        record_json_reads: recordJsonReads,
        scanned_rows: rowSearch.scannedRows,
        elapsed_ms: roundScore(performance.now() - input.startedAt),
      },
    });
  }
  return { complete: true, response };
}

function sqliteSearchCapabilities(searchConfig: ResolvedSearchConfig, permissionFilter: SearchBackendCapabilities["permission_filter"]): SearchBackendCapabilities {
  return {
    backend: "sqlite",
    retrievers: SEARCH_RETRIEVERS.filter((retriever) =>
      retriever === "vector"
        ? searchConfig.enabled_retrievers.vector && embeddingEnabled(searchConfig)
        : searchConfig.enabled_retrievers[retriever]
    ),
    unsupported_retrievers: [],
    fuzzy: searchConfig.enabled_retrievers.fuzzy,
    ngram: searchConfig.enabled_retrievers.ngram,
    graph: searchConfig.enabled_retrievers.graph,
    vector: searchConfig.enabled_retrievers.vector && embeddingEnabled(searchConfig),
    permission_filter: permissionFilter,
    max_limit: searchConfig.max_limit,
    max_offset: SQLITE_SEARCH_OFFSET_MAX,
  };
}

function disabledSqliteSearchRetrievers(
  request: SearchRequest,
  mode: "lexical" | "hybrid",
  fuzzyEnabled: boolean,
  searchConfig: ResolvedSearchConfig,
  runtimeDisabled: SearchRetriever[] = [],
): SearchRetriever[] {
  const disabled = new Set<SearchRetriever>(runtimeDisabled);
  for (const retriever of SEARCH_RETRIEVERS) {
    if (!searchConfig.enabled_retrievers[retriever]) {
      disabled.add(retriever);
    }
  }
  if (request.fuzzy === true && !fuzzyEnabled) {
    disabled.add("fuzzy");
  }
  if (mode !== "hybrid") {
    disabled.add("graph");
    disabled.add("vector");
  }
  if (mode === "hybrid" && (!searchConfig.enabled_retrievers.vector || !embeddingEnabled(searchConfig))) {
    disabled.add("vector");
  }
  return [...disabled].sort();
}

function canUseIndexedCandidateSearch(input: {
  fuzzyEnabled: boolean;
  searchConfig: ResolvedSearchConfig;
}): boolean {
  return !input.fuzzyEnabled && (
    input.searchConfig.enabled_retrievers.exact ||
    input.searchConfig.enabled_retrievers.bm25 ||
    (input.searchConfig.enabled_retrievers.vector && embeddingEnabled(input.searchConfig))
  );
}

function emptySearchResponse(input: { persona: SearchPersona }): SearchResponse {
  return openWikiSearchResponse({
    serving_layer: "sqlite",
    results: [],
    total: 0,
    total_relation: "exact",
    truncated: false,
    persona: input.persona,
  });
}
