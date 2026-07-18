import type { SyncDiagnostic } from "../sync-diagnostics.ts";
import type { SyncStatusResult } from "./sync-types.ts";

export function printSyncDiagnostic(diagnostic: SyncDiagnostic): void {
  console.log(`${diagnostic.state} ${diagnostic.severity} provider=${diagnostic.provider}`);
  console.log(diagnostic.summary);
  console.log(`action ${diagnostic.recommended_action}`);
  for (const command of diagnostic.commands) {
    console.log(`command ${command}`);
  }
}

export function printSyncStatus(result: SyncStatusResult): void {
  if (!result.is_git_repo) {
    console.log("not_git_repo");
    return;
  }
  console.log(`${result.branch ?? "detached"} ${result.sync_state} ahead=${result.ahead} behind=${result.behind}`);
  console.log(`remote ${result.sync.remote ?? result.remote ?? "origin"} branch ${result.sync.branch ?? result.branch ?? "main"}`);
  console.log(`sync ${result.sync.mode} conflict=${result.conflict_state} provider=${result.provider}`);
  console.log(`action ${result.diagnostic.recommended_action}`);
  if (result.state.last_success !== undefined) {
    console.log(`last_success ${result.state.last_success.occurred_at} ${result.state.last_success.status}`);
  }
  if (result.state.last_failure !== undefined) {
    console.log(`last_failure ${result.state.last_failure.occurred_at} ${result.state.last_failure.status}`);
  }
  for (const conflictPath of result.conflict_paths) {
    console.log(`conflict ${conflictPath}`);
  }
}
