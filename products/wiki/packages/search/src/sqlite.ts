import { openWikiSearchFacetsFromItems, type SearchFacets, type SearchRequest } from "@openwiki/core";
import { canReadRecordReference, type PolicyContext } from "@openwiki/policy";
import type { LoadedOpenWikiRepo } from "@openwiki/repo";
import { DatabaseSync } from "node:sqlite";
import { cosineSimilarity, deserializeEmbedding, embedSearchTextLocal, embeddingEnabled } from "./chunks.ts";
import { ftsQueryFromText } from "./text.ts";
import { SQLITE_SEARCH_BATCH_MAX, SQLITE_SEARCH_SCAN_CAP, type IndexedRetrieverRows, type IndexedSearchRow, type ResolvedSearchConfig, type VisibleRetrieverRows } from "./types.ts";

export function indexedRetrieverRows(input: {
  db: DatabaseSync;
  repo: LoadedOpenWikiRepo;
  request: SearchRequest;
  policyContext?: PolicyContext;
  query: string;
  mode: "lexical" | "hybrid";
  fetchLimit: number;
  searchConfig: ResolvedSearchConfig;
}): IndexedRetrieverRows {
  const batchLimit = Math.min(Math.max(input.fetchLimit * 10, 100), SQLITE_SEARCH_BATCH_MAX);
  const exact = input.searchConfig.enabled_retrievers.exact
    ? collectVisibleRetrieverRows({
        ...input,
        retriever: "exact",
        batchLimit,
      })
    : { rows: [], scannedRows: 0, disabledRetrievers: [], exhausted: true };
  const bm25 = input.searchConfig.enabled_retrievers.bm25
    ? collectVisibleRetrieverRows({
        ...input,
        retriever: "bm25",
        batchLimit,
      })
    : { rows: [], scannedRows: 0, disabledRetrievers: [], exhausted: true };
  const vector = vectorRetrieverEnabled(input)
    ? collectVisibleVectorRows(input)
    : { rows: [], scannedRows: 0, disabledRetrievers: [], exhausted: true };
  return {
    exactRows: exact.rows,
    bm25Rows: bm25.rows,
    vectorRows: vector.rows,
    scannedRows: exact.scannedRows + bm25.scannedRows + vector.scannedRows,
    disabledRetrievers: [...exact.disabledRetrievers, ...bm25.disabledRetrievers, ...vector.disabledRetrievers],
    exhausted: exact.exhausted && bm25.exhausted && vector.exhausted,
  };
}

function vectorRetrieverEnabled(input: {
  mode: "lexical" | "hybrid";
  searchConfig: ResolvedSearchConfig;
}): boolean {
  return input.mode === "hybrid" && input.searchConfig.enabled_retrievers.vector && embeddingEnabled(input.searchConfig);
}

function collectVisibleVectorRows(input: {
  db: DatabaseSync;
  repo: LoadedOpenWikiRepo;
  request: SearchRequest;
  policyContext?: PolicyContext;
  query: string;
  fetchLimit: number;
  searchConfig: ResolvedSearchConfig;
}): VisibleRetrieverRows {
  const eligibleEmbeddingCount = sqliteVectorEligibleCount(input.db, input.request, input.searchConfig);
  if (eligibleEmbeddingCount > SQLITE_SEARCH_SCAN_CAP) {
    return { rows: [], scannedRows: 0, disabledRetrievers: ["vector"], exhausted: true };
  }
  const batchLimit = Math.min(Math.max(input.fetchLimit * 10, 100), SQLITE_SEARCH_BATCH_MAX);
  const bestById = new Map<string, IndexedSearchRow>();
  let offset = 0;
  let scannedRows = 0;
  let exhausted = true;
  while (offset < eligibleEmbeddingCount) {
    const vector = sqliteVectorRows(input.db, input.request, input.query, input.searchConfig, batchLimit, offset);
    if (vector.scannedRows === 0) {
      exhausted = true;
      break;
    }
    scannedRows += vector.scannedRows;
    for (const row of vector.rows) {
      const existing = bestById.get(row.id);
      if (existing === undefined || (existing.vector_score ?? 0) < (row.vector_score ?? 0)) {
        bestById.set(row.id, row);
      }
    }
    offset += vector.scannedRows;
    if (vector.scannedRows < batchLimit || offset >= eligibleEmbeddingCount) {
      exhausted = true;
      break;
    }
    exhausted = false;
  }
  const rows: IndexedSearchRow[] = [];
  let visibleRowsExhausted = exhausted;
  const vectorRows = [...bestById.values()]
    .sort((left, right) => (right.vector_score ?? 0) - (left.vector_score ?? 0) || right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id));
  for (const row of vectorRows) {
    if (indexedRowAllowedForPolicy(input.repo, row, input.policyContext)) {
      if (rows.length >= input.fetchLimit) {
        visibleRowsExhausted = false;
        break;
      }
      rows.push(row);
    }
  }
  return { rows, scannedRows, disabledRetrievers: [], exhausted: visibleRowsExhausted };
}

