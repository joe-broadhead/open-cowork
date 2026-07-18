import type { IndexRecord } from "./records.ts";
import { type ClaimRecord, fuseSearchRetrieverRuns, type PageRecord, type SearchRetriever, type SourceRecord, tokenizeOpenWikiText } from "@openwiki/core";
import { DatabaseSync } from "node:sqlite";
import { chunksForIndexRecord, cosineSimilarity, embedSearchTextLocal, embeddingEnabled } from "./chunks.ts";
import { appendMapValue, ftsQueryFromText, fuzzyTokenScore, ngramsForText, ngramSimilarity, tokenOverlap, weightedFieldScore } from "./text.ts";
import type { ResolvedSearchConfig, RetrievalExplain, RetrieverRun, RetrieverStats } from "./types.ts";

export function runRetrievers(input: {
  db: DatabaseSync;
  records: IndexRecord[];
  candidateIds: Set<string>;
  pages: PageRecord[];
  sources: SourceRecord[];
  claims: ClaimRecord[];
  query: string;
  fetchLimit: number;
  mode: "lexical" | "hybrid";
  fuzzyEnabled: boolean;
  searchConfig: ResolvedSearchConfig;
  weights: Record<SearchRetriever, number>;
}): { runs: RetrieverRun[]; retrieverStats: Partial<Record<SearchRetriever, RetrieverStats>> } {
  const runs: RetrieverRun[] = [];
  const retrieverStats: Partial<Record<SearchRetriever, RetrieverStats>> = {};
  const pushRun = (retriever: SearchRetriever, enabled: boolean, ids: string[]): void => {
    const cappedIds = ids.slice(0, input.fetchLimit);
    retrieverStats[retriever] = {
      enabled,
      weight: input.weights[retriever] ?? 1,
      candidate_count: cappedIds.length,
    };
    if (enabled) {
      runs.push({ retriever, ids: cappedIds });
    }
  };

  pushRun(
    "exact",
    input.searchConfig.enabled_retrievers.exact,
    input.searchConfig.enabled_retrievers.exact ? exactMatches(input.records, input.query, input.fetchLimit) : [],
  );
  pushRun(
    "bm25",
    input.searchConfig.enabled_retrievers.bm25,
    input.searchConfig.enabled_retrievers.bm25
      ? bm25Matches(input.db, input.query, input.candidateIds, input.fetchLimit)
      : [],
  );
  pushRun(
    "ngram",
    input.searchConfig.enabled_retrievers.ngram,
    input.searchConfig.enabled_retrievers.ngram
      ? ngramMatches(input.records, input.query, input.fetchLimit, input.searchConfig.ngram_min)
      : [],
  );
  pushRun(
    "fuzzy",
    input.fuzzyEnabled,
    input.fuzzyEnabled ? fuzzyMatches(input.records, input.query, input.fetchLimit, input.searchConfig) : [],
  );
  pushRun(
    "graph",
    input.mode === "hybrid" && input.searchConfig.enabled_retrievers.graph,
    input.mode === "hybrid" && input.searchConfig.enabled_retrievers.graph
      ? graphMatches(input.records, input.pages, input.sources, input.claims, input.query, input.fetchLimit)
      : [],
  );
  pushRun(
    "vector",
    input.mode === "hybrid" && input.searchConfig.enabled_retrievers.vector && embeddingEnabled(input.searchConfig),
    input.mode === "hybrid" && input.searchConfig.enabled_retrievers.vector && embeddingEnabled(input.searchConfig)
      ? vectorMatches(input.records, input.query, input.fetchLimit, input.searchConfig)
      : [],
  );

  return { runs, retrieverStats };
}

function exactMatches(records: IndexRecord[], query: string, limit: number): string[] {
  const normalized = query.toLowerCase();
  const scored = records
    .map((record) => {
      const values = [record.id, record.uri, record.title, record.path, record.url ?? ""].map((value) =>
        value.toLowerCase(),
      );
      if (values.includes(normalized)) {
        return { id: record.id, score: 3 };
      }
      if (values.some((value) => value.endsWith(`:${normalized}`) || value.endsWith(`/${normalized}`))) {
        return { id: record.id, score: 2 };
      }
      if (values.some((value) => value.includes(normalized))) {
        return { id: record.id, score: 1 };
      }
      return undefined;
    })
    .filter((match): match is { id: string; score: number } => Boolean(match))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
  return scored.map((match) => match.id);
}

