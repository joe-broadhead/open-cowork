import type { IndexRecord } from "./records.ts";
import type { ResolvedSearchConfig } from "./types.ts";
import { tokenizeOpenWikiText } from "@openwiki/core";
import { createHash } from "node:crypto";

export interface SearchChunk {
  id: string;
  record_id: string;
  record_type: string;
  path: string;
  ordinal: number;
  text: string;
  content_hash: string;
  character_count: number;
  token_count: number;
  source_ids: string[];
  updated_at: string;
}

const SEMANTIC_ALIASES: Record<string, string[]> = {
  agent: ["assistant", "automation"],
  agents: ["assistant", "automation"],
  assistant: ["agent", "automation"],
  assistants: ["agent", "automation"],
  auto: ["vehicle", "car"],
  automobile: ["vehicle", "car"],
  automobiles: ["vehicle", "car"],
  car: ["vehicle", "automobile"],
  cars: ["vehicle", "automobile"],
  citation: ["source", "evidence"],
  citations: ["source", "evidence"],
  document: ["source", "evidence"],
  documents: ["source", "evidence"],
  evidence: ["source", "citation"],
  knowledge: ["memory", "recall"],
  memories: ["memory", "recall"],
  memory: ["knowledge", "recall"],
  recall: ["memory", "knowledge"],
  remember: ["memory", "recall"],
  source: ["evidence", "citation"],
  sources: ["evidence", "citation"],
  vehicle: ["car", "automobile"],
  vehicles: ["car", "automobile"],
  wiki: ["knowledge", "memory"],
};

export function chunksForIndexRecord(record: IndexRecord, config: ResolvedSearchConfig["embedding"]): SearchChunk[] {
  const maxLength = Math.max(config.max_chunk_characters, 1);
  const overlap = Math.min(config.chunk_overlap_characters, Math.max(maxLength - 1, 0));
  const sourceText = normalizeChunkText([
    record.title,
    record.summary,
    record.body,
    record.topics.join(" "),
    record.source_ids.join(" "),
  ].join("\n"));
  if (sourceText.length === 0) {
    return [];
  }

  const chunks: SearchChunk[] = [];
  let start = 0;
  while (start < sourceText.length) {
    const end = Math.min(start + maxLength, sourceText.length);
    const text = sourceText.slice(start, end).trim();
    if (text.length > 0) {
      chunks.push(chunkForText(record, chunks.length, text));
    }
    if (end >= sourceText.length) {
      break;
    }
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

function chunkForText(record: IndexRecord, ordinal: number, text: string): SearchChunk {
  return {
    id: `chunk:${record.id}:${String(ordinal + 1).padStart(4, "0")}`,
    record_id: record.id,
    record_type: record.type,
    path: record.path,
    ordinal,
    text,
    content_hash: sha256Hex(text),
    character_count: text.length,
    token_count: tokenizeOpenWikiText(text).length,
    source_ids: record.source_ids,
    updated_at: record.updated_at,
  };
}

export function embedSearchTextLocal(text: string, dimensions: number): Float32Array {
  const size = Math.max(Math.trunc(dimensions), 1);
  const vector = new Float32Array(size);
  for (const token of semanticTokens(text)) {
    const index = hashToIndex(token, size);
    vector[index] = (vector[index] ?? 0) + 1;
  }
  normalizeVector(vector);
  return vector;
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  let score = 0;
  for (let index = 0; index < length; index += 1) {
    score += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return score;
}

export function serializeEmbedding(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

export function deserializeEmbedding(value: Buffer | Uint8Array): Float32Array {
  const bytes = Buffer.from(value);
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Float32Array(arrayBuffer);
}

export function embeddingEnabled(config: ResolvedSearchConfig): boolean {
  return config.embedding.enabled && config.embedding.provider === "local";
}

function semanticTokens(text: string): string[] {
  const tokens = tokenizeOpenWikiText(text);
  const expanded: string[] = [];
  for (const token of tokens) {
    expanded.push(token);
    expanded.push(...(SEMANTIC_ALIASES[token] ?? []));
  }
  return expanded;
}

function normalizeVector(vector: Float32Array): void {
  let magnitude = 0;
  for (const value of vector) {
    magnitude += value * value;
  }
  if (magnitude === 0) {
    return;
  }
  const divisor = Math.sqrt(magnitude);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / divisor;
  }
}

function hashToIndex(value: string, dimensions: number): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % dimensions;
}

function normalizeChunkText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sha256Hex(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
