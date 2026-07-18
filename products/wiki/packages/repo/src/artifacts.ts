import { normalizeOpenWikiRepoPath } from "@openwiki/core";

const SHA256_HASH = "[a-f0-9]{64}";
const LOCAL_OBJECT_PATH = new RegExp(`^\\.openwiki/objects/([a-z][a-z0-9_-]{0,31})/sha256/[a-f0-9]{2}/${SHA256_HASH}\\.[a-z0-9][a-z0-9._-]{0,31}$`, "u");

type ArtifactKind = "source raw" | "source object" | "inbox payload" | "proposal diff" | "proposal snapshot" | "proposal validation report";

export function assertSourceRawArtifactPath(repoPath: string): string {
  return assertCanonicalArtifactPath(repoPath, "source raw", ["sources/raw/"]);
}

export function assertInboxPayloadArtifactPath(repoPath: string): string {
  return assertCanonicalArtifactPath(repoPath, "inbox payload", ["inbox/payloads/"]);
}

export function assertProposalDiffArtifactPath(repoPath: string): string {
  return assertCanonicalArtifactPath(repoPath, "proposal diff", ["proposals/diffs/"]);
}

export function assertProposalSnapshotArtifactPath(repoPath: string): string {
  return assertCanonicalArtifactPath(repoPath, "proposal snapshot", ["proposals/snapshots/"]);
}

export function assertProposalValidationReportArtifactPath(repoPath: string): string {
  return assertCanonicalArtifactPath(repoPath, "proposal validation report", ["proposals/reports/", "proposals/validation/"]);
}

export function assertSourceObjectArtifactPath(objectPath: string): string {
  return assertContentAddressedObjectArtifactPath(objectPath, "source object", ["sources"]);
}

export function assertInboxObjectArtifactPath(objectPath: string): string {
  return assertContentAddressedObjectArtifactPath(objectPath, "inbox payload", ["inbox"]);
}

function assertContentAddressedObjectArtifactPath(objectPath: string, kind: ArtifactKind, namespaces: string[]): string {
  const normalized = normalizeArtifactPath(objectPath, kind);
  if (normalized.startsWith("s3://")) {
    const parsed = new URL(normalized);
    const key = parsed.pathname.replace(/^\/+/, "");
    if (!hasObjectKeyShape(key, namespaces)) {
      throw new Error(`OpenWiki ${kind} path must be content-addressed under ${namespaces.join(" or ")}/sha256: ${objectPath}`);
    }
    return normalized;
  }
  const match = LOCAL_OBJECT_PATH.exec(normalized);
  if (!match || !namespaces.includes(match[1] ?? "")) {
    throw new Error(`OpenWiki ${kind} path must be content-addressed under .openwiki/objects/${namespaces.join(" or ")}/sha256: ${objectPath}`);
  }
  return normalized;
}

function assertCanonicalArtifactPath(repoPath: string, kind: ArtifactKind, prefixes: string[]): string {
  const normalized = normalizeArtifactPath(repoPath, kind);
  if (!prefixes.some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(`OpenWiki ${kind} path must be under ${prefixes.join(" or ")}: ${repoPath}`);
  }
  return normalized;
}

function normalizeArtifactPath(value: string, kind: ArtifactKind): string {
  if (value.startsWith("s3://")) {
    return normalizeS3ArtifactPath(value, kind);
  }
  const normalized = normalizeOpenWikiRepoPath(value);
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || normalized.includes("/./") || normalized.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`Invalid OpenWiki ${kind} path: ${value}`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`Invalid OpenWiki ${kind} path: ${value}`);
  }
  return normalized;
}

function normalizeS3ArtifactPath(value: string, kind: ArtifactKind): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid OpenWiki ${kind} path: ${value}`);
  }
  if (parsed.protocol !== "s3:" || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`Invalid OpenWiki ${kind} path: ${value}`);
  }
  const key = parsed.pathname.replace(/^\/+/, "");
  if (!key || /[\u0000-\u001f\u007f]/u.test(key) || key.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`Invalid OpenWiki ${kind} path: ${value}`);
  }
  return `s3://${parsed.hostname}/${key}`;
}

function hasObjectKeyShape(key: string, namespaces: string[]): boolean {
  const parts = key.split("/");
  for (let index = 0; index <= parts.length - 4; index += 1) {
    if (!namespaces.includes(parts[index] ?? "") || parts[index + 1] !== "sha256") {
      continue;
    }
    const shard = parts[index + 2] ?? "";
    const fileName = parts[index + 3] ?? "";
    if (/^[a-f0-9]{2}$/u.test(shard) && new RegExp(`^${SHA256_HASH}\\.[a-z0-9][a-z0-9._-]{0,31}$`, "u").test(fileName)) {
      return true;
    }
  }
  return false;
}
