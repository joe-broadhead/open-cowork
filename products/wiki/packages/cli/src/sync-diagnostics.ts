import type {
  GitRemoteReachabilityResponse,
  GitRemoteStatusResponse,
  GitSyncState,
} from "@openwiki/git";

export type SyncDiagnosticState =
  | "clean"
  | "ahead"
  | "behind"
  | "diverged"
  | "dirty-workspace"
  | "conflicted"
  | "auth-failed"
  | "network-failed"
  | "remote-branch-missing"
  | "not-configured"
  | "not-git-repo"
  | "failed";

type SyncDiagnosticSeverity = "ok" | "warn" | "fail";
export type SyncRemoteProvider = "github" | "gitlab" | "self-hosted" | "local" | "generic";

export interface SyncDiagnostic {
  state: SyncDiagnosticState;
  severity: SyncDiagnosticSeverity;
  provider: SyncRemoteProvider;
  summary: string;
  recommended_action: string;
  commands: string[];
}

export function syncFailureStatus(message: string): string {
  const normalized = message.toLowerCase();
  if (/authentication failed|could not read username|permission denied|access denied|authorization failed|repository not found/.test(normalized)) {
    return "auth-failed";
  }
  if (/timed out|timeout|could not resolve host|failed to connect|connection refused|connection timed out|network is unreachable|no route to host|operation timed out/.test(normalized)) {
    return "network-failed";
  }
  return "failed";
}

export function syncDiagnosticFromStatus(status: GitRemoteStatusResponse, state: GitSyncState): SyncDiagnostic {
  const provider = providerForRemoteUrl(status.remote_url);
  if (!status.is_git_repo) {
    return syncDiagnostic("not-git-repo", provider);
  }
  if (status.conflict_state === "conflicted") {
    return syncDiagnostic("conflicted", provider);
  }
  if (!status.clean) {
    return syncDiagnostic("dirty-workspace", provider);
  }
  if (status.remote_url === undefined) {
    return syncDiagnostic("not-configured", provider);
  }
  const failureState = recentFailureState(state);
  if (failureState !== undefined) {
    return syncDiagnostic(failureState, provider);
  }
  if (status.ahead > 0 && status.behind > 0) {
    return syncDiagnostic("diverged", provider);
  }
  if (status.behind > 0) {
    return syncDiagnostic("behind", provider);
  }
  if (status.ahead > 0) {
    return syncDiagnostic("ahead", provider);
  }
  return syncDiagnostic("clean", provider);
}

export function syncDiagnosticFromRemoteCheck(check: GitRemoteReachabilityResponse): SyncDiagnostic {
  const provider = providerForRemoteUrl(check.remote_url);
  if (check.status === "reachable") {
    return syncDiagnostic("clean", provider, "Remote is reachable and the configured branch exists.");
  }
  if (check.status === "missing_branch") {
    return syncDiagnostic("remote-branch-missing", provider);
  }
  if (check.status === "not_git_repo") {
    return syncDiagnostic("not-git-repo", provider);
  }
  if (check.status === "no_remote") {
    return syncDiagnostic("not-configured", provider);
  }
  if (check.status === "auth_failed") {
    return syncDiagnostic("auth-failed", provider);
  }
  if (check.status === "network_failed") {
    return syncDiagnostic("network-failed", provider);
  }
  return syncDiagnostic("failed", provider, check.error ?? "Remote check failed.");
}

function recentFailureState(state: GitSyncState): SyncDiagnosticState | undefined {
  const failure = state.last_failure;
  if (failure === undefined) {
    return undefined;
  }
  const successAt = state.last_success === undefined ? 0 : Date.parse(state.last_success.occurred_at);
  const failureAt = Date.parse(failure.occurred_at);
  if (Number.isFinite(successAt) && Number.isFinite(failureAt) && failureAt <= successAt) {
    return undefined;
  }
  if (failure.status === "auth-failed" || failure.status === "auth_failed") {
    return "auth-failed";
  }
  if (failure.status === "network-failed" || failure.status === "network_failed") {
    return "network-failed";
  }
  return undefined;
}

function syncDiagnostic(state: SyncDiagnosticState, provider: SyncRemoteProvider, overrideSummary?: string): SyncDiagnostic {
  const spec = syncDiagnosticSpec(state);
  return {
    state,
    provider,
    severity: spec.severity,
    summary: overrideSummary ?? spec.summary,
    recommended_action: spec.recommended_action,
    commands: spec.commands,
  };
}

