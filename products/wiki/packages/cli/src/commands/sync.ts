import path from "node:path";
import { atomicWriteFile, isoNow, type OpenWikiConfig, type OpenWikiSyncConfig } from "@openwiki/core";
import {
  configureGitRemote,
  gitPull,
  gitPush,
  gitRemoteReachability,
  gitRemoteStatus,
  readGitSyncState,
  writeGitSyncState,
  type GitRemoteStatusResponse,
  type GitRemoteSyncResponse,
  type GitSyncConflictState,
  type GitSyncState,
  type GitSyncStateEntry,
} from "@openwiki/git";
import { appendEvent, loadRepository } from "@openwiki/repo";
import { commitChanges, withWriteCoordination, type CommitChangesResult } from "@openwiki/workflows";
import type { CliOptions } from "../args.ts";
import { printJson } from "../output.ts";
import {
  syncDiagnosticFromRemoteCheck,
  syncDiagnosticFromStatus,
  syncFailureStatus,
} from "../sync-diagnostics.ts";
import { resolveRoot } from "../utils.ts";
import { printSyncDiagnostic, printSyncStatus } from "./sync-output.ts";
import type { ConnectGitSyncInput, ConnectGitSyncResult, SyncNowResult, SyncRemoteCheckResult, SyncStatusResult } from "./sync-types.ts";
import { parseAutomationIntervalSeconds, runForegroundWatcher } from "./watch.ts";

export async function syncCommand(args: string[], options: CliOptions): Promise<void> {
  const [subcommand, provider] = args;
  if (subcommand === "status") {
    await syncStatusCommand(options);
    return;
  }
  if (subcommand === "check-remote") {
    await syncCheckRemoteCommand(options);
    return;
  }
  if (subcommand === "explain-conflict") {
    await syncExplainConflictCommand(options);
    return;
  }
  if (subcommand === "connect") {
    await syncConnectCommand(provider, options);
    return;
  }
  if (subcommand === "now") {
    await syncNowCommand(options);
    return;
  }
  if (subcommand === "watch") {
    await syncWatchCommand(options);
    return;
  }
  if (subcommand === "enable") {
    await syncEnableCommand(options);
    return;
  }
  if (subcommand === "disable") {
    await syncDisableCommand(options);
    return;
  }
  if (subcommand === "repair") {
    await syncRepairCommand(options);
    return;
  }
  throw new Error(syncUsage());
}

async function syncStatusCommand(options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const result = await readSyncStatus(root);
  if (options.json) {
    printJson(result);
    return;
  }
  printSyncStatus(result);
}

async function syncCheckRemoteCommand(options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const remoteCheck = await gitRemoteReachability(root, {
    ...gitTargetOptions(options),
    ...(options.timeoutMs === undefined ? {} : { timeout_ms: options.timeoutMs }),
  });
  const result: SyncRemoteCheckResult = {
    root,
    remote_check: remoteCheck,
    diagnostic: syncDiagnosticFromRemoteCheck(remoteCheck),
  };
  if (options.json) {
    printJson(result);
  } else {
    printSyncDiagnostic(result.diagnostic);
  }
  if (!["reachable", "missing_branch"].includes(remoteCheck.status)) {
    process.exitCode = 1;
  }
}

async function syncExplainConflictCommand(options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const result = await readSyncStatus(root);
  if (options.json) {
    printJson({
      root,
      diagnostic: result.diagnostic,
      conflict_paths: result.conflict_paths,
      state: result.state,
    });
  } else {
    printSyncDiagnostic(result.diagnostic);
    for (const conflictPath of result.conflict_paths) {
      console.log(`conflict ${conflictPath}`);
    }
  }
  if (result.diagnostic.severity === "fail") {
    process.exitCode = 1;
  }
}

