import { type GraphEdgeRecord, type OpenQuestionRecord, type PageRecord, type TopicSummary } from "@openwiki/core";
import { type DerivedRecord, normalizeRepoPath } from "@openwiki/repo";
import { createHash } from "node:crypto";
import { numberField, stringArrayField, stringField } from "./rows.ts";

// The record builders and DerivedRecord/SearchDocument shapes live in @openwiki/repo so the
// SQLite and Postgres store engines share one source of truth. Re-exported here for existing
// local importers; the Postgres-specific incremental-sync helpers and content hash stay below.
export { collectDerivedRecords, searchDocumentFromRecord } from "@openwiki/repo";

export function recordAffectedByPaths(record: DerivedRecord, changedPaths: string[]): boolean {
  if (changedPaths.length === 0) {
    return false;
  }
  const recordPath = normalizeRepoPath(record.path);
  if (changedPaths.some((changedPath) => pathTouchesRecord(changedPath, recordPath))) {
    return true;
  }
  if (record.record_type === "topic" && changedPaths.some((changedPath) => contentPathChangesTopics(changedPath))) {
    return true;
  }
  if (record.record_type === "workspace" && changedPaths.includes("openwiki.json")) {
    return true;
  }
  if (record.record_type === "policy" && changedPaths.some((changedPath) => changedPath.startsWith("policy/"))) {
    return true;
  }
  return false;
}

function pathTouchesRecord(changedPath: string, recordPath: string): boolean {
  const normalizedChangedPath = normalizeRepoPath(changedPath);
  return normalizedChangedPath === recordPath || normalizedChangedPath.startsWith(recordPath + "/") || recordPath.startsWith(normalizedChangedPath + "/");
}

export function contentPathChangesTopics(changedPath: string): boolean {
  return changedPath.startsWith("wiki/") ||
    changedPath.startsWith("sources/") ||
    changedPath === "claims/claim-index.jsonl" ||
    changedPath === "facts/facts.jsonl" ||
    changedPath === "takes/takes.jsonl";
}

export function topicFromRuntimeRecord(record: Record<string, unknown>): TopicSummary {
  return {
    topic: stringField(record, "topic") ?? "",
    page_count: numberField(record, "page_count"),
    page_ids: stringArrayField(record, "page_ids"),
    claim_count: numberField(record, "claim_count"),
    source_count: numberField(record, "source_count"),
    source_ids: stringArrayField(record, "source_ids"),
    updated_at: stringField(record, "updated_at") ?? "",
  };
}

export function openQuestionsFromPageRecord(page: PageRecord): OpenQuestionRecord[] {
  const lines = page.body.split(/\r?\n/u);
  const questions: OpenQuestionRecord[] = [];
  let inOpenQuestions = false;
  let sectionLevel = 0;
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 0;
      const title = heading[2] ?? "";
      if (/^open questions?$/iu.test(title.trim())) {
        inOpenQuestions = true;
        sectionLevel = level;
        continue;
      }
      if (inOpenQuestions && level <= sectionLevel) {
        inOpenQuestions = false;
      }
    }
    if (!inOpenQuestions) {
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+?)\s*$/u.exec(line);
    const question = (bullet?.[1] ?? "").trim();
    if (!question) {
      continue;
    }
    questions.push({
      id: `${page.id}:open-question:${questions.length + 1}`,
      question,
      page_id: page.id,
      page_title: page.title,
      page_uri: page.uri,
      path: page.path,
      topics: page.topics,
      updated_at: page.updated_at,
    });
  }
  return questions;
}

export function derivedRuntimeContentHash(records: DerivedRecord[], edges: GraphEdgeRecord[]): string {
  const hash = createHash("sha256");
  const recordPayload = records
    .map((record) => ({
      id: record.record_id,
      type: record.record_type,
      path: record.path,
      status: record.status,
      json: record.json,
      search_text: record.search_text,
    }));
  sortByIdIfNeeded(recordPayload);
  const edgePayload = edges
    .map((edge) => ({
      id: edge.id,
      from_id: edge.from_id,
      to_id: edge.to_id,
      edge_type: edge.edge_type,
      path: edge.path ?? "",
      anchor: edge.anchor ?? "",
      weight: edge.weight,
      metadata: edge.metadata ?? {},
    }));
  sortByIdIfNeeded(edgePayload);
  hash.update(JSON.stringify({ records: recordPayload, edges: edgePayload }));
  return `sha256:${hash.digest("hex")}`;
}

function sortByIdIfNeeded<T extends { id: string }>(items: T[]): void {
  for (let index = 1; index < items.length; index += 1) {
    if (items[index - 1]!.id.localeCompare(items[index]!.id) > 0) {
      items.sort((left, right) => left.id.localeCompare(right.id));
      return;
    }
  }
}
