import { appendEvent } from "@openwiki/repo";
import { isoNow } from "@openwiki/core";
import { validateRepository } from "@openwiki/validation";
import path from "node:path";
import type {
  RehearseWorkspaceBackupInput,
  RehearseWorkspaceBackupResult,
  RestoreRehearsalStage,
} from "./types.ts";
import { restoreWorkspaceBackup, verifyWorkspaceBackup } from "./backup.ts";

const DEFAULT_BACKUP_ACTOR_ID = "actor:user:local";

export async function rehearseWorkspaceBackup(input: RehearseWorkspaceBackupInput): Promise<RehearseWorkspaceBackupResult> {
  const root = path.resolve(input.root);
  const targetRoot = path.resolve(input.targetRoot);
  assertRehearsalTarget(root, targetRoot);
  const actorId = input.actorId ?? DEFAULT_BACKUP_ACTOR_ID;
  const rehearsedAt = input.rehearsedAt ?? isoNow();
  const stages: RestoreRehearsalStage[] = [];
  const cleanup = `Remove the rehearsal target '${targetRoot}' after inspecting the failed restore.`;
  await runRehearsalStage(stages, "resolve_backup", `Resolved backup ${input.backupDir}.`, async () => undefined, cleanup);
  const verification = await runRehearsalStage(
    stages,
    "verify_backup",
    "Backup manifest and checksums verified before rehearsal restore.",
    () =>
      verifyWorkspaceBackup({
        root,
        backupDir: input.backupDir,
        ...(input.destinationId === undefined ? {} : { destinationId: input.destinationId }),
        actorId,
      }),
    cleanup,
  );
  const restore = await runRehearsalStage(
    stages,
    "restore_workspace",
    `Restored backup into isolated target ${targetRoot}.`,
    () =>
      restoreWorkspaceBackup({
        root,
        backupDir: input.backupDir,
        targetRoot,
        ...(input.destinationId === undefined ? {} : { destinationId: input.destinationId }),
        ...(input.force === true ? { force: true } : {}),
        actorId,
      }),
    cleanup,
  );
  const validation = await runRehearsalStage(
    stages,
    "validate_repository",
    `Validated restored workspace at ${targetRoot}.`,
    () => validateRepository(targetRoot),
    cleanup,
  );
  const event = await runRehearsalStage(
    stages,
    "record_evidence",
    "Recorded restore rehearsal evidence in the live workspace event log.",
    () =>
      appendBackupEvent(root, {
        actorId,
        backupId: verification.backup_id,
        backupDir: verification.backup_dir,
        data: {
          target_root: targetRoot,
          rehearsed_at: rehearsedAt,
          validation_status: validation.status,
          validation_issue_count: validation.issue_count,
          restored_paths: restore.restored_paths,
          search_record_count: restore.search_index.recordCount,
          index_record_count: restore.index_store.recordCount,
        },
      }),
    cleanup,
  );
  return {
    root,
    backup_id: verification.backup_id,
    backup_dir: verification.backup_dir,
    target_root: targetRoot,
    rehearsed_at: rehearsedAt,
    status: "pass",
    stages,
    verification,
    restore,
    validation,
    event,
  };
}

function assertRehearsalTarget(root: string, targetRoot: string): void {
  if (targetRoot === root || isPathWithin(targetRoot, root)) {
    throw new Error(`Restore rehearsal target must be outside the live workspace: ${targetRoot}`);
  }
}

async function runRehearsalStage<T>(
  stages: RestoreRehearsalStage[],
  name: RestoreRehearsalStage["name"],
  message: string,
  run: () => Promise<T>,
  cleanup: string,
): Promise<T> {
  try {
    const result = await run();
    stages.push({ name, status: "pass", message });
    return result;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    stages.push({
      name,
      status: "fail",
      message: `${message} Failed: ${cause}`,
      details: { cleanup },
    });
    throw new Error(`Restore rehearsal failed during ${name}: ${cause}. ${cleanup}`);
  }
}

async function appendBackupEvent(
  root: string,
  input: {
    actorId: string;
    backupId: string;
    backupDir: string;
    data: Record<string, unknown>;
  },
) {
  return appendEvent(root, {
    type: "backup.rehearsed",
    actor_id: input.actorId,
    operation: "wiki.backup",
    record_id: input.backupId,
    record_type: "backup",
    data: {
      backup_id: input.backupId,
      backup_dir: input.backupDir,
      ...input.data,
    },
  });
}

function isPathWithin(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