async function syncConnectCommand(provider: string | undefined, options: CliOptions): Promise<void> {
  if (provider !== "git" || options.gitRemoteUrl === undefined) {
    throw new Error("Usage: openwiki [--root <path>] sync connect git --remote-url <url> --branch main [--remote origin] [--json]");
  }
  const root = await resolveRoot(options);
  const result = await connectGitSync({
    root,
    remoteUrl: options.gitRemoteUrl,
    ...(options.gitRemote === undefined ? {} : { remote: options.gitRemote }),
    ...(options.gitBranch === undefined ? {} : { branch: options.gitBranch }),
    ...(options.credentialRef === undefined ? {} : { credentialRef: options.credentialRef }),
    ...(options.actor === undefined ? {} : { actorId: options.actor }),
  });
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`connected ${result.remote} ${result.branch}${result.remote_url === undefined ? "" : ` ${result.remote_url}`}`);
}

export async function connectGitSync(input: ConnectGitSyncInput): Promise<Awaited<ReturnType<typeof configureGitRemote>> & {
  sync: OpenWikiSyncConfig | undefined;
  state: GitSyncState;
} & ConnectGitSyncResult> {
  const remote = input.remote ?? "origin";
  const branch = input.branch ?? "main";
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.git_sync_connect",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: { remote, branch },
    },
    async () => {
      const configured = await configureGitRemote(input.root, {
        remote,
        branch,
        remote_url: input.remoteUrl,
        ...(input.credentialRef === undefined ? {} : { credential_ref: input.credentialRef }),
      });
      const config = await updateSyncConfig(input.root, (current) => ({
        ...current,
        remote,
        branch,
        mode: current.mode ?? "manual",
        pull_on_start: current.pull_on_start ?? false,
        push_after_commit: current.push_after_commit ?? false,
        conflict_policy: "stop",
      }));
      const state = await recordSyncSuccess(input.root, {
        operation: "connect",
        status: "connected",
        occurred_at: isoNow(),
        remote,
        branch,
      });
      await appendSyncEvent(input.root, {
        ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
        operation: "wiki.git_sync_connect",
        type: "git.sync_configured",
        data: { remote, branch, mode: config.runtime?.sync?.mode ?? "manual" },
      });
      return { ...configured, sync: config.runtime?.sync, state };
    },
  );
}

async function syncNowCommand(options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const result = await syncNowWithCoordination(root, options);
  if (options.json) {
    printJson(result);
  } else if (result.status === "synced") {
    console.log(`synced ${result.operations.join("+") || "status"}`);
    if (result.committed?.committed === true) {
      console.log(`committed ${result.committed.short_sha}`);
    }
    if (result.pull !== undefined) {
      console.log(`pull ${result.pull.status}`);
    }
    if (result.push !== undefined) {
      console.log(`push ${result.push.status}`);
    }
  } else {
    console.log(`sync failed: ${result.error ?? "unknown error"}`);
    for (const line of result.recovery ?? []) {
      console.log("- " + line);
    }
  }
  if (result.status === "failed") {
    process.exitCode = 1;
  }
}

