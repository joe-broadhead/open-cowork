import type { SearchExplain, SearchRequest, SearchResult, SearchRetriever } from "@openwiki/core";
import { embeddingEnabled } from "./chunks.ts";
import { supportScore } from "./ranking-signals.ts";
import { highlightsForRecord, matchedFields, roundScore } from "./text.ts";
import { RANKING_SIGNAL_NAMES, SEARCH_RETRIEVERS, type RankedCandidate, type ResolvedSearchConfig, type SearchExplainSettings, type SearchRuntimeSettings } from "./types.ts";

export function resultFromRecord(
  candidate: RankedCandidate,
  request: SearchRequest,
  settings: SearchExplainSettings,
): SearchResult {
  const { record } = candidate;
  const result: SearchResult = {
    id: record.id,
    type: record.type,
    title: record.title,
    summary: record.summary,
    uri: record.uri,
    path: record.path,
    score: roundScore(candidate.final_score * 10),
    matched_fields: matchedFields(record, request.query),
    citations: record.source_ids.map((sourceId) => ({ source_id: sourceId })),
    updated_at: record.updated_at,
  };
  if (record.url) {
    result.url = record.url;
  }
  if (request.include_highlights) {
    const highlights = highlightsForRecord(record, request.query);
    if (Object.keys(highlights).length > 0) {
      result.highlights = highlights;
    }
  }
  if (request.include_explain) {
    result.explain = {
      retrieval: candidate.retrieval,
      ranking_signals: candidate.ranking_signals,
      settings,
      final_score: result.score,
    };
  }
  return result;
}

export function compareSearchCandidates(left: RankedCandidate, right: RankedCandidate): number {
  return (
    right.final_score - left.final_score ||
    supportScore(right.ranking_signals) - supportScore(left.ranking_signals) ||
    right.record.source_ids.length - left.record.source_ids.length ||
    right.record.updated_at.localeCompare(left.record.updated_at) ||
    left.record.id.localeCompare(right.record.id)
  );
}

export function buildSearchExplain(settings: SearchRuntimeSettings): SearchExplain {
  return {
    query_tokens: settings.queryTokens,
    mode: settings.mode,
    fuzzy: settings.fuzzyEnabled,
    rrf: {
      enabled: true,
      k: settings.rrfK,
      overfetch: settings.overfetch,
      fetch_limit: settings.fetchLimit,
    },
    retrievers_used: settings.retrieversUsed,
    retriever_stats: settings.retrieverStats,
    ranking_signals: RANKING_SIGNAL_NAMES,
    reranker: {
      enabled: false,
      applied: false,
      top_n: 0,
    },
    ...(settings.diagnostics === undefined ? {} : { diagnostics: settings.diagnostics }),
  };
}

export function enabledRetrievers(
  mode: "lexical" | "hybrid",
  fuzzyEnabled: boolean,
  searchConfig: ResolvedSearchConfig,
): SearchRetriever[] {
  return SEARCH_RETRIEVERS.filter((retriever) => {
    if (retriever === "fuzzy") {
      return fuzzyEnabled;
    }
    if (retriever === "graph") {
      return mode === "hybrid" && searchConfig.enabled_retrievers.graph;
    }
    if (retriever === "vector") {
      return mode === "hybrid" && searchConfig.enabled_retrievers.vector && embeddingEnabled(searchConfig);
    }
    return searchConfig.enabled_retrievers[retriever];
  });
}
