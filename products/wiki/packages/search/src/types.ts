import type { IndexRecord } from "./records.ts";
import type { OpenWikiSearchEmbeddingConfig, SearchExplain, SearchFusionExplain, SearchPersona, SearchResponse, SearchRetriever } from "@openwiki/core";
import type { PolicyContext } from "@openwiki/policy";

export interface SearchIndexResult {
  root: string;
  dbPath: string;
  recordCount: number;
  contentHash: string;
}

export interface SearchCorpusRecord {
  id: string;
  type: string;
  title: string;
  summary: string;
  uri: string;
  path: string;
  topics: string[];
  source_ids: string[];
  status: string;
  updated_at: string;
  search_text: string;
  url?: string;
}

export interface SearchCorpus {
  generated_at: string;
  visibility: "public" | "internal";
  record_count: number;
  records: SearchCorpusRecord[];
}

export type RetrievalExplain = SearchFusionExplain;

export interface ResolvedSearchConfig {
  default_persona: SearchPersona;
  default_limit: number;
  max_limit: number;
  max_query_length: number;
  overfetch: number;
  rrf_k: number;
  ngram_min: number;
  fuzzy_min_length: number;
  fuzzy_mid_length: number;
  fuzzy_max_distance: number;
  embedding: Required<OpenWikiSearchEmbeddingConfig>;
  enabled_retrievers: Record<SearchRetriever, boolean>;
  persona_weights: Record<SearchPersona, Record<SearchRetriever, number>>;
}

export interface SearchExplainSettings {
  mode: "lexical" | "hybrid";
  fuzzy: boolean;
  rrf_k: number;
  overfetch: number;
  enabled_retrievers: SearchRetriever[];
}

export interface RetrieverRun {
  retriever: SearchRetriever;
  ids: string[];
}

export interface RetrieverStats {
  enabled: boolean;
  weight: number;
  candidate_count: number;
}

export interface RankingSignals {
  source_reliability: number;
  citation_density: number;
  claim_confidence: number;
  decision_support: number;
}

export interface RankedCandidate {
  record: IndexRecord;
  retrieval: RetrievalExplain;
  ranking_signals: RankingSignals;
  final_score: number;
}

export interface SearchRuntimeSettings {
  mode: "lexical" | "hybrid";
  fuzzyEnabled: boolean;
  fetchLimit: number;
  rrfK: number;
  overfetch: number;
  retrieverStats: Partial<Record<SearchRetriever, RetrieverStats>>;
  retrieversUsed: SearchRetriever[];
  queryTokens: string[];
  diagnostics?: SearchExplain["diagnostics"];
}

export interface SearchIndexMetadata {
  schemaVersion: string;
  generatedAt: string;
  recordCount: number;
  contentHash: string;
}

export interface IndexedSearchRow {
  id: string;
  type: string;
  title: string;
  summary: string;
  uri: string;
  path: string;
  status: string;
  topics_json: string;
  source_ids_json: string;
  updated_at: string;
  url: string | null;
  json: string;
  exact_rank?: number;
  bm25_rank?: number;
  vector_score?: number;
}

export interface IndexedRetrieverRows {
  exactRows: IndexedSearchRow[];
  bm25Rows: IndexedSearchRow[];
  vectorRows: IndexedSearchRow[];
  scannedRows: number;
  disabledRetrievers: SearchRetriever[];
  exhausted: boolean;
}

export interface VisibleRetrieverRows {
  rows: IndexedSearchRow[];
  scannedRows: number;
  disabledRetrievers: SearchRetriever[];
  exhausted: boolean;
}

export interface IndexedSearchResult {
  response: SearchResponse;
  complete: boolean;
}

export const SEARCH_PERSONAS: SearchPersona[] = ["default", "researcher", "editor", "reviewer", "governance"];

export const SEARCH_RETRIEVERS: SearchRetriever[] = ["exact", "bm25", "ngram", "fuzzy", "graph", "vector"];

export const RANKING_SIGNAL_NAMES = ["source_reliability", "citation_density", "claim_confidence", "decision_support"];

export const SEARCH_INDEX_SCHEMA_VERSION = "3";

export const SEARCH_INDEX_METADATA_CACHE = new Map<string, SearchIndexMetadata>();

export const SQLITE_SEARCH_SCAN_CAP = 10000;

export const SQLITE_SEARCH_BATCH_MAX = 2000;

export const SQLITE_SEARCH_OFFSET_MAX = 10000;

export interface SearchWikiOptions {
  policyContext?: PolicyContext;
  allowIndexBuild?: boolean;
  allowFullScanFallback?: boolean;
}
