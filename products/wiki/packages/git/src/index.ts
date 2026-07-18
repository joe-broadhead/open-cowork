import path from "node:path";
import { OpenWikiError, atomicWriteFile, uriToId, writeOpenWikiLog } from "@openwiki/core";
import { loadRepository } from "@openwiki/repo";
import { git, gitOptional, gitWithOutput } from "./process.ts";
import {
  redactRemoteUrl,
  sanitizeGitOutput,
  validateGitBranchName,
  validateGitRemoteName,
  validateSafeGitRemoteUrl,
} from "./validation.ts";
import { conflictPathsFromGitStatus } from "./sync-state.ts";

export {
  conflictPathsFromGitStatus,
  readGitSyncState,
  writeGitSyncState,
  type GitSyncConflictState,
  type GitSyncState,
  type GitSyncStateEntry,
} from "./sync-state.ts";

export {
  gitRemoteReachability,
  type GitRemoteReachabilityResponse,
  type GitRemoteReachabilityStatus,
} from "./reachability.ts";

export { git, gitArgs, gitOptional, gitWithOutput } from "./process.ts";
export { redactRemoteUrl, sanitizeGitOutput, validateGitBranchName, validateGitRemoteName, validateSafeGitRemoteUrl } from "./validation.ts";

export class InvalidGitRevisionError extends OpenWikiError {
  constructor(message: string) {
    super("invalid_git_revision", message, 400);
    this.name = "InvalidGitRevisionError";
  }
}

export interface GitCommitEntry {
  sha: string;
  short_sha: string;
  author_name: string;
  author_email: string;
  date: string;
  subject: string;
}

export interface GitFileChange {
  status: string;
  path: string;
}

export interface GitHistoryResponse {
  root: string;
  record_id: string;
  path: string;
  is_git_repo: boolean;
  commits: GitCommitEntry[];
}

export interface GitDiffRequest {
  root: string;
  id: string;
  from?: string;
  to?: string;
}

export interface GitDiffResponse {
  root: string;
  record_id: string;
  path: string;
  is_git_repo: boolean;
  from?: string;
  to?: string;
  diff: string;
}

export interface RecentChangeEntry extends GitCommitEntry {
  files: GitFileChange[];
}

export interface RecentChangesResponse {
  root: string;
  is_git_repo: boolean;
  changes: RecentChangeEntry[];
}

export interface GitCommitResponse {
  root: string;
  is_git_repo: boolean;
  sha: string;
  commit: RecentChangeEntry | null;
}

export interface GitStatusEntry {
  index: string;
  working_tree: string;
  path: string;
}

export interface GitRemoteStatusResponse {
  root: string;
  is_git_repo: boolean;
  branch?: string;
  upstream?: string;
  remote?: string;
  remote_url?: string;
  ahead: number;
  behind: number;
  clean: boolean;
  staged_paths: string[];
  unstaged_paths: string[];
  untracked_paths: string[];
  conflict_state: "none" | "conflicted";
  conflict_paths: string[];
  changes: GitStatusEntry[];
}

export interface GitRemoteSyncOptions {
  remote?: string;
  branch?: string;
}

export interface GitRemoteSyncResponse {
  root: string;
  is_git_repo: boolean;
  operation: "pull" | "push";
  status: "pulled" | "pushed" | "not_git_repo" | "no_remote";
  remote?: string;
  branch?: string;
  remote_url?: string;
  before?: GitRemoteStatusResponse;
  after?: GitRemoteStatusResponse;
  stdout: string;
  stderr: string;
}

export interface GitRemoteConfigureOptions {
  remote?: string;
  branch?: string;
  remote_url?: string;
  credential_ref?: string;
}

export interface GitRemoteConfigureResponse {
  root: string;
  is_git_repo: boolean;
  remote: string;
  branch: string;
  remote_url?: string;
  credential_ref?: string;
  config_path: string;
}

