import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile, isoNow } from "@openwiki/core";

export interface GitSyncStateEntry {
  operation: "sync" | "pull" | "push" | "connect" | "enable" | "disable" | "repair";
  status: string;
  occurred_at: string;
  remote?: string;
  branch?: string;
  message?: string;
  error?: string;
}

export interface GitSyncConflictState {
  has_conflicts: boolean;
  paths: string[];
  occurred_at?: string;
  message?: string;
}

export interface GitSyncState {
  schema_version: "openwiki.git_sync_state.v0";
  updated_at: string;
  last_success?: GitSyncStateEntry;
  last_failure?: GitSyncStateEntry;
  conflict?: GitSyncConflictState;
}

interface GitStatusLike {
  index: string;
  working_tree: string;
  path: string;
}

export async function readGitSyncState(root: string): Promise<GitSyncState> {
  const statePath = gitSyncStatePath(root);
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return emptyGitSyncState();
    }
    const record = parsed as Record<string, unknown>;
    if (record.schema_version !== "openwiki.git_sync_state.v0" || typeof record.updated_at !== "string") {
      return emptyGitSyncState();
    }
    const lastSuccess = syncStateEntryFromUnknown(record.last_success);
    const lastFailure = syncStateEntryFromUnknown(record.last_failure);
    const conflict = syncConflictFromUnknown(record.conflict);
    return {
      schema_version: "openwiki.git_sync_state.v0",
      updated_at: record.updated_at,
      ...(lastSuccess === undefined ? {} : { last_success: lastSuccess }),
      ...(lastFailure === undefined ? {} : { last_failure: lastFailure }),
      ...(conflict === undefined ? {} : { conflict }),
    };
  } catch {
    return emptyGitSyncState();
  }
}

export async function writeGitSyncState(root: string, state: GitSyncState): Promise<void> {
  await ensureGitSyncStateIgnored(root);
  const statePath = gitSyncStatePath(root);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await atomicWriteFile(statePath, JSON.stringify(state, null, 2) + "\n");
}

export function conflictPathsFromGitStatus(changes: GitStatusLike[]): string[] {
  const conflictPairs = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
  return changes
    .filter((change) => change.index === "U" || change.working_tree === "U" || conflictPairs.has(change.index + change.working_tree))
    .map((change) => change.path);
}

function gitSyncStatePath(root: string): string {
  return path.join(path.resolve(root), ".openwiki", "sync", "state.json");
}

async function ensureGitSyncStateIgnored(root: string): Promise<void> {
  const excludePath = path.join(path.resolve(root), ".git", "info", "exclude");
  try {
    const current = await fs.readFile(excludePath, "utf8");
    if (current.split(/\r?\n/).some((line) => line.trim() === ".openwiki/sync/")) {
      return;
    }
    await atomicWriteFile(excludePath, `${current.trimEnd()}\n.openwiki/sync/\n`);
  } catch {
    // Non-Git workspaces can still read/write sync state for diagnostics.
  }
}

function emptyGitSyncState(): GitSyncState {
  return {
    schema_version: "openwiki.git_sync_state.v0",
    updated_at: isoNow(),
  };
}

function syncStateEntryFromUnknown(value: unknown): GitSyncStateEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.operation !== "string" || typeof record.status !== "string" || typeof record.occurred_at !== "string") {
    return undefined;
  }
  if (!["sync", "pull", "push", "connect", "enable", "disable", "repair"].includes(record.operation)) {
    return undefined;
  }
  return {
    operation: record.operation as GitSyncStateEntry["operation"],
    status: record.status,
    occurred_at: record.occurred_at,
    ...(typeof record.remote === "string" ? { remote: record.remote } : {}),
    ...(typeof record.branch === "string" ? { branch: record.branch } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
  };
}

function syncConflictFromUnknown(value: unknown): GitSyncConflictState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.has_conflicts !== "boolean" || !Array.isArray(record.paths)) {
    return undefined;
  }
  return {
    has_conflicts: record.has_conflicts,
    paths: record.paths.filter((entry): entry is string => typeof entry === "string"),
    ...(typeof record.occurred_at === "string" ? { occurred_at: record.occurred_at } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  };
}
