import {
  OPENWIKI_SYSTEM_ACTOR_ID,
  isoNow,
  type EventRecord,
  type OpenWikiAutomationEvent,
  type OpenWikiBackupConfig,
  type OpenWikiSyncConfig,
} from "@openwiki/core";
import {
  gitPull,
  gitPush,
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
import { createWorkspaceBackup } from "./backup.ts";
import { withWriteCoordination } from "./write-coordinator.ts";
import type { CreateWorkspaceBackupResult } from "./types.ts";

export interface SyncWorkspaceNowInput {
  root: string;
  actorId?: string;
  pull?: boolean;
  push?: boolean;
  remote?: string;
  branch?: string;
  triggerEvent?: OpenWikiAutomationEvent | string;
  triggerRecordId?: string;
}

export interface SyncWorkspaceNowResult {
  root: string;
  status: "synced" | "failed";
  operations: Array<"pull" | "push">;
  pull?: GitRemoteSyncResponse;
  push?: GitRemoteSyncResponse;
  before: GitRemoteStatusResponse;
  after?: GitRemoteStatusResponse;
  state: GitSyncState;
  conflict?: GitSyncConflictState;
  error?: string;
  recovery?: string[];
  trigger_event?: string;
}

export interface PostEventAutomationInput {
  root: string;
  eventType: OpenWikiAutomationEvent;
  actorId?: string;
  recordId?: string;
  recordType?: string;
  subjectIds?: string[];
  subjectPaths?: string[];
  hasManagedCommit?: boolean;
}

export interface PostEventAutomationResult {
  sync?: SyncWorkspaceNowResult | PostEventSkipResult;
  backup?: PostEventBackupResult | PostEventSkipResult;
}

export interface PostEventSkipResult {
  status: "skipped";
  reason: string;
  trigger_event: OpenWikiAutomationEvent;
}

export interface PostEventBackupResult {
  status: "created" | "failed";
  trigger_event: OpenWikiAutomationEvent;
  backup_id?: string;
  backup_dir?: string;
  error?: string;
}

export async function syncWorkspaceNow(input: SyncWorkspaceNowInput): Promise<SyncWorkspaceNowResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.git_sync_now",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: {
        pull: input.pull !== false,
        push: input.push !== false,
        ...(input.triggerEvent === undefined ? {} : { trigger_event: input.triggerEvent }),
        ...(input.triggerRecordId === undefined ? {} : { trigger_record_id: input.triggerRecordId }),
      },
    },
    () => syncWorkspaceNowUnlocked(input),
  );
}