async function syncWatchCommand(options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const repo = await loadRepository(root);
  const configuredSync = repo.config.runtime?.sync;
  const everySeconds = options.every === undefined
    ? configuredSync?.interval_seconds
    : parseAutomationIntervalSeconds(options.every);
  if (everySeconds === undefined) {
    throw new Error("Usage: openwiki [--root <path>] sync watch --every 15m [--pull] [--push] [--once] [--json]");
  }
  const targetRemote = options.gitRemote ?? configuredSync?.remote ?? repo.config.runtime?.git?.remote;
  const targetBranch = options.gitBranch ?? configuredSync?.branch ?? repo.config.runtime?.git?.branch;
  const explicitOperations = options.syncPull || options.syncPush;
  const watchOptions: CliOptions = {
    ...options,
    syncPull: explicitOperations ? options.syncPull : true,
    syncPush: explicitOperations ? options.syncPush : configuredSync?.push_after_commit === true,
    ...(targetRemote === undefined ? {} : { gitRemote: targetRemote }),
    ...(targetBranch === undefined ? {} : { gitBranch: targetBranch }),
  };
  const result = await runForegroundWatcher({
    root,
    kind: "sync",
    everySeconds,
    once: options.once,
    initialJitterSeconds: serviceInitialJitterSeconds(everySeconds),
    ...(options.json ? {} : { log: (message: string) => console.log(message) }),
    async runOnce() {
      const syncResult = await syncNowWithCoordination(root, watchOptions, "wiki.git_sync_watch");
      if (syncResult.status === "failed") {
        throw new Error(syncResult.error ?? "sync failed");
      }
      return {
        status: "success",
        message: `synced ${syncResult.operations.join("+") || "status"}`,
        details: { operations: syncResult.operations },
      };
    },
  });
  if (options.json) {
    printJson(result);
  }
  if (options.once && result.runs.some((run) => run.status === "failed")) {
    process.exitCode = 1;
  }
}

function serviceInitialJitterSeconds(everySeconds: number): number {
  return process.env.OPENWIKI_AUTOMATION_SERVICE === "1" ? Math.max(1, Math.min(300, Math.floor(everySeconds * 0.1))) : 0;
}

async function syncEnableCommand(options: CliOptions): Promise<void> {
  if (options.every === undefined) {
    throw new Error("Usage: openwiki [--root <path>] sync enable --every 15m [--pull-on-start] [--push-after-commit] [--json]");
  }
  const root = await resolveRoot(options);
  const intervalSeconds = parseSyncIntervalSeconds(options.every);
  const result = await withWriteCoordination(
    {
      root,
      operation: "wiki.git_sync_enable",
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      metadata: { interval_seconds: intervalSeconds },
    },
    async () => {
      const repo = await loadRepository(root);
      const existing = repo.config.runtime?.sync;
      const remote = options.gitRemote ?? existing?.remote ?? repo.config.runtime?.git?.remote ?? "origin";
      const branch = options.gitBranch ?? existing?.branch ?? repo.config.runtime?.git?.branch ?? "main";
      const config = await updateSyncConfig(root, (current) => ({
        ...current,
        remote,
        branch,
        mode: "auto",
        pull_on_start: options.pullOnStart || current.pull_on_start === true,
        push_after_commit: options.pushAfterCommit || current.push_after_commit === true,
        interval_seconds: intervalSeconds,
        conflict_policy: "stop",
      }));
      const state = await recordSyncSuccess(root, {
        operation: "enable",
        status: "enabled",
        occurred_at: isoNow(),
        remote,
        branch,
      });
      await appendSyncEvent(root, {
        ...(options.actor === undefined ? {} : { actorId: options.actor }),
        operation: "wiki.git_sync_enable",
        type: "git.sync_enabled",
        data: { remote, branch, interval_seconds: intervalSeconds },
      });
      return { root, sync: config.runtime?.sync, state };
    },
  );
  if (options.json) {
    printJson(result);
    return;
  }
  console.log(`enabled auto sync every ${result.sync?.interval_seconds ?? intervalSeconds}s`);
}

async function syncDisableCommand(options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const result = await withWriteCoordination(
    {
      root,
      operation: "wiki.git_sync_disable",
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      metadata: {},
    },
    async () => {
      const config = await updateSyncConfig(root, (current) => ({
        ...current,
        mode: "manual",
        pull_on_start: false,
        push_after_commit: false,
        conflict_policy: "stop",
      }));
      const state = await recordSyncSuccess(root, {
        operation: "disable",
        status: "disabled",
        occurred_at: isoNow(),
        ...(config.runtime?.sync?.remote === undefined ? {} : { remote: config.runtime.sync.remote }),
        ...(config.runtime?.sync?.branch === undefined ? {} : { branch: config.runtime.sync.branch }),
      });
      await appendSyncEvent(root, {
        ...(options.actor === undefined ? {} : { actorId: options.actor }),
        operation: "wiki.git_sync_disable",
        type: "git.sync_disabled",
        data: { remote: config.runtime?.sync?.remote, branch: config.runtime?.sync?.branch },
      });
      return { root, sync: config.runtime?.sync, state };
    },
  );
  if (options.json) {
    printJson(result);
    return;
  }
  console.log("disabled auto sync");
}

