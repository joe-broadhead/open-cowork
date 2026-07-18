import { loadRepository } from "@openwiki/repo";
import { git, gitOptional, gitWithOutput } from "./process.ts";
import { redactRemoteUrl, sanitizeGitOutput, validateGitBranchName, validateGitRemoteName, validateSafeGitRemoteUrl } from "./validation.ts";

export type GitRemoteReachabilityStatus =
  | "reachable"
  | "missing_branch"
  | "not_git_repo"
  | "no_remote"
  | "auth_failed"
  | "network_failed"
  | "failed";

export interface GitRemoteReachabilityResponse {
  root: string;
  is_git_repo: boolean;
  status: GitRemoteReachabilityStatus;
  remote?: string;
  branch?: string;
  remote_url?: string;
  stdout: string;
  stderr: string;
  error?: string;
  timeout_ms: number;
}

interface GitRemoteReachabilityOptions {
  remote?: string;
  branch?: string;
  timeout_ms?: number;
}

export async function gitRemoteReachability(root: string, options: GitRemoteReachabilityOptions = {}): Promise<GitRemoteReachabilityResponse> {
  const repo = await loadRepository(root);
  const timeoutMs = options.timeout_ms ?? 10_000;
  if (!(await isGitRepo(repo.root))) {
    return emptyReachability(repo.root, "not_git_repo", timeoutMs, false);
  }
  const target = await resolveRemoteTarget(repo.root, options);
  if (target.remote_url === undefined) {
    return emptyReachability(repo.root, "no_remote", timeoutMs, true, target);
  }
  try {
    const result = await gitWithOutput(repo.root, ["ls-remote", "--heads", target.remote, target.branch], { timeoutMs, env: { GIT_ASKPASS: "/usr/bin/true" } });
    const stdout = sanitizeGitOutput(result.stdout);
    return {
      root: repo.root,
      is_git_repo: true,
      status: stdout.trim().length === 0 ? "missing_branch" : "reachable",
      remote: target.remote,
      branch: target.branch,
      remote_url: target.remote_url,
      stdout,
      stderr: sanitizeGitOutput(result.stderr),
      timeout_ms: timeoutMs,
    };
  } catch (error) {
    const text = errorText(error);
    return {
      root: repo.root,
      is_git_repo: true,
      status: classifyGitRemoteError(error, text),
      remote: target.remote,
      branch: target.branch,
      remote_url: target.remote_url,
      stdout: "",
      stderr: sanitizeGitOutput(text),
      error: sanitizeGitOutput(text),
      timeout_ms: timeoutMs,
    };
  }
}

async function resolveRemoteTarget(
  root: string,
  options: GitRemoteReachabilityOptions,
): Promise<{ remote: string; branch: string; remote_url?: string }> {
  const repo = await loadRepository(root);
  const currentBranch = await gitOptional(repo.root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const configuredRemote = currentBranch === undefined ? undefined : await gitOptional(repo.root, ["config", "branch." + currentBranch + ".remote"]);
  const remote = options.remote ?? repo.config.runtime?.sync?.remote ?? repo.config.runtime?.git?.remote ?? configuredRemote ?? "origin";
  const branch = options.branch ?? repo.config.runtime?.sync?.branch ?? repo.config.runtime?.git?.branch ?? currentBranch ?? "main";
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

async function rawRemoteUrlFor(root: string, remote: string): Promise<string | undefined> {
  return await gitOptional(root, ["remote", "get-url", remote]);
}

async function isGitRepo(root: string): Promise<boolean> {
  try {
    const stdout = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function emptyReachability(
  root: string,
  status: GitRemoteReachabilityStatus,
  timeoutMs: number,
  isGitRepo: boolean,
  target?: { remote: string; branch: string; remote_url?: string },
): GitRemoteReachabilityResponse {
  return {
    root,
    is_git_repo: isGitRepo,
    status,
    ...(target?.remote === undefined ? {} : { remote: target.remote }),
    ...(target?.branch === undefined ? {} : { branch: target.branch }),
    ...(target?.remote_url === undefined ? {} : { remote_url: target.remote_url }),
    stdout: "",
    stderr: "",
    timeout_ms: timeoutMs,
  };
}

function errorText(error: unknown): string {
  const record = error as { killed?: unknown; message?: unknown; stderr?: unknown; stdout?: unknown; signal?: unknown; code?: unknown };
  return [
    typeof record.message === "string" ? record.message : "",
    typeof record.stderr === "string" ? record.stderr : "",
    typeof record.stdout === "string" ? record.stdout : "",
    record.killed === true ? "killed=true" : "",
    typeof record.signal === "string" ? record.signal : "",
    typeof record.code === "string" || typeof record.code === "number" ? `code=${record.code}` : "",
  ].filter(Boolean).join("\n");
}

function classifyGitRemoteError(error: unknown, text: string): GitRemoteReachabilityStatus {
  if (/authentication failed|could not read username|permission denied|access denied|authorization failed|repository not found/i.test(text)) {
    return "auth_failed";
  }
  if (isTimedOutGitError(error, text)) {
    return "network_failed";
  }
  if (/timed out|timeout|could not resolve host|failed to connect|connection refused|connection timed out|network is unreachable|no route to host|operation timed out/i.test(text)) {
    return "network_failed";
  }
  return "failed";
}

function isTimedOutGitError(error: unknown, text: string): boolean {
  const record = error as { killed?: unknown; signal?: unknown; code?: unknown };
  return (
    record.killed === true ||
    record.signal === "SIGTERM" ||
    record.code === "ETIMEDOUT" ||
    /timed out|timeout/i.test(text)
  );
}
