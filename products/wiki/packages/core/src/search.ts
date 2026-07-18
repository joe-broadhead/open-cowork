import { OpenWikiValidationError } from "./errors.ts";
import { normalizeOpenWikiRepoPath, openWikiPathPatternMatches } from "./paths.ts";
import type { SearchPersona, SearchRetriever } from "./config.ts";

export interface ValidationIssue {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  path?: string;
}

export interface ValidationReport {
  id: string;
  proposal_id: string;
  status: "passed" | "failed";
  checked_at: string;
  issues: ValidationIssue[];
}

export interface OpenWikiProposalPathSection {
  id: string;
  paths: string[];
}

export interface OpenWikiProposalPathRecord {
  target_path?: string;
  diff: { path: string };
  snapshot_path?: string;
  applied_at?: string;
  closed_at?: string;
  created_at: string;
}

export function validationReportFromUnknown(value: unknown, context = "OpenWiki validation report"): ValidationReport {
  const record = objectRecord(value, context);
  const status = record.status;
  if (status !== "passed" && status !== "failed") {
    throw new OpenWikiValidationError(`${context}: status must be passed or failed`);
  }
  const issues = arrayField(record, "issues", context).map((issue, index) => validationIssueFromUnknown(issue, `${context}.issues[${index}]`));
  return {
    id: stringField(record, "id", context),
    proposal_id: stringField(record, "proposal_id", context),
    status,
    checked_at: stringField(record, "checked_at", context),
    issues,
  };
}

export function openWikiProposalUpdatedAt(proposal: OpenWikiProposalPathRecord): string {
  return proposal.applied_at ?? proposal.closed_at ?? proposal.created_at;
}

export function openWikiProposalTargetPaths(proposal: OpenWikiProposalPathRecord, extraPaths: string[] = []): string[] {
  return [proposal.target_path, proposal.diff.path, proposal.snapshot_path, ...extraPaths]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(normalizeOpenWikiRepoPath)
    .filter((value, index, values) => values.indexOf(value) === index);
}

export function openWikiProposalTargetsPath(proposal: OpenWikiProposalPathRecord, targetPath: string, extraPaths: string[] = []): boolean {
  return openWikiProposalTargetPaths(proposal, extraPaths).includes(normalizeOpenWikiRepoPath(targetPath));
}

export function openWikiProposalSectionIds(
  proposal: OpenWikiProposalPathRecord,
  sections: OpenWikiProposalPathSection[],
  extraPaths: string[] = [],
): string[] {
  const paths = openWikiProposalTargetPaths(proposal, extraPaths);
  const sectionIds = new Set<string>();
  for (const repoPath of paths) {
    for (const section of sections) {
      if (section.paths.some((pattern) => openWikiPathPatternMatches(pattern, repoPath))) {
        sectionIds.add(section.id);
      }
    }
  }
  return [...sectionIds].sort();
}

function validationIssueFromUnknown(value: unknown, context: string): ValidationIssue {
  const record = objectRecord(value, context);
  const severity = record.severity;
  if (severity !== "info" && severity !== "warning" && severity !== "error") {
    throw new OpenWikiValidationError(`${context}: severity must be info, warning, or error`);
  }
  return {
    severity,
    code: stringField(record, "code", context),
    message: stringField(record, "message", context),
    ...(typeof record.path === "string" ? { path: record.path } : {}),
  };
}

function objectRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenWikiValidationError(`${context}: expected object`);
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, field: string, context: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new OpenWikiValidationError(`${context}: missing string field '${field}'`);
  }
  return value;
}

function arrayField(record: Record<string, unknown>, field: string, context: string): unknown[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new OpenWikiValidationError(`${context}: missing array field '${field}'`);
  }
  return value;
}

export interface SearchRequest {
  query: string;
  types?: string[];
  persona?: SearchPersona;
  limit?: number;
  offset?: number;
  mode?: "lexical" | "hybrid";
  fuzzy?: boolean;
  include_highlights?: boolean;
  include_explain?: boolean;
  filters?: {
    topics?: string[];
    status?: string[];
    updated_after?: string;
  };
}

