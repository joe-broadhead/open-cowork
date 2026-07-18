import { promises as fs } from "node:fs";
import path from "node:path";
import { gitWithOutput } from "@openwiki/git";
import { safeRepoPath } from "./io.ts";

export const OPENWIKI_PROPOSAL_APPLY_PATHS = [
  ".gitignore",
  "openwiki.json",
  "wiki",
  "sources",
  "claims",
  "facts",
  "takes",
  "proposals",
  "decisions",
  "events",
  "runs",
  "policy",
];
const OPENWIKI_MANAGED_COMMIT_PATHS = [
  ".gitignore",
  ".opencode",
  "AGENTS.md",
  "opencode.json",
  "opencode.openwiki.json",
  "openwiki.json",
  "wiki",
  "inbox",
  "sources",
  "claims",
  "facts",
  "takes",
  "proposals",
  "decisions",
  "events",
  "runs",
  "policy",
];
export const OPENWIKI_BACKUP_PATHS = [...OPENWIKI_MANAGED_COMMIT_PATHS, ".git", ".openwiki/objects"];

export async function currentGitCommit(root: string): Promise<string | undefined> {
  try {
    const { stdout } = await gitWithOutput(root, ["rev-parse", "--short", "HEAD"]);
    const commit = stdout.trim();
    return commit || undefined;
  } catch {
    return undefined;
  }
}

export async function currentGitDirtyState(root: string): Promise<boolean | undefined> {
  try {
    const { stdout } = await gitWithOutput(root, ["status", "--porcelain"]);
    return stdout.trim().length > 0;
  } catch {
    return undefined;
  }
}

export async function currentGitCommitFull(root: string): Promise<string> {
  const { stdout } = await gitWithOutput(root, ["rev-parse", "HEAD"]);
  const commit = stdout.trim();
  if (!commit) {
    throw new Error("Unable to resolve current Git commit");
  }
  return commit;
}

export async function gitAdd(root: string, relativePaths: string[]): Promise<void> {
  const paths = relativePaths.filter(Boolean);
  if (paths.length === 0) {
    return;
  }
  await gitWithOutput(root, ["add", "-A", "--", ...paths]);
}

export async function gitCommit(root: string, message: string): Promise<void> {
  await gitWithOutput(root, ["commit", "-m", message]);
}

export async function gitPathsChangedSince(root: string, baseCommit: string, relativePaths: string[]): Promise<boolean> {
  const paths = relativePaths.map((relativePath) => normalizeCommitPath(root, relativePath));
  if (paths.length === 0) {
    return false;
  }
  try {
    await gitWithOutput(root, ["diff", "--quiet", baseCommit, "HEAD", "--", ...paths]);
    return false;
  } catch (error) {
    if (commandExitCode(error) === 1) {
      return true;
    }
    throw error;
  }
}

export async function gitFileAtCommit(root: string, commit: string, relativePath: string): Promise<string | undefined> {
  const normalized = normalizeCommitPath(root, relativePath);
  try {
    const { stdout } = await gitWithOutput(root, ["show", "--no-ext-diff", "--end-of-options", `${commit}:${normalized}`]);
    return stdout;
  } catch {
    return undefined;
  }
}

export async function isGitRepository(root: string): Promise<boolean> {
  try {
    const { stdout } = await gitWithOutput(root, ["rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function stageOpenWikiManagedPaths(root: string): Promise<void> {
  const existingPaths: string[] = [];
  for (const managedPath of OPENWIKI_MANAGED_COMMIT_PATHS) {
    try {
      await fs.access(safeRepoPath(root, managedPath));
      existingPaths.push(managedPath);
    } catch {
      // Optional ledgers may not exist in a small local workspace yet.
    }
  }
  await gitAdd(root, existingPaths);
}

export function isOpenWikiManagedCommitPath(value: string): boolean {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/").trim());
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.isAbsolute(value)) {
    return false;
  }
  return OPENWIKI_MANAGED_COMMIT_PATHS.some((managedPath) => normalized === managedPath || normalized.startsWith(`${managedPath}/`));
}

export async function gitStagedPaths(root: string): Promise<string[]> {
  const { stdout } = await gitWithOutput(root, ["diff", "--cached", "--name-only"]);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function normalizeCommitPath(root: string, value: string): string {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/").trim());
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.isAbsolute(value)) {
    throw new Error(`Invalid OpenWiki commit path: ${value}`);
  }
  safeRepoPath(root, normalized);
  return normalized;
}

function commandExitCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}