export async function configureGitRemote(root: string, options: GitRemoteConfigureOptions): Promise<GitRemoteConfigureResponse> {
  const repo = await loadRepository(root);
  const remote = options.remote ?? repo.config.runtime?.git?.remote ?? "origin";
  const branch = options.branch ?? repo.config.runtime?.git?.branch ?? "main";
  const remoteUrl = options.remote_url ?? repo.config.runtime?.git?.remote_url;
  validateGitRemoteName(remote);
  validateGitBranchName(branch);
  if (remoteUrl !== undefined) {
    validateSafeGitRemoteUrl(remoteUrl);
  }

  if (!(await isGitRepo(repo.root))) {
    await gitWithOutput(repo.root, ["init", "--initial-branch", branch]);
  }
  if (remoteUrl !== undefined) {
    const existing = await gitOptional(repo.root, ["remote", "get-url", remote]);
    await gitWithOutput(repo.root, existing === undefined ? ["remote", "add", remote, remoteUrl] : ["remote", "set-url", remote, remoteUrl]);
  }
  await gitWithOutput(repo.root, ["config", `branch.${branch}.remote`, remote]);
  await gitWithOutput(repo.root, ["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);

  const nextConfig = {
    ...repo.config,
    runtime: {
      ...(repo.config.runtime ?? {}),
      git: {
        ...(repo.config.runtime?.git ?? {}),
        remote,
        branch,
        ...(remoteUrl === undefined ? {} : { remote_url: remoteUrl }),
        ...(options.credential_ref === undefined ? {} : { credential_ref: options.credential_ref }),
      },
    },
  };
  const configPath = path.join(repo.root, "openwiki.json");
  await atomicWriteFile(configPath, JSON.stringify(nextConfig, null, 2) + "\n");
  return {
    root: repo.root,
    is_git_repo: await isGitRepo(repo.root),
    remote,
    branch,
    ...(remoteUrl === undefined ? {} : { remote_url: redactRemoteUrl(remoteUrl) }),
    ...(options.credential_ref === undefined ? {} : { credential_ref: options.credential_ref }),
    config_path: "openwiki.json",
  };
}

export async function getHistory(root: string, id: string, limit = 20): Promise<GitHistoryResponse> {
  const target = await resolveRecordTarget(root, id);
  return await getHistoryForTarget(target, limit);
}

export async function getHistoryForPath(root: string, id: string, repoPath: string, limit = 20): Promise<GitHistoryResponse> {
  const normalizedPath = normalizeGitPathSpec(repoPath);
  const recordId = id.startsWith("openwiki://") ? uriToId(id) : id;
  return await getHistoryForTarget({ root: path.resolve(root), recordId, path: normalizedPath }, limit);
}

async function getHistoryForTarget(target: { root: string; recordId: string; path: string }, limit: number): Promise<GitHistoryResponse> {
  if (!(await isGitRepo(target.root))) {
    return { root: target.root, record_id: target.recordId, path: target.path, is_git_repo: false, commits: [] };
  }

  const count = Math.min(Math.max(limit, 1), 100);
  const stdout = await gitOrEmpty(target.root, [
    "log",
    `--max-count=${count}`,
    "--date=iso-strict",
    "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s",
    "--",
    target.path,
  ]);
  return {
    root: target.root,
    record_id: target.recordId,
    path: target.path,
    is_git_repo: true,
    commits: stdout
      .split(/\r?\n/)
      .map((line) => parseCommitLine(line))
      .filter((commit): commit is GitCommitEntry => Boolean(commit)),
  };
}

export async function diffVersions(input: GitDiffRequest): Promise<GitDiffResponse> {
  const target = await resolveRecordTarget(input.root, input.id);
  if (!(await isGitRepo(target.root))) {
    return emptyDiff(target, input, false);
  }

  const range = await diffRange(target.root, input);
  const stdout = await git(target.root, range.length === 0
    ? ["diff", "--no-ext-diff", "--", target.path]
    : ["diff", "--no-ext-diff", "--end-of-options", ...range, "--", target.path]);
  return {
    root: target.root,
    record_id: target.recordId,
    path: target.path,
    is_git_repo: true,
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to }),
    diff: stdout,
  };
}