export interface SearchResult {
  id: string;
  type: string;
  title: string;
  summary?: string;
  url?: string;
  uri: string;
  path?: string;
  score: number;
  matched_fields: string[];
  citations: Array<Record<string, unknown>>;
  updated_at: string;
  explain?: Record<string, unknown>;
  highlights?: Record<string, string[]>;
}

export interface SearchRetrieverDiagnostic {
  enabled: boolean;
  weight: number;
  candidate_count: number;
}

export interface SearchBackendCapabilities {
  backend: "sqlite" | "postgres";
  retrievers: SearchRetriever[];
  unsupported_retrievers: SearchRetriever[];
  fuzzy: boolean;
  ngram: boolean;
  graph: boolean;
  vector: boolean;
  permission_filter: "none" | "post_filter" | "prefilter_batches";
  max_limit: number;
  max_offset: number;
}

export interface SearchExplain {
  query_tokens: string[];
  mode: "lexical" | "hybrid";
  fuzzy: boolean;
  rrf: {
    enabled: boolean;
    k: number;
    overfetch: number;
    fetch_limit: number;
  };
  retrievers_used: SearchRetriever[];
  retriever_stats: Partial<Record<SearchRetriever, SearchRetrieverDiagnostic>>;
  ranking_signals: string[];
  reranker: {
    enabled: boolean;
    applied: boolean;
    top_n: number;
  };
  diagnostics?: {
    backend: "sqlite" | "postgres";
    candidate_strategy: string;
    capabilities?: SearchBackendCapabilities;
    disabled_retrievers?: SearchRetriever[];
    index_content_hash?: string;
    index_record_count?: number;
    embedding_model?: string;
    embedding_dimensions?: number;
    embedding_provider?: string;
    candidate_ids: number;
    record_json_reads: number;
    scanned_rows: number;
    policy_scan_capped?: boolean;
    policy_scan_cap_rows?: number;
    elapsed_ms?: number;
  };
}

export interface SearchFusionRun {
  retriever: SearchRetriever;
  ids: string[];
}

export interface SearchFusionContribution {
  rank: number;
  score: number;
}

export interface SearchFusionExplain {
  total_score: number;
  retrievers: Record<string, SearchFusionContribution>;
}

export interface SearchFusionResult {
  id: string;
  explain: SearchFusionExplain;
}

export function fuseSearchRetrieverRuns(
  runs: SearchFusionRun[],
  weights: Record<SearchRetriever, number>,
  k: number,
): SearchFusionResult[] {
  const scores = new Map<string, SearchFusionExplain>();
  for (const run of runs) {
    const weight = weights[run.retriever] ?? 1;
    const seen = new Set<string>();
    run.ids.forEach((id, rank) => {
      if (seen.has(id)) {
        return;
      }
      seen.add(id);
      const rrfScore = weight / (k + rank + 1);
      const existing = scores.get(id) ?? { total_score: 0, retrievers: {} };
      existing.total_score += rrfScore;
      existing.retrievers[run.retriever] = { rank: rank + 1, score: roundSearchScore(rrfScore) };
      scores.set(id, existing);
    });
  }

  return [...scores.entries()]
    .map(([id, explain]) => ({
      id,
      explain: {
        total_score: roundSearchScore(explain.total_score),
        retrievers: explain.retrievers,
      },
    }))
    .sort((left, right) => right.explain.total_score - left.explain.total_score || left.id.localeCompare(right.id));
}

function roundSearchScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export interface SearchResponse {
  serving_layer?: "sqlite" | "postgres";
  results: SearchResult[];
  count: number;
  total: number;
  total_relation?: "exact" | "capped";
  truncated: boolean;
  persona: SearchPersona;
  next_cursor?: string;
  facets?: SearchFacets;
  facets_relation?: "exact" | "capped";
  explain?: SearchExplain;
}

export interface SearchFacets {
  types: Record<string, number>;
  status: Record<string, number>;
  topics: Record<string, number>;
}

export interface OpenWikiSearchFacetItem {
  id?: string;
  type: string;
  status?: string;
  topics?: string[];
}

