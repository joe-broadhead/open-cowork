import type { IndexRecord } from "./records.ts";
import { type LoadedOpenWikiRepo, loadRepository } from "@openwiki/repo";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clearSearchRepositoryCache, searchIndexContentHash } from "./cache.ts";
import { chunksForIndexRecord, embedSearchTextLocal, embeddingEnabled, serializeEmbedding } from "./chunks.ts";
import { resolveSearchConfig } from "./config.ts";
import { recordFromClaim, recordFromDecision, recordFromEvent, recordFromFact, recordFromPage, recordFromProposal, recordFromProposalComment, recordFromSource, recordFromTake, recordsFromRecentChanges, recordsFromSourceFragments } from "./record-builders.ts";
import { SEARCH_INDEX_SCHEMA_VERSION, type SearchIndexResult } from "./types.ts";

export async function buildSearchIndex(root: string): Promise<SearchIndexResult> {
  const repo = await loadRepository(root);
  const indexRoot = path.join(repo.root, ".openwiki", "index");
  await fs.mkdir(indexRoot, { recursive: true });
  const dbPath = path.join(indexRoot, "openwiki.sqlite");
  const tmpDbPath = path.join(indexRoot, `openwiki.${process.pid}.${Date.now()}.tmp.sqlite`);

  const db = new DatabaseSync(tmpDbPath);
  try {
    db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE records (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        uri TEXT NOT NULL,
        path TEXT NOT NULL,
        status TEXT NOT NULL,
        body TEXT NOT NULL,
        topics_json TEXT NOT NULL,
        source_ids_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        url TEXT,
        json TEXT NOT NULL
      );
      CREATE TABLE record_topics (
        record_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        PRIMARY KEY (record_id, topic)
      );
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE records_fts USING fts5(
        id UNINDEXED,
        type UNINDEXED,
        uri UNINDEXED,
        path UNINDEXED,
        title,
        summary,
        body,
        topics,
        tokenize = 'porter unicode61'
      );
      CREATE TABLE search_chunks (
        chunk_id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        record_type TEXT NOT NULL,
        path TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        character_count INTEGER NOT NULL,
        token_count INTEGER NOT NULL,
        source_ids_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE search_chunk_embeddings (
        chunk_id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        embedding BLOB NOT NULL
      );
      CREATE INDEX records_type_status_idx ON records (type, status, updated_at, id);
      CREATE INDEX records_updated_idx ON records (updated_at, id);
      CREATE INDEX record_topics_topic_idx ON record_topics (topic, record_id);
      CREATE INDEX search_chunks_record_idx ON search_chunks (record_id, ordinal);
      CREATE INDEX search_chunk_embeddings_model_idx ON search_chunk_embeddings (provider, model, dimensions);
    `);

    const searchConfig = resolveSearchConfig(repo.config.search);
    const insertRecord = db.prepare(`
      INSERT INTO records (
        id, type, title, summary, uri, path, status, body, topics_json, source_ids_json, updated_at, url, json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertTopic = db.prepare("INSERT INTO record_topics (record_id, topic) VALUES (?, ?)");
    const insertFts = db.prepare(`
      INSERT INTO records_fts (id, type, uri, path, title, summary, body, topics)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertChunk = db.prepare(`
      INSERT INTO search_chunks (
        chunk_id, record_id, record_type, path, ordinal, text, content_hash,
        character_count, token_count, source_ids_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEmbedding = db.prepare(`
      INSERT INTO search_chunk_embeddings (
        chunk_id, record_id, provider, model, dimensions, content_hash, embedding
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const records = await collectIndexRecords(repo);
    const contentHash = searchIndexContentHash(records);

    runSqliteTransaction(db, () => {
      for (const record of records) {
        insertRecord.run(
          record.id,
          record.type,
          record.title,
          record.summary,
          record.uri,
          record.path,
          record.status,
          record.body,
          JSON.stringify(record.topics),
          JSON.stringify(record.source_ids),
          record.updated_at,
          record.url ?? null,
          JSON.stringify(record),
        );
        insertFts.run(
          record.id,
          record.type,
          record.uri,
          record.path,
          record.title,
          record.summary,
          record.body,
          record.topics.join(" "),
        );
        for (const topic of record.topics) {
          insertTopic.run(record.id, topic);
        }
        for (const chunk of chunksForIndexRecord(record, searchConfig.embedding)) {
          insertChunk.run(
            chunk.id,
            chunk.record_id,
            chunk.record_type,
            chunk.path,
            chunk.ordinal,
            chunk.text,
            chunk.content_hash,
            chunk.character_count,
            chunk.token_count,
            JSON.stringify(chunk.source_ids),
            chunk.updated_at,
          );
          if (embeddingEnabled(searchConfig)) {
            insertEmbedding.run(
              chunk.id,
              chunk.record_id,
              searchConfig.embedding.provider,
              searchConfig.embedding.model,
              searchConfig.embedding.dimensions,
              chunk.content_hash,
              serializeEmbedding(embedSearchTextLocal(chunk.text, searchConfig.embedding.dimensions)),
            );
          }
        }
      }

      const insertMetadata = db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
      insertMetadata.run("schema_version", SEARCH_INDEX_SCHEMA_VERSION);
      insertMetadata.run("generated_at", new Date().toISOString());
      insertMetadata.run("record_count", String(records.length));
      insertMetadata.run("content_hash", contentHash);
    });

    db.close();
    await fs.rename(tmpDbPath, dbPath);
    clearSearchRepositoryCache(dbPath);
    return { root: repo.root, dbPath, recordCount: records.length, contentHash };
  } finally {
    try {
      db.close();
    } catch {
      // The database may already be closed after a successful atomic rename.
    }
    await fs.rm(tmpDbPath, { force: true });
  }
}

function runSqliteTransaction(db: DatabaseSync, callback: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    callback();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original index-build error.
    }
    throw error;
  }
}

export async function collectIndexRecords(repo: LoadedOpenWikiRepo): Promise<IndexRecord[]> {
  const [sourceFragments, recentChanges] = await Promise.all([
    recordsFromSourceFragments(repo.root, repo.sources),
    recordsFromRecentChanges(repo.root),
  ]);
  return [
    ...repo.pages.map(recordFromPage),
    ...repo.sources.map(recordFromSource),
    ...sourceFragments,
    ...repo.claims.map((claim) => recordFromClaim(claim, repo.pages, repo.sources)),
    ...repo.facts.map((fact) => recordFromFact(fact, repo.pages, repo.sources, repo.claims)),
    ...repo.takes.map((take) => recordFromTake(take, repo.pages, repo.sources, repo.claims)),
    ...repo.proposals.map(recordFromProposal),
    ...repo.comments.map(recordFromProposalComment),
    ...repo.decisions.map(recordFromDecision),
    ...repo.events.map(recordFromEvent),
    ...recentChanges,
  ];
}