export async function runPostEventAutomation(input: PostEventAutomationInput): Promise<PostEventAutomationResult> {
  const repo = await loadRepository(input.root);
  const result: PostEventAutomationResult = {};
  const actorId = input.actorId ?? OPENWIKI_SYSTEM_ACTOR_ID;
  const syncConfig = repo.config.runtime?.sync;
  if (syncConfig !== undefined && shouldSyncAfterEvent(syncConfig, input)) {
    const skip = await syncSkipReason(repo, input);
    if (skip !== undefined) {
      result.sync = await recordPostEventSkip(repo.root, "git.sync_skipped", actorId, input, skip);
    } else {
      try {
        result.sync = await syncWorkspaceNow({
          root: repo.root,
          actorId,
          pull: true,
          push: true,
          ...(syncConfig.remote === undefined ? {} : { remote: syncConfig.remote }),
          ...(syncConfig.branch === undefined ? {} : { branch: syncConfig.branch }),
          triggerEvent: input.eventType,
          ...(input.recordId === undefined ? {} : { triggerRecordId: input.recordId }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendPostEventAutomationEvent(repo.root, {
          type: "git.sync_failed",
          actorId,
          input,
          data: { error: message },
        });
        result.sync = {
          status: "skipped",
          reason: message,
          trigger_event: input.eventType,
        };
      }
    }
  }

  const backups = repo.config.runtime?.backups;
  if (backups?.enabled === true && shouldBackupAfterEvent(backups.backup_after_events, input)) {
    const skip = backupSkipReason(repo.events, input, backups.event_threshold, backups.min_interval_seconds);
    if (skip !== undefined) {
      result.backup = await recordPostEventSkip(repo.root, "backup.skipped", actorId, input, skip);
    } else {
      result.backup = await createBackupForEvent(repo.root, actorId, input, backups);
    }
  }

  return result;
}

async function syncWorkspaceNowUnlocked(input: SyncWorkspaceNowInput): Promise<SyncWorkspaceNowResult> {
  const before = await gitRemoteStatus(input.root);
  const operations = syncOperations(input);
  try {
    if (!before.clean) {
      return syncFailure(input.root, before, "Workspace has uncommitted changes; safe sync refuses to auto-commit unrelated files.", input);
    }

    let pull: GitRemoteSyncResponse | undefined;
    let push: GitRemoteSyncResponse | undefined;
    const target = {
      ...(input.remote === undefined ? {} : { remote: input.remote }),
      ...(input.branch === undefined ? {} : { branch: input.branch }),
    };
    if (operations.includes("pull")) {
      pull = await gitPull(input.root, target);
    }
    if (operations.includes("push")) {
      push = await gitPush(input.root, target);
    }
    const after = await gitRemoteStatus(input.root);
    const skipped = [pull, push].find((response) => response?.status === "no_remote" || response?.status === "not_git_repo");
    if (skipped !== undefined) {
      return syncFailure(input.root, after, `Sync ${skipped.operation} skipped: ${skipped.status}.`, input);
    }
    const state = await recordSyncSuccess(input.root, {
      operation: "sync",
      status: "synced",
      occurred_at: isoNow(),
      message: operations.join("+"),
      ...(after.remote === undefined ? {} : { remote: after.remote }),
      ...(after.branch === undefined ? {} : { branch: after.branch }),
    });
    const result: SyncWorkspaceNowResult = {
      root: input.root,
      status: "synced",
      operations,
      ...(pull === undefined ? {} : { pull }),
      ...(push === undefined ? {} : { push }),
      before,
      after,
      state,
      ...(input.triggerEvent === undefined ? {} : { trigger_event: input.triggerEvent }),
    };
    return result;
  } catch (error) {
    return syncFailure(input.root, before, error instanceof Error ? error.message : String(error), input);
  }
}

async function syncFailure(
  root: string,
  before: GitRemoteStatusResponse,
  message: string,
  input: SyncWorkspaceNowInput,
): Promise<SyncWorkspaceNowResult> {
  const after = await gitRemoteStatus(root).catch(() => before);
  const conflict = conflictStateFromStatus(after);
  const state = await recordSyncFailure(root, {
    operation: "sync",
    status: conflict.has_conflicts ? "conflict" : syncFailureStatus(message),
    occurred_at: isoNow(),
    error: message,
    ...(after.remote === undefined ? before.remote === undefined ? {} : { remote: before.remote } : { remote: after.remote }),
    ...(after.branch === undefined ? before.branch === undefined ? {} : { branch: before.branch } : { branch: after.branch }),
  }, conflict);
  return {
    root,
    status: "failed",
    operations: syncOperations(input),
    before,
    after,
    state,
    conflict,
    error: message,
    recovery: syncRecovery(after, state),
    ...(input.triggerEvent === undefined ? {} : { trigger_event: input.triggerEvent }),
  };
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

function syncOperations(input: SyncWorkspaceNowInput): Array<"pull" | "push"> {
  return [
    ...(input.pull === false ? [] : ["pull" as const]),
    ...(input.push === false ? [] : ["push" as const]),
  ];
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

function syncFailureStatus(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes("conflict")) {
    return "conflict";
  }
  if (normalized.includes("uncommitted") || normalized.includes("dirty")) {
    return "dirty_workspace";
  }
  if (normalized.includes("no_remote") || normalized.includes("no remote")) {
    return "no_remote";
  }
  if (normalized.includes("not_git_repo") || normalized.includes("not a git")) {
    return "not_git_repo";
  }
  return "error";
}

function syncRecovery(status: GitRemoteStatusResponse, state: GitSyncState): string[] {
  if (status.conflict_state === "conflicted" || state.conflict?.has_conflicts === true) {
    return [
      "Resolve Git conflicts in the workspace.",
      "Run openwiki sync explain-conflict for paths and recovery steps.",
      "Retry openwiki sync now after the workspace is clean.",
    ];
  }
  if (!status.clean) {
    return [
      "Inspect local changes with openwiki git status.",
      "Commit intentional OpenWiki-managed changes before syncing.",
      "Retry openwiki sync now after the workspace is clean.",
    ];
  }
  return ["Check Git remote credentials and network reachability, then retry openwiki sync now."];
}

function shouldSyncAfterEvent(sync: OpenWikiSyncConfig, input: PostEventAutomationInput): boolean {
  if (input.hasManagedCommit === true && input.eventType === "proposal.applied" && sync?.push_after_commit === true) {
    return true;
  }
  return eventListMatches(sync?.sync_after_events, input.eventType);
}

function shouldBackupAfterEvent(configuredEvents: OpenWikiAutomationEvent[] | undefined, input: PostEventAutomationInput): boolean {
  return eventListMatches(configuredEvents, input.eventType);
}

function eventListMatches(configuredEvents: OpenWikiAutomationEvent[] | undefined, eventType: OpenWikiAutomationEvent): boolean {
  if (configuredEvents === undefined || configuredEvents.length === 0) {
    return false;
  }
  const aliases = eventAliases(eventType);
  return configuredEvents.some((configured) => aliases.includes(configured));
}

function eventAliases(eventType: OpenWikiAutomationEvent): OpenWikiAutomationEvent[] {
  if (eventType === "inbox.processed" || eventType === "inbox.proposed") {
    return ["inbox.processed", "inbox.proposed"];
  }
  return [eventType];
}

async function syncSkipReason(repo: Awaited<ReturnType<typeof loadRepository>>, input: PostEventAutomationInput): Promise<string | undefined> {
  const sync = repo.config.runtime?.sync;
  if (sync === undefined) {
    return "runtime.sync is not configured";
  }
  const state = await readGitSyncState(repo.root);
  const lastAttempt = latestTimestamp([state.last_success?.occurred_at, state.last_failure?.occurred_at]);
  if (sync.debounce_seconds !== undefined && lastAttempt !== undefined && Date.now() - lastAttempt.getTime() < sync.debounce_seconds * 1000) {
    return `Last sync attempt is inside runtime.sync.debounce_seconds=${sync.debounce_seconds}`;
  }
  if (sync.backoff_seconds !== undefined && state.last_failure?.occurred_at !== undefined) {
    const lastFailure = dateFromIso(state.last_failure.occurred_at);
    if (lastFailure !== undefined && Date.now() - lastFailure.getTime() < sync.backoff_seconds * 1000) {
      return `Last sync failure is inside runtime.sync.backoff_seconds=${sync.backoff_seconds}`;
    }
  }
  if (sync.max_attempts !== undefined) {
    const recentFailures = syncFailuresSinceLastSuccess(repo.events, input.eventType);
    if (recentFailures >= sync.max_attempts) {
      return `runtime.sync.max_attempts=${sync.max_attempts} reached for ${input.eventType}`;
    }
  }
  return undefined;
}

function syncFailuresSinceLastSuccess(events: EventRecord[], eventType: OpenWikiAutomationEvent): number {
  const aliases = new Set(eventAliases(eventType));
  const newestFirst = [...events].sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
  let failures = 0;
  for (const event of newestFirst) {
    if (event.type === "git.sync_succeeded") {
      return failures;
    }
    if (event.type === "git.sync_failed" && typeof event.data?.trigger_event === "string" && aliases.has(event.data.trigger_event as OpenWikiAutomationEvent)) {
      failures += 1;
    }
  }
  return failures;
}

function backupSkipReason(
  events: EventRecord[],
  input: PostEventAutomationInput,
  eventThreshold: number | undefined,
  minIntervalSeconds: number | undefined,
): string | undefined {
  const lastBackup = newestEvent(events, "backup.created");
  if (minIntervalSeconds !== undefined && lastBackup !== undefined) {
    const lastBackupAt = dateFromIso(lastBackup.occurred_at);
    if (lastBackupAt !== undefined && Date.now() - lastBackupAt.getTime() < minIntervalSeconds * 1000) {
      return `Last backup is inside runtime.backups.min_interval_seconds=${minIntervalSeconds}`;
    }
  }
  const threshold = eventThreshold ?? 1;
  if (threshold <= 1) {
    return undefined;
  }
  const aliases = new Set(eventAliases(input.eventType));
  const after = lastBackup?.occurred_at;
  const matchingEvents = events.filter(
    (event) => aliases.has(event.type as OpenWikiAutomationEvent) && (after === undefined || event.occurred_at > after),
  ).length;
  return matchingEvents >= threshold ? undefined : `Only ${matchingEvents}/${threshold} configured events occurred since the last backup`;
}

async function createBackupForEvent(
  root: string,
  actorId: string,
  input: PostEventAutomationInput,
  backups: OpenWikiBackupConfig,
): Promise<PostEventBackupResult> {
  try {
    const destinationId = backupAutomationDestinationId(backups);
    const backup = await createWorkspaceBackup({ root, actorId, ...(destinationId === undefined ? {} : { destinationId }) });
    await appendPostEventAutomationEvent(root, {
      type: "backup.automation_succeeded",
      actorId,
      input,
      data: backupEventData(backup),
    });
    return {
      status: "created",
      trigger_event: input.eventType,
      backup_id: backup.backup_id,
      backup_dir: backup.backup_dir,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendPostEventAutomationEvent(root, {
      type: "backup.automation_failed",
      actorId,
      input,
      data: { error: message },
    });
    return {
      status: "failed",
      trigger_event: input.eventType,
      error: message,
    };
  }
}

function backupAutomationDestinationId(
  backups: OpenWikiBackupConfig | undefined,
): string | undefined {
  const destinations = backups?.destinations ?? [];
  if (backups?.default_destination_id !== undefined) {
    return backups.default_destination_id;
  }
  if (destinations.length === 1) {
    return destinations[0]?.id;
  }
  if (destinations.length > 1) {
    throw new Error("runtime.backups.default_destination_id is required when event-triggered backups have multiple destinations");
  }
  return undefined;
}

function backupEventData(backup: CreateWorkspaceBackupResult): Record<string, unknown> {
  return {
    backup_id: backup.backup_id,
    backup_dir: backup.backup_dir,
    manifest_path: backup.manifest_path,
  };
}

async function recordPostEventSkip(
  root: string,
  type: "git.sync_skipped" | "backup.skipped",
  actorId: string,
  input: PostEventAutomationInput,
  reason: string,
): Promise<PostEventSkipResult> {
  await appendPostEventAutomationEvent(root, {
    type,
    actorId,
    input,
    data: { reason },
  });
  return {
    status: "skipped",
    reason,
    trigger_event: input.eventType,
  };
}

async function appendPostEventAutomationEvent(root: string, input: {
  type: string;
  actorId: string;
  input: PostEventAutomationInput;
  data: Record<string, unknown>;
}): Promise<void> {
  await appendEvent(root, {
    type: input.type,
    actor_id: input.actorId,
    operation: "wiki.post_event_automation",
    ...(input.input.recordId === undefined ? {} : { record_id: input.input.recordId }),
    ...(input.input.recordType === undefined ? {} : { record_type: input.input.recordType }),
    ...(input.input.subjectIds === undefined ? {} : { subject_ids: input.input.subjectIds }),
    ...(input.input.subjectPaths === undefined ? {} : { subject_paths: input.input.subjectPaths }),
    data: {
      ...input.data,
      trigger_event: input.input.eventType,
    },
    sensitivity: "internal",
  });
}

function newestEvent(events: EventRecord[], type: string): EventRecord | undefined {
  return events
    .filter((event) => event.type === type)
    .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at))[0];
}

function latestTimestamp(values: Array<string | undefined>): Date | undefined {
  const dates = values.map(dateFromIso).filter((date): date is Date => date !== undefined);
  return dates.sort((left, right) => right.getTime() - left.getTime())[0];
}

function dateFromIso(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}
