import { type IndexRecord, searchIndexRecordFromJson } from "./records.ts";
import { openWikiPathExists } from "@openwiki/core";
import { type LoadedOpenWikiRepo, loadRepository } from "@openwiki/repo";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { positiveInteger } from "./config.ts";
import { SEARCH_INDEX_METADATA_CACHE, type SearchIndexMetadata } from "./types.ts";

const SEARCH_REPOSITORY_CACHE_LIMIT = 8;
const SEARCH_METADATA_CACHE_LIMIT = 32;

const SEARCH_REPOSITORY_CACHE = new Map<string, LoadedOpenWikiRepo>();

export function readAllRecords(db: DatabaseSync): IndexRecord[] {
  const rows = db.prepare("SELECT json FROM records ORDER BY id").all() as Array<{ json: string }>;
  return rows.map((row) => searchIndexRecordFromJson(row.json));
}

export async function readSearchIndexMetadata(db: DatabaseSync, dbPath: string): Promise<SearchIndexMetadata> {
  const stat = await fs.stat(dbPath);
  const cacheKey = `${dbPath}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  const cached = SEARCH_INDEX_METADATA_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  let metadata: SearchIndexMetadata;
  try {
    const rows = db.prepare("SELECT key, value FROM metadata").all() as Array<{ key: string; value: string }>;
    const values = new Map(rows.map((row) => [row.key, row.value]));
    metadata = {
      schemaVersion: values.get("schema_version") ?? "unknown",
      generatedAt: values.get("generated_at") ?? "",
      recordCount: positiveInteger(Number(values.get("record_count")), 0),
      contentHash: values.get("content_hash") ?? "",
    };
  } catch {
    const countRows = db.prepare("SELECT COUNT(*) AS count FROM records").all() as Array<{ count: number }>;
    metadata = {
      schemaVersion: "legacy",
      generatedAt: "",
      recordCount: Number(countRows[0]?.count ?? 0),
      contentHash: "",
    };
  }
  setBoundedMetadataCache(cacheKey, metadata);
  return metadata;
}

export async function loadRepositoryForSearchIndex(
  root: string,
  dbPath: string,
  metadata: SearchIndexMetadata,
): Promise<LoadedOpenWikiRepo> {
  const cacheKey = await searchRepositoryCacheKey(root, dbPath, metadata);
  const cached = SEARCH_REPOSITORY_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const repo = await loadRepository(root);
  if (SEARCH_REPOSITORY_CACHE.size >= SEARCH_REPOSITORY_CACHE_LIMIT) {
    const oldestKey = SEARCH_REPOSITORY_CACHE.keys().next().value;
    if (oldestKey !== undefined) {
      SEARCH_REPOSITORY_CACHE.delete(oldestKey);
    }
  }
  SEARCH_REPOSITORY_CACHE.set(cacheKey, repo);
  return repo;
}

async function searchRepositoryCacheKey(root: string, dbPath: string, metadata: SearchIndexMetadata): Promise<string> {
  const identity = metadata.contentHash || `${metadata.schemaVersion}:${metadata.recordCount}`;
  const policyFingerprint = await searchPolicyFingerprint(root);
  return `${dbPath}:${identity}:${policyFingerprint}`;
}

async function searchPolicyFingerprint(root: string): Promise<string> {
  const files = ["openwiki.json", "policy/sections.json", "policy/grants.json", "policy/approval-rules.json"];
  const stats = await Promise.all(
    files.map(async (file) => {
      try {
        const fileStat = await fs.stat(path.join(root, file));
        return `${file}:${fileStat.size}:${Math.trunc(fileStat.mtimeMs)}`;
      } catch {
        return `${file}:missing`;
      }
    }),
  );
  return stats.join("|");
}

export function clearSearchRepositoryCache(dbPath: string): void {
  for (const key of SEARCH_REPOSITORY_CACHE.keys()) {
    if (key.startsWith(`${dbPath}:`)) {
      SEARCH_REPOSITORY_CACHE.delete(key);
    }
  }
  for (const key of SEARCH_INDEX_METADATA_CACHE.keys()) {
    if (key.startsWith(`${dbPath}:`)) {
      SEARCH_INDEX_METADATA_CACHE.delete(key);
    }
  }
}

export function searchIndexContentHash(records: IndexRecord[]): string {
  const hash = createHash("sha256");
  for (const record of [...records].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(JSON.stringify(record));
    hash.update("\n");
  }
  return hash.digest("hex");
}

function setBoundedMetadataCache(key: string, metadata: SearchIndexMetadata): void {
  if (SEARCH_INDEX_METADATA_CACHE.has(key)) {
    SEARCH_INDEX_METADATA_CACHE.delete(key);
  }
  while (SEARCH_INDEX_METADATA_CACHE.size >= SEARCH_METADATA_CACHE_LIMIT) {
    const oldestKey = SEARCH_INDEX_METADATA_CACHE.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    SEARCH_INDEX_METADATA_CACHE.delete(oldestKey);
  }
  SEARCH_INDEX_METADATA_CACHE.set(key, metadata);
}

export const exists = openWikiPathExists;
