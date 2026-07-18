import { openWikiGitArgs, openWikiGitEnv } from "@openwiki/core";
import { normalizeRepoPath } from "@openwiki/repo";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

export const execFile = promisify(execFileCallback);

export async function gitDirtyPaths(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFile("git", openWikiGitArgs(undefined, ["status", "--porcelain=v1", "-z"]), { cwd: root, env: openWikiGitEnv() });
    return parseGitPorcelainPathsZ(stdout);
  } catch {
    return undefined;
  }
}

function parseGitPorcelainPathsZ(stdout: string): string[] {
  const entries = stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) {
      continue;
    }
    const status = entry.slice(0, 2);
    const firstPath = entry.slice(3);
    if ((status[0] === "R" || status[0] === "C") && entries[index + 1] !== undefined) {
      paths.push(firstPath, entries[index + 1] ?? "");
      index += 1;
      continue;
    }
    paths.push(firstPath);
  }
  return [...new Set(paths.map(normalizeRepoPath).filter(Boolean))]
    .sort();
}

export async function currentGitCommit(root: string): Promise<string> {
  try {
    const { stdout } = await execFile("git", openWikiGitArgs(undefined, ["rev-parse", "HEAD"]), { cwd: root, env: openWikiGitEnv() });
    const sha = stdout.trim();
    return sha || "uncommitted";
  } catch {
    return "uncommitted";
  }
}

export async function changedGitPaths(root: string, fromCommit: string, toCommit: string): Promise<string[]> {
  try {
    const { stdout } = await execFile("git", openWikiGitArgs(undefined, ["diff", "--name-status", "-z", `${fromCommit}..${toCommit}`]), { cwd: root, env: openWikiGitEnv() });
    return parseGitNameStatusPathsZ(stdout);
  } catch {
    return [];
  }
}

export function parseGitNameStatusPathsZ(stdout: string): string[] {
  const entries = stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const status = entries[index] ?? "";
    const firstPath = entries[index + 1];
    if (firstPath === undefined) {
      break;
    }
    paths.push(firstPath);
    index += 1;
    if ((status.startsWith("R") || status.startsWith("C")) && entries[index + 1] !== undefined) {
      paths.push(entries[index + 1] ?? "");
      index += 1;
    }
  }
  return [...new Set(paths.map(normalizeRepoPath).filter(Boolean))]
    .sort();
}
