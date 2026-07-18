import type {
  GitRemoteReachabilityResponse,
  GitRemoteStatusResponse,
  GitRemoteSyncResponse,
  GitSyncConflictState,
  GitSyncState,
} from "@openwiki/git";
import type { OpenWikiSyncConfig } from "@openwiki/core";
import type { CommitChangesResult } from "@openwiki/workflows";
import type { SyncDiagnostic, SyncDiagnosticState, SyncRemoteProvider } from "../sync-diagnostics.ts";

export interface SyncStatusResult {
  root: string;
  is_git_repo: boolean;
  branch?: string;
  upstream?: string;
  remote?: string;
  remote_url?: string;
  ahead: number;
  behind: number;
  clean: boolean;
  dirty_state: "clean" | "dirty";
  conflict_state: "none" | "conflicted";
  conflict_paths: string[];
  sync_state: SyncDiagnosticState;
  provider: SyncRemoteProvider;
  diagnostic: SyncDiagnostic;
  sync: {
    mode: "manual" | "auto";
    remote?: string;
    branch?: string;
    pull_on_start: boolean;
    push_after_commit: boolean;
    interval_seconds?: number;
    conflict_policy: "stop";
  };
  state: GitSyncState;
}

export interface SyncRemoteCheckResult {
  root: string;
  remote_check: GitRemoteReachabilityResponse;
  diagnostic: SyncDiagnostic;
}

export interface SyncNowResult {
  root: string;
  status: "synced" | "failed";
  operations: Array<"pull" | "push">;
  committed?: CommitChangesResult;
  pull?: GitRemoteSyncResponse;
  push?: GitRemoteSyncResponse;
  before: GitRemoteStatusResponse;
  after?: GitRemoteStatusResponse;
  state: GitSyncState;
  conflict?: GitSyncConflictState;
  error?: string;
  recovery?: string[];
}

export interface ConnectGitSyncInput {
  root: string;
  remoteUrl: string;
  remote?: string;
  branch?: string;
  credentialRef?: string;
  actorId?: string;
}

export type ConnectGitSyncResult = {
  remote: string;
  branch: string;
  remote_url?: string;
  credential_ref?: string;
  sync: OpenWikiSyncConfig | undefined;
  state: GitSyncState;
};