export async function listRecentChanges(root: string, limit = 20): Promise<RecentChangesResponse> {
  const repo = await loadRepository(root);
  if (!(await isGitRepo(repo.root))) {
    return { root: repo.root, is_git_repo: false, changes: [] };
  }

  const count = Math.min(Math.max(limit, 1), 100);
  const stdout = await gitOrEmpty(repo.root, [
    "log",
    `--max-count=${count}`,
    "--date=iso-strict",
    "--format=%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s",
    "--name-status",
  ]);
  return {
    root: repo.root,
    is_git_repo: true,
    changes: parseRecentChanges(stdout),
  };
}

export async function readCommit(root: string, sha: string): Promise<GitCommitResponse> {
  const repo = await loadRepository(root);
  const normalizedSha = sha.replace(/^commit:/, "").trim();
  if (!normalizedSha) {
    throw new Error("Expected commit SHA");
  }
  if (!(await isGitRepo(repo.root))) {
    return { root: repo.root, is_git_repo: false, sha: normalizedSha, commit: null };
  }

  const commitSha = await resolveGitCommit(repo.root, normalizedSha, "commit");
  const stdout = await gitOrEmpty(repo.root, [
    "show",
    "--no-ext-diff",
    "--date=iso-strict",
    "--format=%x1e%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s",
    "--name-status",
    "--no-renames",
    "--end-of-options",
    commitSha,
  ]);
  return {
    root: repo.root,
    is_git_repo: true,
    sha: commitSha,
    commit: parseRecentChanges(stdout)[0] ?? null,
  };
}