function bm25Matches(db: DatabaseSync, query: string, candidateIds: Set<string>, limit: number): string[] {
  const ftsQuery = ftsQueryFromText(query);
  if (!ftsQuery || candidateIds.size === 0) {
    return [];
  }
  const sqlLimit = Math.min(Math.max(limit * 10, 100), 2000);
  const rows = db
    .prepare(
      `
        SELECT id, bm25(records_fts, 8.0, 4.0, 1.0, 0.5) AS rank
        FROM records_fts
        WHERE records_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `,
    )
    .all(ftsQuery, sqlLimit) as Array<{ id: string; rank: number }>;
  return rows
    .filter((row) => candidateIds.has(row.id))
    .slice(0, limit)
    .map((row) => row.id);
}

function ngramMatches(records: IndexRecord[], query: string, limit: number, ngramMin: number): string[] {
  const queryGrams = ngramsForText(query, ngramMin);
  if (queryGrams.size === 0) {
    return [];
  }

  return records
    .map((record) => {
      const score = weightedFieldScore(record, (value) => ngramSimilarity(queryGrams, ngramsForText(value, ngramMin)));
      return { id: record.id, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map((entry) => entry.id);
}

function fuzzyMatches(
  records: IndexRecord[],
  query: string,
  limit: number,
  searchConfig: ResolvedSearchConfig,
): string[] {
  const queryTokens = tokenizeOpenWikiText(query).filter((token) => token.length >= searchConfig.fuzzy_min_length);
  if (queryTokens.length === 0) {
    return [];
  }

  return records
    .map((record) => {
      const score = weightedFieldScore(record, (value) => fuzzyTokenScore(queryTokens, tokenizeOpenWikiText(value), searchConfig));
      return { id: record.id, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit)
    .map((entry) => entry.id);
}

function graphMatches(
  records: IndexRecord[],
  pages: PageRecord[],
  sources: SourceRecord[],
  claims: ClaimRecord[],
  query: string,
  limit: number,
): string[] {
  const tokens = tokenizeOpenWikiText(query);
  if (tokens.length === 0) {
    return [];
  }

  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const claimTextByPage = new Map<string, string[]>();
  const claimTextBySource = new Map<string, string[]>();
  for (const claim of claims) {
    appendMapValue(claimTextByPage, claim.page_id, claim.text);
    for (const sourceId of claim.source_ids) {
      appendMapValue(claimTextBySource, sourceId, claim.text);
    }
  }

  const scored = records
    .map((record) => {
      const relatedText = relatedGraphText(record, pagesById, sourcesById, claimTextByPage, claimTextBySource);
      const score = tokenOverlap(tokens, relatedText);
      return { id: record.id, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
  return scored.map((entry) => entry.id);
}

function relatedGraphText(
  record: IndexRecord,
  pagesById: Map<string, PageRecord>,
  sourcesById: Map<string, SourceRecord>,
  claimTextByPage: Map<string, string[]>,
  claimTextBySource: Map<string, string[]>,
): string {
  if (record.type === "page") {
    const sourceTitles = record.source_ids.map((sourceId) => sourcesById.get(sourceId)?.title ?? "").join(" ");
    return [record.title, record.summary, sourceTitles, ...(claimTextByPage.get(record.id) ?? [])].join(" ");
  }
  if (record.type === "source") {
    return [record.title, ...(claimTextBySource.get(record.id) ?? [])].join(" ");
  }
  if (record.type === "claim") {
    const claimPage = [...pagesById.values()].find((page) => page.claim_ids.includes(record.id));
    const sourceTitles = record.source_ids.map((sourceId) => sourcesById.get(sourceId)?.title ?? "").join(" ");
    return [record.title, claimPage?.title ?? "", sourceTitles].join(" ");
  }
  return record.body;
}

function vectorMatches(
  records: IndexRecord[],
  query: string,
  limit: number,
  searchConfig: ResolvedSearchConfig,
): string[] {
  const queryEmbedding = embedSearchTextLocal(query, searchConfig.embedding.dimensions);
  const scored = records
    .map((record) => {
      const score = Math.max(
        0,
        ...chunksForIndexRecord(record, searchConfig.embedding)
          .map((chunk) => cosineSimilarity(queryEmbedding, embedSearchTextLocal(chunk.text, searchConfig.embedding.dimensions))),
      );
      return { id: record.id, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
  return scored.map((entry) => entry.id);
}

export function weightedRrf(
  rankings: Array<[SearchRetriever, string[]]>,
  weights: Record<SearchRetriever, number>,
  k: number,
): Array<{ id: string; explain: RetrievalExplain }> {
  return fuseSearchRetrieverRuns(
    rankings.map(([retriever, ids]) => ({ retriever, ids })),
    weights,
    k,
  );
}
