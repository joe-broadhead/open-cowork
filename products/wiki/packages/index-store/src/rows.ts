import { indexStoreIndexedRecordJsonFromJson, parseJsonObject } from "./records.ts";
import { openWikiPrincipalTitle, openWikiPrincipalTypeForId, type OpenWikiSectionVisibility } from "@openwiki/core";
import type { DerivedEdgeRow, DerivedRecordRow } from "./types.ts";

export function rowFromDerivedRecord(row: unknown): DerivedRecordRow {
  const typed = row as Record<string, unknown>;
  const sensitivity = stringField(typed, "sensitivity");
  return {
    workspace_id: stringField(typed, "workspace_id") ?? "",
    record_id: stringField(typed, "record_id") ?? "",
    record_type: stringField(typed, "record_type") ?? "",
    record_group: stringField(typed, "record_group") ?? stringField(typed, "record_type") ?? "",
    uri: stringField(typed, "uri") ?? "",
    title: stringField(typed, "title") ?? "",
    summary: stringField(typed, "summary") ?? "",
    path: stringField(typed, "path") ?? "",
    status: stringField(typed, "status") ?? "",
    ...(isVisibility(sensitivity) ? { sensitivity } : {}),
    created_at: stringField(typed, "created_at") ?? "",
    updated_at: stringField(typed, "updated_at") ?? "",
    source_commit: stringField(typed, "source_commit") ?? "",
    json: indexStoreIndexedRecordJsonFromJson(stringField(typed, "json"), stringField(typed, "record_type") ?? ""),
  };
}

export function rowFromDerivedEdge(row: unknown): DerivedEdgeRow {
  const typed = row as Record<string, unknown>;
  const rowPath = stringField(typed, "path");
  const anchor = stringField(typed, "anchor");
  return {
    workspace_id: stringField(typed, "workspace_id") ?? "",
    edge_id: stringField(typed, "edge_id") ?? "",
    from_id: stringField(typed, "from_id") ?? "",
    to_id: stringField(typed, "to_id") ?? "",
    edge_type: stringField(typed, "edge_type") ?? "",
    ...(rowPath === undefined ? {} : { path: rowPath }),
    ...(anchor === undefined ? {} : { anchor }),
    weight: numberField(typed, "weight"),
    source_commit: stringField(typed, "source_commit") ?? "",
    created_at: stringField(typed, "created_at") ?? "",
    metadata: parseJsonObject(stringField(typed, "metadata")),
  };
}

function isVisibility(value: string | undefined): value is OpenWikiSectionVisibility {
  return value === "public" || value === "internal" || value === "private";
}

export function stringField(row: Record<string, unknown>, key: string): string | undefined {
  return typeof row[key] === "string" ? row[key] : undefined;
}

export function numberField(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

export function principalTypeForId(id: string): string {
  return openWikiPrincipalTypeForId(id);
}

export function principalTitle(id: string): string {
  return openWikiPrincipalTitle(id);
}

export function json(value: unknown): string {
  return stableJson(value);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}