export async function gitRemoteStatus(root: string): Promise<GitRemoteStatusResponse> {
  const repo = await loadRepository(root);
  if (!(await isGitRepo(repo.root))) {
    return emptyRemoteStatus(repo.root, false);
  }

  const branch = await gitOptional(repo.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const upstream = await gitOptional(repo.root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const configuredRemote = branch === undefined ? undefined : await gitOptional(repo.root, ["config", "branch." + branch + ".remote"]);
  const remote = repo.config.runtime?.sync?.remote ?? repo.config.runtime?.git?.remote ?? configuredRemote ?? "origin";
  const remoteUrl = await remoteUrlFor(repo.root, remote);
  const counts = upstream === undefined ? { ahead: 0, behind: 0 } : await aheadBehind(repo.root);
  const changes = parsePorcelainZ(await gitOrEmpty(repo.root, ["status", "--porcelain=v1", "-z"]));
  const conflictPaths = conflictPathsFromGitStatus(changes);
  return {
    root: repo.root,
    is_git_repo: true,
    ...(branch === undefined ? {} : { branch }),
    ...(upstream === undefined ? {} : { upstream }),
    remote,
    ...(remoteUrl === undefined ? {} : { remote_url: remoteUrl }),
    ahead: counts.ahead,
    behind: counts.behind,
    clean: changes.length === 0,
    staged_paths: changes.filter((change) => change.index !== " " && change.index !== "?").map((change) => change.path),
    unstaged_paths: changes.filter((change) => change.working_tree !== " " && change.working_tree !== "?").map((change) => change.path),
    untracked_paths: changes.filter((change) => change.index === "?" && change.working_tree === "?").map((change) => change.path),
    conflict_state: conflictPaths.length > 0 ? "conflicted" : "none",
    conflict_paths: conflictPaths,
    changes,
  };
}

export async function gitPull(root: string, options: GitRemoteSyncOptions = {}): Promise<GitRemoteSyncResponse> {
  const startedAt = Date.now();
  const before = await gitRemoteStatus(root);
  if (!before.is_git_repo) {
    const response = emptySync(root, "pull", "not_git_repo", before);
    writeGitSyncLog("git_sync_skipped", "pull", response.status, startedAt, { remote: response.remote, branch: response.branch });
    return response;
  }
  if (!before.clean) {
    writeGitSyncLog("git_sync_failed", "pull", "dirty_workspace", startedAt, { branch: before.branch, upstream: before.upstream });
    throw new Error("Cannot pull with uncommitted OpenWiki workspace changes; commit or discard them first");
  }
  const target = await resolveRemoteTarget(root, options, before);
  if (!target.remote_url) {
    const response = emptySync(root, "pull", "no_remote", before, target);
    writeGitSyncLog("git_sync_skipped", "pull", response.status, startedAt, { remote: response.remote, branch: response.branch });
    return response;
  }
  writeGitSyncLog("git_sync_started", "pull", "started", startedAt, { remote: target.remote, branch: target.branch });
  try {
    const result = await gitWithOutput(root, ["pull", "--ff-only", "--end-of-options", target.remote, target.branch]);
    const after = await gitRemoteStatus(root);
    const response = {
      root: before.root,
      is_git_repo: true,
      operation: "pull",
      status: "pulled",
      remote: target.remote,
      branch: target.branch,
      remote_url: target.remote_url,
      before,
      after,
      stdout: sanitizeGitOutput(result.stdout),
      stderr: sanitizeGitOutput(result.stderr),
    } satisfies GitRemoteSyncResponse;
    writeGitSyncLog("git_sync_succeeded", "pull", response.status, startedAt, { remote: target.remote, branch: target.branch, ahead: after.ahead, behind: after.behind });
    return response;
  } catch (error) {
    writeGitSyncLog("git_sync_failed", "pull", "error", startedAt, { remote: target.remote, branch: target.branch }, error);
    throw error;
  }
}

export async function gitPush(root: string, options: GitRemoteSyncOptions = {}): Promise<GitRemoteSyncResponse> {
  const startedAt = Date.now();
  const before = await gitRemoteStatus(root);
  if (!before.is_git_repo) {
    const response = emptySync(root, "push", "not_git_repo", before);
    writeGitSyncLog("git_sync_skipped", "push", response.status, startedAt, { remote: response.remote, branch: response.branch });
    return response;
  }
  if (!before.clean) {
    writeGitSyncLog("git_sync_failed", "push", "dirty_workspace", startedAt, { branch: before.branch, upstream: before.upstream });
    throw new Error("Cannot push with uncommitted OpenWiki workspace changes; commit them first");
  }
  const target = await resolveRemoteTarget(root, options, before);
  if (!target.remote_url) {
    const response = emptySync(root, "push", "no_remote", before, target);
    writeGitSyncLog("git_sync_skipped", "push", response.status, startedAt, { remote: response.remote, branch: response.branch });
    return response;
  }
  writeGitSyncLog("git_sync_started", "push", "started", startedAt, { remote: target.remote, branch: target.branch });
  try {
    const result = await gitWithOutput(root, ["push", "--end-of-options", target.remote, "HEAD:" + target.branch]);
    const after = await gitRemoteStatus(root);
    const response = {
      root: before.root,
      is_git_repo: true,
      operation: "push",
      status: "pushed",
      remote: target.remote,
      branch: target.branch,
      remote_url: target.remote_url,
      before,
      after,
      stdout: sanitizeGitOutput(result.stdout),
      stderr: sanitizeGitOutput(result.stderr),
    } satisfies GitRemoteSyncResponse;
    writeGitSyncLog("git_sync_succeeded", "push", response.status, startedAt, { remote: target.remote, branch: target.branch, ahead: after.ahead, behind: after.behind });
    return response;
  } catch (error) {
    writeGitSyncLog("git_sync_failed", "push", "error", startedAt, { remote: target.remote, branch: target.branch }, error);
    throw error;
  }
}

async function resolveRecordTarget(root: string, id: string): Promise<{ root: string; recordId: string; path: string }> {
  const repo = await loadRepository(root);
  const normalizedId = id.startsWith("openwiki://") ? uriToId(id) : id;
  const record =
    repo.pages.find((candidate) => candidate.id === normalizedId || candidate.path === normalizedId) ??
    repo.sources.find((candidate) => candidate.id === normalizedId || candidate.path === normalizedId) ??
    repo.proposals.find((candidate) => candidate.id === normalizedId || candidate.path === normalizedId) ??
    repo.decisions.find((candidate) => candidate.id === normalizedId || candidate.path === normalizedId);
  if (record) {
    return { root: repo.root, recordId: record.id, path: record.path };
  }

  const claim = repo.claims.find((candidate) => candidate.id === normalizedId || candidate.uri === normalizedId);
  if (claim) {
    return { root: repo.root, recordId: claim.id, path: "claims/claim-index.jsonl" };
  }

  return { root: repo.root, recordId: normalizedId, path: normalizedId };
}

function parseCommitLine(line: string): GitCommitEntry | undefined {
  if (!line.trim()) {
    return undefined;
  }
  const [sha, shortSha, authorName, authorEmail, date, subject] = line.split("\x1f");
  if (!sha || !shortSha) {
    return undefined;
  }
  return {
    sha,
    short_sha: shortSha,
    author_name: authorName ?? "",
    author_email: authorEmail ?? "",
    date: date ?? "",
    subject: subject ?? "",
  };
}

function parseRecentChanges(stdout: string): RecentChangeEntry[] {
  return stdout
    .split("\x1e")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const [commitLine = "", ...fileLines] = block.split(/\r?\n/);
      const commit = parseCommitLine(commitLine);
      if (!commit) {
        return undefined;
      }
      return {
        ...commit,
        files: fileLines
          .map((line) => {
            const [status, filePath] = line.split(/\s+/, 2);
            return status && filePath ? { status, path: filePath } : undefined;
          })
          .filter((change): change is GitFileChange => Boolean(change)),
      };
    })
    .filter((change): change is RecentChangeEntry => Boolean(change));
}