async function syncRepairCommand(options: CliOptions): Promise<void> {
  const root = await resolveRoot(options);
  const status = await gitRemoteStatus(root);
  const state = await readGitSyncState(root);
  const conflict = conflictStateFromStatus(status);
  const diagnostic = syncDiagnosticFromStatus(status, state);
  const result = {
    root,
    status: conflict.has_conflicts ? "manual_intervention_required" : status.clean ? "clean" : "dirty_workspace",
    git: status,
    state,
    conflict,
    diagnostic,
    recovery: diagnostic.commands,
  };
  if (options.json) {
    printJson(result);
  } else {
    console.log(result.status);
    for (const line of result.recovery) {
      console.log("- " + line);
    }
  }
  if (result.status !== "clean") {
    process.exitCode = 1;
  }
}

async function syncNowUnlocked(root: string, options: CliOptions): Promise<SyncNowResult> {
  const before = await gitRemoteStatus(root);
  const operations = syncOperations(options);
  let committed: CommitChangesResult | undefined;
  try {
    if (!before.clean && options.message === undefined) {
      return await syncFailure(root, before, "Workspace has uncommitted changes; rerun with --message to commit OpenWiki-managed paths first.", options);
    }

    if (!before.clean && options.message !== undefined) {
      committed = await commitChanges({
        root,
        message: options.message,
        ...(options.actor === undefined ? {} : { actorId: options.actor }),
        all: true,
      });
      const afterCommit = await gitRemoteStatus(root);
      if (!afterCommit.clean) {
        return await syncFailure(root, afterCommit, "Workspace still has uncommitted changes after committing OpenWiki-managed paths.", options);
      }
    }

    let pull: GitRemoteSyncResponse | undefined;
    let push: GitRemoteSyncResponse | undefined;
    if (operations.includes("pull")) {
      pull = await gitPull(root, gitTargetOptions(options));
    }
    if (operations.includes("push")) {
      push = await gitPush(root, gitTargetOptions(options));
    }
    const after = await gitRemoteStatus(root);
    const skipped = [pull, push].find((response) => response?.status === "no_remote" || response?.status === "not_git_repo");
    if (skipped !== undefined) {
      return await syncFailure(root, after, `Sync ${skipped.operation} skipped: ${skipped.status}.`, options);
    }
    const state = await recordSyncSuccess(root, {
      operation: "sync",
      status: "synced",
      occurred_at: isoNow(),
      message: operations.join("+"),
      ...(after.remote === undefined ? {} : { remote: after.remote }),
      ...(after.branch === undefined ? {} : { branch: after.branch }),
    });
    return {
      root,
      status: "synced",
      operations,
      ...(committed === undefined ? {} : { committed }),
      ...(pull === undefined ? {} : { pull }),
      ...(push === undefined ? {} : { push }),
      before,
      after,
      state,
    };
  } catch (error) {
    return syncFailure(root, before, error instanceof Error ? error.message : String(error), options);
  }
}

async function syncNowWithCoordination(
  root: string,
  options: CliOptions,
  operation = "wiki.git_sync_now",
): Promise<SyncNowResult> {
  return withWriteCoordination(
    {
      root,
      operation,
      ...(options.actor === undefined ? {} : { actorId: options.actor }),
      metadata: {
        pull: options.syncPull,
        push: options.syncPush,
        commit: options.message !== undefined,
      },
    },
    () => syncNowUnlocked(root, options),
  );
}

