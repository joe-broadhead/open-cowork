import type { GraphEdgeRecord } from "@openwiki/core";
import { type DerivedRecord, type LoadedOpenWikiRepo } from "@openwiki/repo";
import { createHash } from "node:crypto";
import { stableJson } from "./rows.ts";

// The record builders and DerivedRecord/SearchDocument shapes live in @openwiki/repo so the
// SQLite and Postgres store engines share one source of truth. Re-exported here for existing
// local importers; the SQLite-specific content hash and record grouping stay below.
export { collectDerivedRecords, searchDocumentFromRecord } from "@openwiki/repo";

export function recordGroupForDerivedRecord(record: DerivedRecord): string {
  if (record.record_type === "page") {
    const pageType = typeof record.json.page_type === "string" ? record.json.page_type : undefined;
    const frontmatterType = typeof record.json.type === "string" && record.json.type !== "page" ? record.json.type : undefined;
    return pageType ?? frontmatterType ?? "page";
  }
  if (record.record_type === "topic") {
    return "topic";
  }
  if (record.record_type === "section") {
    return "section";
  }
  if (record.record_type === "policy") {
    return "policy";
  }
  return record.record_type || "record";
}

export function derivedContentHash(repo: LoadedOpenWikiRepo, records: DerivedRecord[], edges: GraphEdgeRecord[]): string {
  return "sha256:" + createHash("sha256")
    .update(stableJson({
      config: repo.config,
      policy: repo.policy,
      records: records.map((record) => ({
        record_id: record.record_id,
        record_type: record.record_type,
        path: record.path,
        updated_at: record.updated_at,
        json: record.json,
      })),
      edges: edges.map((edge) => ({
        id: edge.id,
        from_id: edge.from_id,
        to_id: edge.to_id,
        edge_type: edge.edge_type,
        path: edge.path ?? "",
        anchor: edge.anchor ?? "",
        weight: edge.weight,
        metadata: edge.metadata ?? {},
      })).sort((left, right) => left.id.localeCompare(right.id)),
    }))
    .digest("hex");
}