function emptyRemoteStatus(root: string, isGitRepo: boolean): GitRemoteStatusResponse {
  return {
    root,
    is_git_repo: isGitRepo,
    ahead: 0,
    behind: 0,
    clean: true,
    staged_paths: [],
    unstaged_paths: [],
    untracked_paths: [],
    conflict_state: "none",
    conflict_paths: [],
    changes: [],
  };
}

function emptySync(
  root: string,
  operation: "pull" | "push",
  status: "not_git_repo" | "no_remote",
  before: GitRemoteStatusResponse,
  target?: { remote: string; branch: string; remote_url?: string },
): GitRemoteSyncResponse {
  return {
    root: before.root || root,
    is_git_repo: before.is_git_repo,
    operation,
    status,
    ...(target?.remote === undefined ? {} : { remote: target.remote }),
    ...(target?.branch === undefined ? {} : { branch: target.branch }),
    ...(target?.remote_url === undefined ? {} : { remote_url: target.remote_url }),
    before,
    stdout: "",
    stderr: "",
  };
}

async function resolveRemoteTarget(
  root: string,
  options: GitRemoteSyncOptions,
  status: GitRemoteStatusResponse,
): Promise<{ remote: string; branch: string; remote_url?: string }> {
  const repo = await loadRepository(root);
  const remote = options.remote ?? repo.config.runtime?.sync?.remote ?? repo.config.runtime?.git?.remote ?? status.remote ?? "origin";
  const branch = options.branch ?? repo.config.runtime?.sync?.branch ?? repo.config.runtime?.git?.branch ?? status.branch ?? "main";
  validateGitRemoteName(remote);
  validateGitBranchName(branch);
  const rawRemoteUrl = await rawRemoteUrlFor(repo.root, remote);
  if (rawRemoteUrl !== undefined) {
    validateSafeGitRemoteUrl(rawRemoteUrl);
  }
  const remoteUrl = rawRemoteUrl === undefined ? undefined : redactRemoteUrl(rawRemoteUrl);
  return {
    remote,
    branch,
    ...(remoteUrl === undefined ? {} : { remote_url: remoteUrl }),
  };
}

async function aheadBehind(root: string): Promise<{ ahead: number; behind: number }> {
  const stdout = await gitOrEmpty(root, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]).catch(() => "");
  const [aheadRaw = "0", behindRaw = "0"] = stdout.trim().split(/\s+/, 2);
  return { ahead: Number(aheadRaw) || 0, behind: Number(behindRaw) || 0 };
}

