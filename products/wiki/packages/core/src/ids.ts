import type { OpenWikiKind } from "./protocol.ts";

interface CanonicalIdParts {
  kind: OpenWikiKind;
  segments: string[];
}

const VALID_KIND = new Set<OpenWikiKind>([
  "page",
  "source",
  "fragment",
  "claim",
  "fact",
  "take",
  "inbox",
  "proposal",
  "comment",
  "decision",
  "commit",
  "actor",
  "run",
  "organization",
  "tenant",
  "workspace",
  "workspace_repo",
  "event",
  "policy",
  "edge",
  "topic",
  "section",
]);

const SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function parseOpenWikiId(id: string): CanonicalIdParts {
  const parts = id.split(":").filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Invalid OpenWiki ID '${id}': expected <kind>:<segment>`);
  }

  const [kind, ...segments] = parts;
  if (!isOpenWikiKind(kind)) {
    throw new Error(`Invalid OpenWiki ID '${id}': unknown kind '${kind ?? ""}'`);
  }

  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) {
      throw new Error(`Invalid OpenWiki ID '${id}': bad segment '${segment}'`);
    }
  }

  return { kind, segments };
}

function isOpenWikiKind(value: unknown): value is OpenWikiKind {
  return typeof value === "string" && VALID_KIND.has(value as OpenWikiKind);
}

export function assertOpenWikiId(id: string, expectedKind?: OpenWikiKind): string {
  const parsed = parseOpenWikiId(id);
  if (expectedKind && parsed.kind !== expectedKind) {
    throw new Error(`Expected ${expectedKind} ID, got '${id}'`);
  }
  return id;
}

export function idToUri(id: string): string {
  const parsed = parseOpenWikiId(id);
  return `openwiki://${parsed.kind}/${parsed.segments.map(encodeURIComponent).join("/")}`;
}

export function uriToId(uri: string): string {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid OpenWiki URI '${uri}'`);
  }
  if (parsed.protocol !== "openwiki:") {
    throw new Error(`Invalid OpenWiki URI '${uri}': expected openwiki://`);
  }
  const kind = parsed.hostname;
  if (!isOpenWikiKind(kind)) {
    throw new Error(`Invalid OpenWiki URI '${uri}': unknown kind '${kind}'`);
  }
  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  if (segments.length === 0) {
    throw new Error(`Invalid OpenWiki URI '${uri}': missing identifier segment`);
  }
  return [kind, ...segments].join(":");
}

export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

export function uniqueStrings(values: readonly string[], options: { trim?: boolean; omitEmpty?: boolean } = {}): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const value = options.trim ? entry.trim() : entry;
    if ((options.omitEmpty && value.trim().length === 0) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function pageId(pageType: string, slug: string): string {
  return `page:${slugify(pageType)}:${slugify(slug)}`;
}