function collectVisibleRetrieverRows(input: {
  db: DatabaseSync;
  repo: LoadedOpenWikiRepo;
  request: SearchRequest;
  policyContext?: PolicyContext;
  query: string;
  fetchLimit: number;
  retriever: "exact" | "bm25";
  batchLimit: number;
}): VisibleRetrieverRows {
  const rows: IndexedSearchRow[] = [];
  let offset = 0;
  let scannedRows = 0;
  let exhausted = true;
  while (rows.length < input.fetchLimit && offset < SQLITE_SEARCH_SCAN_CAP) {
    const batch = input.retriever === "exact"
      ? sqliteExactRows(input.db, input.request, input.query, input.batchLimit, offset)
      : sqliteBm25Rows(input.db, input.request, input.query, input.batchLimit, offset);
    if (batch.length === 0) {
      exhausted = true;
      break;
    }
    scannedRows += batch.length;
    for (const row of batch) {
      if (indexedRowAllowedForPolicy(input.repo, row, input.policyContext)) {
        rows.push(row);
        if (rows.length >= input.fetchLimit) {
          break;
        }
      }
    }
    offset += batch.length;
    if (batch.length < input.batchLimit) {
      exhausted = true;
      break;
    }
    exhausted = false;
  }
  if (offset >= SQLITE_SEARCH_SCAN_CAP) {
    exhausted = false;
  }
  return { rows, scannedRows, disabledRetrievers: [], exhausted };
}