function syncDiagnosticSpec(state: SyncDiagnosticState): Omit<SyncDiagnostic, "state" | "provider"> {
  if (state === "clean") {
    return {
      severity: "ok",
      summary: "Workspace and configured Git sync state are clean.",
      recommended_action: "No recovery action is required.",
      commands: ["openwiki sync status --json"],
    };
  }
  if (state === "ahead") {
    return {
      severity: "warn",
      summary: "Local Git history is ahead of the configured upstream.",
      recommended_action: "Push local commits after confirming the remote target is correct.",
      commands: ["openwiki sync check-remote --json", "openwiki sync now --push"],
    };
  }
  if (state === "behind") {
    return {
      severity: "warn",
      summary: "Remote Git history has commits that are not present locally.",
      recommended_action: "Fast-forward pull before making more local edits.",
      commands: ["openwiki sync check-remote --json", "openwiki sync now --pull"],
    };
  }
  if (state === "diverged") {
    return {
      severity: "fail",
      summary: "Local and remote Git histories have both moved.",
      recommended_action: "Inspect the branch manually; OpenWiki will not merge or overwrite divergent history automatically.",
      commands: ["git status", "git log --oneline --graph --decorate --all", "openwiki sync explain-conflict --json"],
    };
  }
  if (state === "dirty-workspace") {
    return {
      severity: "fail",
      summary: "Workspace has uncommitted local changes.",
      recommended_action: "Commit OpenWiki-managed changes with an explicit message or move unrelated files before syncing.",
      commands: ["openwiki sync now --message \"Sync local wiki edits\"", "git status"],
    };
  }
  if (state === "conflicted") {
    return {
      severity: "fail",
      summary: "Git reports unresolved conflict paths.",
      recommended_action: "Resolve the files manually, commit the resolution, then push or pull again.",
      commands: ["git status", "git add <resolved-path>", "git commit -m \"Resolve wiki sync conflict\"", "openwiki sync now --push"],
    };
  }
  if (state === "auth-failed") {
    return {
      severity: "fail",
      summary: "Git remote authentication or authorization failed.",
      recommended_action: "Fix SSH keys, deploy keys, or credential-helper credentials; do not put tokens in the remote URL.",
      commands: ["openwiki sync check-remote --json", "git remote -v"],
    };
  }
  if (state === "network-failed") {
    return {
      severity: "fail",
      summary: "Git remote network reachability failed.",
      recommended_action: "Check DNS, firewall, proxy, VPN, and provider availability, then retry the remote check.",
      commands: ["openwiki sync check-remote --json"],
    };
  }
  if (state === "remote-branch-missing") {
    return {
      severity: "warn",
      summary: "Remote is reachable, but the configured branch does not exist yet.",
      recommended_action: "If this is the initial sync, push the workspace branch explicitly.",
      commands: ["openwiki sync now --push --message \"Initial private wiki sync\""],
    };
  }
  if (state === "not-configured") {
    return {
      severity: "fail",
      summary: "No Git remote URL is configured for sync.",
      recommended_action: "Connect a private Git remote before enabling scheduled sync.",
      commands: ["openwiki sync connect git --remote-url <url> --branch main"],
    };
  }
  if (state === "not-git-repo") {
    return {
      severity: "fail",
      summary: "Workspace is not initialized as a Git repository.",
      recommended_action: "Connect Git sync or initialize Git before relying on sync automation.",
      commands: ["openwiki sync connect git --remote-url <url> --branch main"],
    };
  }
  return {
    severity: "fail",
    summary: "Git sync failed for an unclassified reason.",
    recommended_action: "Inspect the last failure and run a remote check before retrying.",
    commands: ["openwiki sync status --json", "openwiki sync check-remote --json"],
  };
}

function providerForRemoteUrl(remoteUrl: string | undefined): SyncRemoteProvider {
  if (remoteUrl === undefined) {
    return "generic";
  }
  if (remoteUrl.startsWith("/") || remoteUrl.startsWith("./") || remoteUrl.startsWith("../")) {
    return "local";
  }
  const host = remoteHost(remoteUrl);
  if (host === undefined) {
    return "generic";
  }
  if (host === "github.com" || host.endsWith(".github.com")) {
    return "github";
  }
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) {
    return "gitlab";
  }
  return "self-hosted";
}

function remoteHost(remoteUrl: string): string | undefined {
  try {
    return new URL(remoteUrl).hostname.toLowerCase();
  } catch {
    const scpLike = /^(?:[^@]+@)?([^:]+):.+$/.exec(remoteUrl);
    return scpLike?.[1]?.toLowerCase();
  }
}
