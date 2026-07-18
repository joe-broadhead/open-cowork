import { OpenWikiPolicyDeniedError, assertOpenWikiId } from "@openwiki/core";
import { appendEvent, loadRepository } from "@openwiki/repo";
import { withWriteCoordination } from "./write-coordinator.ts";
import { rebuildDerivedIndexes } from "./derived-indexes.ts";
import {
  currentGitCommit,
  currentGitCommitFull,
  gitAdd,
  gitCommit,
  gitStagedPaths,
  isOpenWikiManagedCommitPath,
  isGitRepository,
  normalizeCommitPath,
  stageOpenWikiManagedPaths,
} from "./git.ts";
import type { CommitChangesInput, CommitChangesResult } from "./types.ts";

export async function commitChanges(input: CommitChangesInput): Promise<CommitChangesResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.commit_changes",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: {
        all: input.all === true,
        path_count: input.paths?.length ?? 0,
      },
    },
    () => commitChangesUnlocked(input),
  );
}

async function commitChangesUnlocked(input: CommitChangesInput): Promise<CommitChangesResult> {
  const repo = await loadRepository(input.root);
  const actorId = input.actorId ?? "actor:user:local";
  assertOpenWikiId(actorId, "actor");
  const message = input.message.trim();
  if (!message) {
    throw new Error("Commit message cannot be empty");
  }
  const mode: CommitChangesResult["mode"] =
    input.all === true ? "all" : input.paths !== undefined && input.paths.length > 0 ? "paths" : "staged";

  if (!(await isGitRepository(repo.root))) {
    return {
      root: repo.root,
      is_git_repo: false,
      committed: false,
      status: "not_git_repo",
      mode,
      message,
      staged_paths: [],
    };
  }

  if (mode === "all") {
    await stageOpenWikiManagedPaths(repo.root);
  } else if (mode === "paths") {
    const normalizedPaths = (input.paths ?? []).map((commitPath) => normalizeCommitPath(repo.root, commitPath));
    await authorizeCommitPaths(input, normalizedPaths);
    await gitAdd(repo.root, normalizedPaths);
  }

  const stagedPaths = await gitStagedPaths(repo.root);
  if (stagedPaths.length === 0) {
    return {
      root: repo.root,
      is_git_repo: true,
      committed: false,
      status: "no_changes",
      mode,
      message,
      staged_paths: [],
    };
  }
  await authorizeCommitPaths(input, stagedPaths);

  await gitCommit(repo.root, message);
  const sha = await currentGitCommitFull(repo.root);
  const shortSha = (await currentGitCommit(repo.root)) ?? sha.slice(0, 12);
  const event = await appendEvent(repo.root, {
    type: "git.committed",
    actor_id: actorId,
    operation: "wiki.commit_changes",
    record_id: `commit:${shortSha}`,
    record_type: "commit",
    data: {
      message,
      mode,
      staged_paths: stagedPaths,
      sha,
      short_sha: shortSha,
    },
  });
  await gitAdd(repo.root, [event.path]);
  await gitCommit(repo.root, `Record commit audit for ${shortSha}`);
  await rebuildDerivedIndexes(repo.root);

  return {
    root: repo.root,
    is_git_repo: true,
    committed: true,
    status: "committed",
    mode,
    message,
    staged_paths: stagedPaths,
    sha,
    short_sha: shortSha,
    event,
  };
}

async function authorizeCommitPaths(input: CommitChangesInput, paths: string[]): Promise<void> {
  if (input.authorizePaths === undefined) {
    return;
  }
  for (const repoPath of paths) {
    if (!isOpenWikiManagedCommitPath(repoPath)) {
      throw new OpenWikiPolicyDeniedError(`Cannot commit unmanaged path '${repoPath}' through this OpenWiki interface`);
    }
  }
  await input.authorizePaths(paths);
}