export interface OpenWikiSearchResponseInput {
  serving_layer?: SearchResponse["serving_layer"];
  results: SearchResult[];
  total: number;
  total_relation?: SearchResponse["total_relation"];
  truncated: boolean;
  persona: SearchPersona;
  next_cursor?: string;
  facets?: SearchFacets;
  facets_relation?: SearchResponse["facets_relation"];
  explain?: SearchExplain;
}

export function openWikiSearchFacetsFromItems(items: OpenWikiSearchFacetItem[]): SearchFacets {
  const facets: SearchFacets = { types: {}, status: {}, topics: {} };
  const seen = new Set<string>();
  for (const item of items) {
    if (item.id !== undefined) {
      if (seen.has(item.id)) {
        continue;
      }
      seen.add(item.id);
    }
    facets.types[item.type] = (facets.types[item.type] ?? 0) + 1;
    if (item.status !== undefined) {
      facets.status[item.status] = (facets.status[item.status] ?? 0) + 1;
    }
    for (const topic of item.topics ?? []) {
      facets.topics[topic] = (facets.topics[topic] ?? 0) + 1;
    }
  }
  return facets;
}

export function openWikiSearchResponse(input: OpenWikiSearchResponseInput): SearchResponse {
  return {
    ...(input.serving_layer === undefined ? {} : { serving_layer: input.serving_layer }),
    results: input.results,
    count: input.results.length,
    total: input.total,
    ...(input.total_relation === undefined ? {} : { total_relation: input.total_relation }),
    truncated: input.truncated,
    persona: input.persona,
    ...(input.next_cursor === undefined ? {} : { next_cursor: input.next_cursor }),
    ...(input.facets === undefined ? {} : { facets: input.facets }),
    ...(input.facets_relation === undefined ? {} : { facets_relation: input.facets_relation }),
    ...(input.explain === undefined ? {} : { explain: input.explain }),
  };
}

export function openWikiVisibleSearchResponse(input: {
  response: SearchResponse;
  visibleResults: SearchResult[];
  facets?: SearchFacets;
}): SearchResponse {
  const truncated = input.response.truncated && input.visibleResults.length === input.response.count;
  return openWikiSearchResponse({
    ...(input.response.serving_layer === undefined ? {} : { serving_layer: input.response.serving_layer }),
    results: input.visibleResults,
    total: Math.min(input.response.total, input.visibleResults.length),
    ...(input.response.total_relation === undefined ? {} : { total_relation: "capped" as const }),
    truncated,
    persona: input.response.persona,
    ...(truncated && input.response.next_cursor !== undefined ? { next_cursor: input.response.next_cursor } : {}),
    ...(input.response.facets === undefined ? {} : { facets: input.facets ?? openWikiSearchFacetsFromItems(input.visibleResults) }),
    ...(input.response.facets_relation === undefined ? {} : { facets_relation: "capped" as const }),
    ...(input.response.explain === undefined ? {} : { explain: input.response.explain }),
  });
}

export interface AnswerCitation {
  id: string;
  type: string;
  title: string;
  uri: string;
  url?: string;
}

export interface AnswerEvidence {
  id: string;
  type: string;
  title: string;
  uri: string;
  score: number;
  summary?: string;
  snippet?: string;
  citations: AnswerCitation[];
}

export interface AnswerResponse {
  question: string;
  answer: string;
  citations: AnswerCitation[];
  evidence: AnswerEvidence[];
  search: SearchResponse;
}

export interface ThinkGap {
  reason: string;
  query?: string;
}

export interface ThinkDiagnostics {
  synthesis: {
    provider: "deterministic";
    model: string;
    available: boolean;
    fallback: boolean;
  };
  retrieval: {
    mode: SearchRequest["mode"];
    retrievers_used: SearchRetriever[];
    citations_required: boolean;
  };
}

export interface ThinkResponse extends AnswerResponse {
  gaps: ThinkGap[];
  diagnostics: ThinkDiagnostics;
}

export interface TopicSummary {
  topic: string;
  page_count: number;
  page_ids: string[];
  claim_count: number;
  source_count: number;
  source_ids: string[];
  updated_at: string;
}

export interface OpenQuestionRecord {
  id: string;
  question: string;
  page_id: string;
  page_title: string;
  page_uri: string;
  path: string;
  topics: string[];
  updated_at: string;
}