async function syncFailure(root: string, before: GitRemoteStatusResponse, message: string, options?: CliOptions): Promise<SyncNowResult> {
  const after = await gitRemoteStatus(root).catch(() => before);
  const conflict = conflictStateFromStatus(after);
  const failureRemote = after.remote ?? before.remote;
  const failureBranch = after.branch ?? before.branch;
  const failureStatus = conflict.has_conflicts ? "conflict" : syncFailureStatus(message);
  const state = await recordSyncFailure(root, {
    operation: "sync",
    status: failureStatus,
    occurred_at: isoNow(),
    error: message,
    ...(failureRemote === undefined ? {} : { remote: failureRemote }),
    ...(failureBranch === undefined ? {} : { branch: failureBranch }),
  }, conflict);
  if (conflict.has_conflicts) {
    await appendSyncEvent(root, {
      ...(options?.actor === undefined ? {} : { actorId: options.actor }),
      operation: "wiki.git_sync_now",
      type: "git.sync_conflict",
      data: { message, conflict_paths: conflict.paths, remote: after.remote, branch: after.branch },
    });
  }
  return {
    root,
    status: "failed",
    operations: syncOperations(options ?? defaultSyncOptions()),
    before,
    after,
    state,
    conflict,
    error: message,
    recovery: syncDiagnosticFromStatus(after, state).commands,
  };
}

async function readSyncStatus(root: string): Promise<SyncStatusResult> {
  const repo = await loadRepository(root);
  const git = await gitRemoteStatus(repo.root);
  const state = await readGitSyncState(repo.root);
  const sync = repo.config.runtime?.sync;
  const syncRemote = sync?.remote ?? git.remote ?? repo.config.runtime?.git?.remote;
  const syncBranch = sync?.branch ?? git.branch ?? repo.config.runtime?.git?.branch;
  const diagnostic = syncDiagnosticFromStatus(git, state);
  return {
    root: repo.root,
    is_git_repo: git.is_git_repo,
    ...(git.branch === undefined ? {} : { branch: git.branch }),
    ...(git.upstream === undefined ? {} : { upstream: git.upstream }),
    ...(git.remote === undefined ? {} : { remote: git.remote }),
    ...(git.remote_url === undefined ? {} : { remote_url: git.remote_url }),
    ahead: git.ahead,
    behind: git.behind,
    clean: git.clean,
    dirty_state: git.clean ? "clean" : "dirty",
    conflict_state: git.conflict_state,
    conflict_paths: git.conflict_paths,
    sync_state: diagnostic.state,
    provider: diagnostic.provider,
    diagnostic,
    sync: {
      mode: sync?.mode ?? "manual",
      ...(syncRemote === undefined ? {} : { remote: syncRemote }),
      ...(syncBranch === undefined ? {} : { branch: syncBranch }),
      pull_on_start: sync?.pull_on_start ?? false,
      push_after_commit: sync?.push_after_commit ?? false,
      ...(sync?.interval_seconds === undefined ? {} : { interval_seconds: sync.interval_seconds }),
      conflict_policy: sync?.conflict_policy ?? "stop",
    },
    state,
  };
}

async function updateSyncConfig(root: string, updater: (current: OpenWikiSyncConfig) => OpenWikiSyncConfig): Promise<OpenWikiConfig> {
  const repo = await loadRepository(root);
  const nextConfig: OpenWikiConfig = {
    ...repo.config,
    runtime: {
      ...(repo.config.runtime ?? {}),
      sync: updater(repo.config.runtime?.sync ?? {}),
    },
  };
  await atomicWriteFile(path.join(repo.root, "openwiki.json"), `${JSON.stringify(nextConfig, null, 2)}\n`);
  return nextConfig;
}

async function recordSyncSuccess(root: string, entry: GitSyncStateEntry): Promise<GitSyncState> {
  const previous = await readGitSyncState(root);
  const state: GitSyncState = {
    ...previous,
    updated_at: isoNow(),
    last_success: entry,
    conflict: { has_conflicts: false, paths: [] },
  };
  await writeGitSyncState(root, state);
  return state;
}

