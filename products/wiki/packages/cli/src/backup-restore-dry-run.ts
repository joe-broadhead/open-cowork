import { promises as fs } from "node:fs";
import path from "node:path";
import { verifyWorkspaceBackup } from "@openwiki/workflows";
import type { CliOptions } from "./args.ts";

interface BackupRestoreDryRunResult {
  dry_run: true;
  backup_dir: string;
  target_root: string;
  verification: Awaited<ReturnType<typeof verifyWorkspaceBackup>>;
  target: {
    status: "missing" | "empty" | "would_replace" | "blocked";
    force: boolean;
    existing_entries?: number;
    message: string;
  };
}

export async function backupRestoreDryRun(input: {
  backupDir: string;
  targetRoot: string;
  root: string | undefined;
  options: CliOptions;
}): Promise<BackupRestoreDryRunResult> {
  const verification = await verifyWorkspaceBackup({
    backupDir: input.backupDir,
    ...(input.root === undefined ? {} : { root: input.root }),
    ...(input.options.backupDestination === undefined ? {} : { destinationId: input.options.backupDestination }),
    ...(input.options.actor === undefined ? {} : { actorId: input.options.actor }),
    recordEvent: false,
  });
  const targetRoot = path.resolve(input.targetRoot);
  return {
    dry_run: true,
    backup_dir: verification.backup_dir,
    target_root: targetRoot,
    verification,
    target: await backupRestoreDryRunTarget(targetRoot, input.options.force),
  };
}

async function backupRestoreDryRunTarget(targetRoot: string, force: boolean): Promise<BackupRestoreDryRunResult["target"]> {
  try {
    const stats = await fs.lstat(targetRoot);
    if (!stats.isDirectory()) {
      return { status: "blocked", force, message: `Restore target exists and is not a directory: ${targetRoot}` };
    }
    const entries = await fs.readdir(targetRoot);
    if (entries.length === 0) {
      return { status: "empty", force, existing_entries: 0, message: "Restore target exists and is empty." };
    }
    if (force) {
      return {
        status: "would_replace",
        force,
        existing_entries: entries.length,
        message: "Restore would replace the existing target after compatibility checks.",
      };
    }
    return {
      status: "blocked",
      force,
      existing_entries: entries.length,
      message: "Restore target is not empty; pass --force only after confirming it is the intended OpenWiki restore target.",
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { status: "missing", force, message: "Restore target does not exist and would be created." };
    }
    throw error;
  }
}