function parsePorcelainZ(stdout: string): GitStatusEntry[] {
  const entries = stdout.split("\0").filter(Boolean);
  const changes: GitStatusEntry[] = [];
  for (let position = 0; position < entries.length; position += 1) {
    const entry = entries[position] ?? "";
    if (entry.length < 4) {
      continue;
    }
    const index = entry[0] ?? " ";
    const workingTree = entry[1] ?? " ";
    const rawPath = entry.slice(3);
    if ((index === "R" || index === "C") && entries[position + 1] !== undefined) {
      changes.push({ index, working_tree: workingTree, path: rawPath });
      position += 1;
      continue;
    }
    changes.push({ index, working_tree: workingTree, path: rawPath });
  }
  return changes;
}

async function remoteUrlFor(root: string, remote: string): Promise<string | undefined> {
  const value = await rawRemoteUrlFor(root, remote);
  return value === undefined ? undefined : redactRemoteUrl(value);
}

async function rawRemoteUrlFor(root: string, remote: string): Promise<string | undefined> {
  return await gitOptional(root, ["remote", "get-url", remote]);
}

function writeGitSyncLog(
  event: "git_sync_started" | "git_sync_succeeded" | "git_sync_failed" | "git_sync_skipped",
  operation: "pull" | "push",
  status: string,
  startedAt: number,
  metadata: Record<string, unknown>,
  error?: unknown,
): void {
  writeOpenWikiLog({
    event,
    ...(event === "git_sync_failed" ? { level: "error" as const } : {}),
    duration_ms: Date.now() - startedAt,
    metadata: {
      operation,
      status,
      ...metadata,
    },
    ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
  });
}

async function diffRange(root: string, input: GitDiffRequest): Promise<string[]> {
  if (input.from && input.to) {
    return [
      await resolveGitCommit(root, input.from, "from"),
      await resolveGitCommit(root, input.to, "to"),
    ];
  }
  if (input.from) {
    return [await resolveGitCommit(root, input.from, "from")];
  }
  if (input.to) {
    const to = normalizeGitRevisionInput(input.to, "to");
    return [
      await resolveGitCommit(root, `${to}^`, "to parent"),
      await resolveGitCommit(root, to, "to"),
    ];
  }
  return [];
}

async function resolveGitCommit(root: string, revision: string, label: string): Promise<string> {
  const normalized = normalizeGitRevisionInput(revision, label);
  try {
    return (await git(root, ["rev-parse", "--verify", "--end-of-options", `${normalized}^{commit}`])).trim();
  } catch {
    throw new InvalidGitRevisionError(`Invalid Git ${label} revision`);
  }
}

function normalizeGitRevisionInput(revision: string, label: string): string {
  const normalized = revision.trim();
  if (!normalized) {
    throw new InvalidGitRevisionError(`Expected Git ${label} revision`);
  }
  if (normalized.startsWith("-")) {
    throw new InvalidGitRevisionError(`Invalid Git ${label} revision`);
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new InvalidGitRevisionError(`Invalid Git ${label} revision`);
  }
  return normalized;
}

function normalizeGitPathSpec(repoPath: string): string {
  const normalized = repoPath.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error("Invalid Git path");
  }
  return normalized;
}

function emptyDiff(
  target: { root: string; recordId: string; path: string },
  input: GitDiffRequest,
  isGitRepo: boolean,
): GitDiffResponse {
  return {
    root: target.root,
    record_id: target.recordId,
    path: target.path,
    is_git_repo: isGitRepo,
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to }),
    diff: "",
  };
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    const stdout = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

async function gitOrEmpty(root: string, args: string[]): Promise<string> {
  try {
    return await git(root, args);
  } catch (error) {
    if (isNoCommitHistoryError(error)) {
      return "";
    }
    throw error;
  }
}

function isNoCommitHistoryError(error: unknown): boolean {
  const asError = error as { message?: string; stderr?: string };
  const text = `${asError.message ?? ""}\n${asError.stderr ?? ""}`;
  return text.includes("does not have any commits yet") || text.includes("unknown revision or path not in the working tree");
}