async function recordSyncFailure(root: string, entry: GitSyncStateEntry, conflict: GitSyncConflictState): Promise<GitSyncState> {
  const previous = await readGitSyncState(root);
  const state: GitSyncState = {
    ...previous,
    updated_at: isoNow(),
    last_failure: entry,
    conflict,
  };
  await writeGitSyncState(root, state);
  return state;
}

async function appendSyncEvent(root: string, input: {
  type: string;
  operation: string;
  actorId?: string;
  data: Record<string, unknown>;
}): Promise<void> {
  await appendEvent(root, {
    type: input.type,
    operation: input.operation,
    actor_id: input.actorId ?? "actor:user:local",
    record_type: "workspace",
    data: input.data,
    sensitivity: "internal",
  });
}

function syncOperations(options: CliOptions): Array<"pull" | "push"> {
  if (options.syncPull || options.syncPush) {
    return [
      ...(options.syncPull ? ["pull" as const] : []),
      ...(options.syncPush ? ["push" as const] : []),
    ];
  }
  return ["pull", "push"];
}

function gitTargetOptions(options: CliOptions): { remote?: string; branch?: string } {
  return {
    ...(options.gitRemote === undefined ? {} : { remote: options.gitRemote }),
    ...(options.gitBranch === undefined ? {} : { branch: options.gitBranch }),
  };
}

function conflictStateFromStatus(status: GitRemoteStatusResponse): GitSyncConflictState {
  if (status.conflict_paths.length === 0) {
    return { has_conflicts: false, paths: [] };
  }
  return {
    has_conflicts: true,
    paths: status.conflict_paths,
    occurred_at: isoNow(),
    message: "Git reports unresolved conflict paths.",
  };
}

function parseSyncIntervalSeconds(value: string): number {
  const match = /^([1-9][0-9]*)([smhd]?)$/.exec(value.trim());
  if (match === null) {
    throw new Error("--every must be a duration such as 15m, 1h, or 900s");
  }
  const amount = Number(match[1]);
  const unit = match[2] || "s";
  const multiplier = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  const seconds = amount * multiplier;
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 604800) {
    throw new Error("--every must be between 60s and 7d");
  }
  return seconds;
}

function defaultSyncOptions(): CliOptions {
  return {
    json: false,
    explain: false,
    highlights: false,
    fuzzy: false,
    commit: false,
    commitAll: false,
    commitPaths: [],
    force: false,
    applySynthesis: false,
    citations: false,
    syncPull: false,
    syncPush: false,
    pullOnStart: false,
    pushAfterCommit: false,
    agentArgs: [],
    enqueue: false,
    once: false,
    types: [],
    topics: [],
    statuses: [],
    governanceDetectors: [],
    sourceIds: [],
    subjectIds: [],
    pageIds: [],
    claimIds: [],
    sectionPaths: [],
    viewerPrincipals: [],
    contributorPrincipals: [],
    researcherPrincipals: [],
    reviewerPrincipals: [],
    maintainerPrincipals: [],
    adminPrincipals: [],
    requiredReviewerPrincipals: [],
    mcpScopes: [],
    principals: [],
    trustHeaders: false,
    createToken: false,
    confirmWriteTools: false,
    allowSyncFolderWorkspace: false,
    skipAgent: false,
    verifyBackup: false,
    replaceGrants: false,
    forcePathStyle: false,
    allowInsecureHttp: false,
    dreamPhases: [],
    createProposals: false,
  };
}

function syncUsage(): string {
  return "Usage: openwiki [--root <path>] sync status|check-remote|explain-conflict|connect git|now|watch|enable|disable|repair [--remote origin] [--branch main] [--remote-url url] [--pull] [--push] [--message text] [--every 15m] [--once] [--json]";
}
