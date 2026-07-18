import { openWikiGitArgs, openWikiGitEnv, openWikiPathExists } from "@openwiki/core";
import { listGraphEdges, listTopics, loadRepository } from "@openwiki/repo";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { collectDerivedRecords, derivedContentHash } from "./derived-records.ts";
import type { GitCommitInfo } from "./types.ts";

export const execFile = promisify(execFileCallback);

export async function currentDerivedContentHash(root: string): Promise<string> {
  const [repo, graph, topics] = await Promise.all([loadRepository(root), listGraphEdges(root), listTopics(root)]);
  const records = collectDerivedRecords(repo, topics.topics);
  return derivedContentHash(repo, records, graph.edges);
}

export async function gitWorktreeClean(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFile("git", openWikiGitArgs(undefined, ["status", "--porcelain"]), { cwd: root, env: openWikiGitEnv() });
    return stdout.trim().length === 0;
  } catch {
    return false;
  }
}

export async function gitCommitInfo(root: string): Promise<GitCommitInfo | undefined> {
  try {
    const { stdout } = await execFile("git", openWikiGitArgs(undefined, ["show", "-s", "--format=%H%n%P%n%an <%ae>%n%aI%n%cn <%ce>%n%cI%n%s", "HEAD"]), { cwd: root, env: openWikiGitEnv() });
    const lines = stdout.split(/\r?\n/);
    const sha = (lines[0] ?? "").trim();
    if (!sha) {
      return undefined;
    }
    return {
      sha,
      parent_sha: (lines[1] ?? "").trim(),
      author: (lines[2] ?? "").trim(),
      authored_at: (lines[3] ?? "").trim(),
      committer: (lines[4] ?? "").trim(),
      committed_at: (lines[5] ?? "").trim(),
      subject: lines.slice(6).join("\n").trim(),
    };
  } catch {
    return undefined;
  }
}

export const exists = openWikiPathExists;