function sqliteVectorEligibleCount(
  db: DatabaseSync,
  request: SearchRequest,
  searchConfig: ResolvedSearchConfig,
): number {
  const filter = sqliteRecordFilterSql(request, "r");
  const rows = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM search_chunk_embeddings e
        JOIN records r ON r.id = e.record_id
        ${filter.sql ? `${filter.sql} AND` : "WHERE"} e.provider = ? AND e.model = ? AND e.dimensions = ?
      `,
    )
    .all(
      ...filter.params,
      searchConfig.embedding.provider,
      searchConfig.embedding.model,
      searchConfig.embedding.dimensions,
    ) as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

function sqliteExactRows(
  db: DatabaseSync,
  request: SearchRequest,
  query: string,
  limit: number,
  offset: number,
): IndexedSearchRow[] {
  const normalized = query.toLowerCase();
  const contains = `%${escapeSqlLike(normalized)}%`;
  const suffixColon = `%:${escapeSqlLike(normalized)}`;
  const suffixSlash = `%/${escapeSqlLike(normalized)}`;
  const fields = ["r.id", "r.uri", "r.title", "r.path", "COALESCE(r.url, '')"];
  const equality = fields.map((field) => `lower(${field}) = ?`).join(" OR ");
  const suffix = fields.map((field) => `lower(${field}) LIKE ? ESCAPE '\\' OR lower(${field}) LIKE ? ESCAPE '\\'`).join(" OR ");
  const partial = fields.map((field) => `lower(${field}) LIKE ? ESCAPE '\\'`).join(" OR ");
  const exactParams = [
    ...fields.map(() => normalized),
    ...fields.flatMap(() => [suffixColon, suffixSlash]),
    ...fields.map(() => contains),
  ];
  const filter = sqliteRecordFilterSql(request, "r");
  return db
    .prepare(
      `
        SELECT *
        FROM (
          SELECT
            r.id, r.type, r.title, r.summary, r.uri, r.path, r.status, r.topics_json,
            r.source_ids_json, r.updated_at, r.url, r.json,
            CASE
              WHEN ${equality} THEN 3
              WHEN ${suffix} THEN 2
              WHEN ${partial} THEN 1
              ELSE 0
            END AS exact_rank
          FROM records r
          ${filter.sql}
        )
        WHERE exact_rank > 0
        ORDER BY exact_rank DESC, updated_at DESC, id ASC
        LIMIT ?
        OFFSET ?
      `,
    )
    .all(...exactParams, ...filter.params, limit, offset) as unknown as IndexedSearchRow[];
}

function sqliteBm25Rows(
  db: DatabaseSync,
  request: SearchRequest,
  query: string,
  limit: number,
  offset: number,
): IndexedSearchRow[] {
  const ftsQuery = ftsQueryFromText(query);
  if (!ftsQuery) {
    return [];
  }
  const filter = sqliteRecordFilterSql(request, "r");
  return db
    .prepare(
      `
        SELECT
          r.id, r.type, r.title, r.summary, r.uri, r.path, r.status, r.topics_json,
          r.source_ids_json, r.updated_at, r.url, r.json,
          bm25(records_fts, 8.0, 4.0, 1.0, 0.5) AS bm25_rank
        FROM records_fts
        JOIN records r ON r.id = records_fts.id
        ${filter.sql ? `${filter.sql} AND` : "WHERE"} records_fts MATCH ?
        ORDER BY bm25_rank ASC, r.updated_at DESC, r.id ASC
        LIMIT ?
        OFFSET ?
      `,
    )
    .all(...filter.params, ftsQuery, limit, offset) as unknown as IndexedSearchRow[];
}

function sqliteVectorRows(
  db: DatabaseSync,
  request: SearchRequest,
  query: string,
  searchConfig: ResolvedSearchConfig,
  limit: number,
  offset: number,
): { rows: IndexedSearchRow[]; scannedRows: number } {
  const queryEmbedding = embedSearchTextLocal(query, searchConfig.embedding.dimensions);
  const filter = sqliteRecordFilterSql(request, "r");
  const rows = db
    .prepare(
      `
        SELECT
          r.id, r.type, r.title, r.summary, r.uri, r.path, r.status, r.topics_json,
          r.source_ids_json, r.updated_at, r.url, r.json,
          e.embedding
        FROM search_chunk_embeddings e
        JOIN records r ON r.id = e.record_id
        ${filter.sql ? `${filter.sql} AND` : "WHERE"} e.provider = ? AND e.model = ? AND e.dimensions = ?
        ORDER BY e.record_id ASC, e.chunk_id ASC
        LIMIT ?
        OFFSET ?
      `,
    )
    .all(
      ...filter.params,
      searchConfig.embedding.provider,
      searchConfig.embedding.model,
      searchConfig.embedding.dimensions,
      limit,
      offset,
    ) as unknown as Array<IndexedSearchRow & { embedding: Uint8Array }>;
  const bestById = new Map<string, IndexedSearchRow>();
  for (const row of rows) {
    const score = cosineSimilarity(queryEmbedding, deserializeEmbedding(row.embedding));
    if (score <= 0) {
      continue;
    }
    const existing = bestById.get(row.id);
    if (existing === undefined || (existing.vector_score ?? 0) < score) {
      bestById.set(row.id, {
        id: row.id,
        type: row.type,
        title: row.title,
        summary: row.summary,
        uri: row.uri,
        path: row.path,
        status: row.status,
        topics_json: row.topics_json,
        source_ids_json: row.source_ids_json,
        updated_at: row.updated_at,
        url: row.url,
        json: row.json,
        vector_score: score,
      });
    }
  }
  return {
    rows: [...bestById.values()]
      .sort((left, right) => (right.vector_score ?? 0) - (left.vector_score ?? 0) || right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id)),
    scannedRows: rows.length,
  };
}

function sqliteRecordFilterSql(request: SearchRequest, alias: string): { sql: string; params: Array<string> } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (request.types && request.types.length > 0) {
    clauses.push(`${alias}.type IN (${request.types.map(() => "?").join(", ")})`);
    params.push(...request.types);
  }
  if (request.filters?.status && request.filters.status.length > 0) {
    clauses.push(`${alias}.status IN (${request.filters.status.map(() => "?").join(", ")})`);
    params.push(...request.filters.status);
  }
  if (request.filters?.topics && request.filters.topics.length > 0) {
    clauses.push(
      `EXISTS (SELECT 1 FROM record_topics rt WHERE rt.record_id = ${alias}.id AND rt.topic IN (${request.filters.topics.map(() => "?").join(", ")}))`,
    );
    params.push(...request.filters.topics);
  }
  if (request.filters?.updated_after) {
    clauses.push(`${alias}.updated_at >= ?`);
    params.push(request.filters.updated_after);
  }
  return { sql: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`, params };
}

function indexedRowAllowedForPolicy(
  repo: LoadedOpenWikiRepo,
  row: IndexedSearchRow,
  context: PolicyContext | undefined,
): boolean {
  if (context === undefined) {
    return true;
  }
  return canReadRecordReference(repo, context, {
    id: row.id,
    type: row.type,
    path: row.path,
    source_ids: jsonStringArray(row.source_ids_json),
  });
}

export function facetsFromRows(rows: IndexedSearchRow[]): SearchFacets {
  return openWikiSearchFacetsFromItems(rows.map((row) => ({
    id: row.id,
    type: row.type,
    ...(row.status === undefined ? {} : { status: row.status }),
    topics: jsonStringArray(row.topics_json),
  })));
}

export function rowsById(rows: IndexedSearchRow[]): Map<string, IndexedSearchRow> {
  const byId = new Map<string, IndexedSearchRow>();
  for (const row of rows) {
    if (!byId.has(row.id)) {
      byId.set(row.id, row);
    }
  }
  return byId;
}

export function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function jsonStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
}

function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
