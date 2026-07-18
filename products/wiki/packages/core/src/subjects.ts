import { uniqueStrings } from "./ids.ts";
import { redactOpenWikiRunEventRecord, redactOpenWikiRunRecord, type EventRecord, type RunRecord } from "./records.ts";

export interface OpenWikiDerivedEventSubjectView {
  record: EventRecord;
  searchText: string;
}

export interface OpenWikiDerivedRunSubjectView {
  record: RunRecord;
  searchText: string;
}

export interface OpenWikiSubjectPathExtractionOptions {
  includeSensitivePathKeys?: boolean;
}

export function openWikiSubjectPathsFromUnknown(
  value: unknown,
  options: OpenWikiSubjectPathExtractionOptions = {},
  depth = 0,
  seen = new WeakSet<object>(),
): string[] {
  if (depth > 8 || value === undefined || value === null) {
    return [];
  }
  if (typeof value === "string") {
    return looksLikeOpenWikiRepoPath(value) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return uniqueStrings(value.flatMap((entry) => openWikiSubjectPathsFromUnknown(entry, options, depth + 1, seen)), { omitEmpty: true });
  }
  if (typeof value !== "object") {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);
  const paths: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase();
    const pathKey = isSubjectPathKey(normalizedKey);
    if (normalizedKey === "url" || normalizedKey.endsWith("_url") || (sensitiveKey(normalizedKey) && !(options.includeSensitivePathKeys === true && pathKey))) {
      continue;
    }
    if (pathKey) {
      paths.push(...openWikiSubjectPathsFromUnknown(entry, options, depth + 1, seen));
      continue;
    }
    if (typeof entry === "object" && entry !== null) {
      paths.push(...openWikiSubjectPathsFromUnknown(entry, options, depth + 1, seen));
    }
  }
  return uniqueStrings(paths, { omitEmpty: true });
}

export function openWikiEventSubjectPaths(input: { explicitPaths?: string[] | undefined; data?: unknown }): string[] {
  return uniqueStrings(input.explicitPaths ?? openWikiSubjectPathsFromUnknown(input.data, { includeSensitivePathKeys: true }), { omitEmpty: true });
}

export function openWikiRunSubjectPaths(input: { explicitPaths?: string[] | undefined; input?: unknown; output?: unknown }): string[] {
  return uniqueStrings(input.explicitPaths ?? [
    ...openWikiSubjectPathsFromUnknown(input.input, { includeSensitivePathKeys: true }),
    ...openWikiSubjectPathsFromUnknown(input.output, { includeSensitivePathKeys: true }),
  ], { omitEmpty: true });
}

export function openWikiEventVisibilitySubjectPaths(input: { data?: unknown }): string[] {
  return uniqueStrings(openWikiSubjectPathsFromUnknown(input.data, { includeSensitivePathKeys: true }), { omitEmpty: true });
}

export function openWikiRunVisibilitySubjectPaths(input: { input?: unknown; output?: unknown }): string[] {
  return uniqueStrings([
    ...openWikiSubjectPathsFromUnknown(input.input, { includeSensitivePathKeys: true }),
    ...openWikiSubjectPathsFromUnknown(input.output, { includeSensitivePathKeys: true }),
  ], { omitEmpty: true });
}

function isSubjectPathKey(normalizedKey: string): boolean {
  return normalizedKey === "path" || normalizedKey.endsWith("_path") || normalizedKey === "paths" || normalizedKey.endsWith("_paths");
}

function sensitiveKey(normalizedKey: string): boolean {
  return normalizedKey.includes("token") || normalizedKey.includes("secret");
}

export function looksLikeOpenWikiRepoPath(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.includes("://") &&
    !trimmed.startsWith("openwiki://") &&
    !trimmed.startsWith("sha256:") &&
    !trimmed.startsWith("actor:") &&
    !trimmed.startsWith("page:") &&
    !trimmed.startsWith("source:") &&
    !trimmed.startsWith("claim:") &&
    !trimmed.startsWith("inbox:") &&
    !trimmed.startsWith("proposal:") &&
    !trimmed.startsWith("decision:") &&
    !trimmed.startsWith("event:") &&
    !trimmed.startsWith("run:") &&
    !trimmed.startsWith("commit:") &&
    !trimmed.startsWith("/") &&
    !trimmed.includes("..")
  );
}

export function openWikiDerivedEventSubjectView(event: EventRecord): OpenWikiDerivedEventSubjectView {
  const record = redactOpenWikiRunEventRecord(event);
  return {
    record,
    searchText: [record.type, record.operation ?? "", record.actor_id ?? "", record.record_id ?? "", JSON.stringify(record.data ?? {})].join(" "),
  };
}

export function openWikiDerivedRunSubjectView(run: RunRecord): OpenWikiDerivedRunSubjectView {
  const record = redactOpenWikiRunRecord(run);
  return {
    record,
    searchText: [record.run_type, record.status, record.actor_id, JSON.stringify(record.input ?? {}), JSON.stringify(record.output ?? {})].join(" "),
  };
}
