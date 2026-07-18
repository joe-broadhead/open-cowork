import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OPENWIKI_PROTOCOL_VERSION,
  OPENWIKI_REPO_FORMAT,
  isoNow,
  slugify,
} from "@openwiki/core";
import { appendEvent, loadRepository } from "@openwiki/repo";
import { rebuildIndexStore } from "@openwiki/index-store";
import { buildSearchIndex } from "@openwiki/search";
import {
  buildWorkspaceBackupArtifact,
  CHECKSUM_FILE,
  pathExists,
  readWorkspaceBackupManifest,
  RESTORE_README_FILE,
  verifyWorkspaceBackupDirectory,
} from "./backup-artifact.ts";
import {
  deleteCloudBackup,
  isCloudBackupReference,
  listCloudBackups,
  materializeCloudBackup,
  resolveCloudBackupDestination,
  uniqueCloudBackupId,
  uploadCloudBackupArtifact,
} from "./backup-cloud.ts";
import type {
  CreateWorkspaceBackupInput,
  CreateWorkspaceBackupResult,
  PruneWorkspaceBackupsInput,
  PruneWorkspaceBackupsResult,
  RestoreWorkspaceBackupInput,
  RestoreWorkspaceBackupResult,
  VerifyWorkspaceBackupInput,
  VerifyWorkspaceBackupResult,
  WorkspaceBackupDestinationSummary,
  WorkspaceBackupEntry,
  WorkspaceBackupListInput,
  WorkspaceBackupListResult,
  WorkspaceBackupManifest,
  WorkspaceBackupPruneEntry,
} from "./types.ts";

const DEFAULT_BACKUP_OUT_DIR = "backups";
const DEFAULT_BACKUP_ACTOR_ID = "actor:user:local";
const DAY_MS = 24 * 60 * 60 * 1000;

export async function createWorkspaceBackup(input: CreateWorkspaceBackupInput): Promise<CreateWorkspaceBackupResult> {
  const repo = await loadRepository(input.root);
  const actorId = input.actorId ?? DEFAULT_BACKUP_ACTOR_ID;
  const createdAt = input.createdAt ?? isoNow();
  const cloudDestination = resolveCloudBackupDestination(repo.config.workspace_id, repo.config.runtime?.backups, {
    ...(input.outDir === undefined ? {} : { outDir: input.outDir }),
    ...(input.destinationId === undefined ? {} : { destinationId: input.destinationId }),
  });
  if (cloudDestination !== undefined) {
    const baseBackupId = `openwiki-backup-${slugify(repo.config.workspace_id)}-${createdAt.replace(/[:.]/g, "-")}`;
    const backupId = await uniqueCloudBackupId(cloudDestination, baseBackupId);
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), `.openwiki-backup-${backupId}-tmp-`));
    try {
      const artifact = await buildWorkspaceBackupArtifact({
        root: repo.root,
        workspaceId: repo.config.workspace_id,
        workspaceTitle: repo.config.title,
        protocolVersion: repo.config.protocol_version,
        repoFormat: repo.config.repo_format,
        ...(repo.config.runtime?.storage === undefined ? {} : { storage: repo.config.runtime.storage }),
        backupId,
        actorId,
        createdAt,
        stagingDir,
        includeGit: input.includeGit !== false,
        counts: {
          pages: repo.pages.length,
          sources: repo.sources.length,
          claims: repo.claims.length,
          proposals: repo.proposals.length,
          decisions: repo.decisions.length,
          events: repo.events.length,
          runs: repo.runs.length,
        },
      });
      const committed = await uploadCloudBackupArtifact(cloudDestination, stagingDir, backupId);
      const event = await appendBackupEvent(repo.root, {
        type: "backup.created",
        actorId,
        backupId: artifact.manifest.backup_id,
        backupDir: committed.backupDir,
        data: {
          destination: cloudDestination.destination,
          checksum_file_hash: artifact.checksumFileHash,
          files: artifact.files,
          bytes: artifact.bytes,
          source_commit: artifact.sourceCommit,
          source_dirty: artifact.sourceDirty,
          warnings: artifact.warnings,
        },
      });
      return {
        root: repo.root,
        backup_id: artifact.manifest.backup_id,
        backup_dir: committed.backupDir,
        manifest_path: committed.manifestPath,
        checksums_path: committed.checksumsPath,
        restore_readme_path: committed.restoreReadmePath,
        manifest: artifact.manifest,
        event,
      };
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const destination = resolveBackupDestination(repo.root, repo.config.runtime?.backups, {
    ...(input.outDir === undefined ? {} : { outDir: input.outDir }),
    ...(input.destinationId === undefined ? {} : { destinationId: input.destinationId }),
  });
  const destinationPath = requireLocalDestinationPath(destination);
  await fs.mkdir(destinationPath, { recursive: true });
  const backupId = `openwiki-backup-${slugify(repo.config.workspace_id)}-${createdAt.replace(/[:.]/g, "-")}`;
  const finalBackupDir = await uniqueBackupPath(destinationPath, backupId);
  const stagingDir = await fs.mkdtemp(path.join(destinationPath, `.openwiki-backup-${backupId}-tmp-`));
  try {
    const artifact = await buildWorkspaceBackupArtifact({
      root: repo.root,
      workspaceId: repo.config.workspace_id,
      workspaceTitle: repo.config.title,
      protocolVersion: repo.config.protocol_version,
      repoFormat: repo.config.repo_format,
      ...(repo.config.runtime?.storage === undefined ? {} : { storage: repo.config.runtime.storage }),
      backupId: path.basename(finalBackupDir),
      actorId,
      createdAt,
      stagingDir,
      includeGit: input.includeGit !== false,
      counts: {
        pages: repo.pages.length,
        sources: repo.sources.length,
        claims: repo.claims.length,
        proposals: repo.proposals.length,
        decisions: repo.decisions.length,
        events: repo.events.length,
        runs: repo.runs.length,
      },
    });
    await fs.rename(stagingDir, finalBackupDir);
    const event = await appendBackupEvent(repo.root, {
      type: "backup.created",
      actorId,
      backupId: artifact.manifest.backup_id,
      backupDir: finalBackupDir,
      data: {
        destination,
        checksum_file_hash: artifact.checksumFileHash,
        files: artifact.files,
        bytes: artifact.bytes,
        source_commit: artifact.sourceCommit,
        source_dirty: artifact.sourceDirty,
        warnings: artifact.warnings,
      },
    });
    return {
      root: repo.root,
      backup_id: artifact.manifest.backup_id,
      backup_dir: finalBackupDir,
      manifest_path: path.join(finalBackupDir, "manifest.json"),
      checksums_path: path.join(finalBackupDir, CHECKSUM_FILE),
      restore_readme_path: path.join(finalBackupDir, RESTORE_README_FILE),
      manifest: artifact.manifest,
      event,
    };
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function listWorkspaceBackups(input: WorkspaceBackupListInput): Promise<WorkspaceBackupListResult> {
  const repo = await loadRepository(input.root);
  const cloudDestination = resolveCloudBackupDestination(repo.config.workspace_id, repo.config.runtime?.backups, {
    ...(input.outDir === undefined ? {} : { outDir: input.outDir }),
    ...(input.destinationId === undefined ? {} : { destinationId: input.destinationId }),
  });
  if (cloudDestination !== undefined) {
    return {
      root: repo.root,
      destination: cloudDestination.destination,
      backups: await listCloudBackups(cloudDestination),
    };
  }
  const destination = resolveBackupDestination(repo.root, repo.config.runtime?.backups, {
    ...(input.outDir === undefined ? {} : { outDir: input.outDir }),
    ...(input.destinationId === undefined ? {} : { destinationId: input.destinationId }),
  });
  const backups = await discoverBackups(requireLocalDestinationPath(destination));
  return { root: repo.root, destination, backups };
}

export async function verifyWorkspaceBackup(input: VerifyWorkspaceBackupInput): Promise<VerifyWorkspaceBackupResult> {
  if (isCloudBackupReference(input.backupDir)) {
    const handle = await requireCloudBackupDestination(input.root, input.destinationId);
    const materialized = await materializeCloudBackup(handle, input.backupDir);
    try {
      const verification = await verifyWorkspaceBackupDirectory(materialized.localDir);
      const result: VerifyWorkspaceBackupResult = {
        backup_id: verification.manifest.backup_id,
        backup_dir: materialized.backupDir,
        manifest: verification.manifest,
        checksum_file_hash: verification.checksumFileHash,
        files_checked: verification.files,
        bytes_checked: verification.bytes,
        warnings: verification.manifest.warnings,
      };
      if (input.root !== undefined && input.recordEvent !== false) {
        result.event = await appendBackupEvent(path.resolve(input.root), {
          type: "backup.verified",
          actorId: input.actorId ?? DEFAULT_BACKUP_ACTOR_ID,
          backupId: verification.manifest.backup_id,
          backupDir: materialized.backupDir,
          data: {
            checksum_file_hash: verification.checksumFileHash,
            files_checked: verification.files,
            bytes_checked: verification.bytes,
          },
        });
      }
      return result;
    } finally {
      await materialized.cleanup();
    }
  }
  const backupDir = path.resolve(input.backupDir);
  const verification = await verifyWorkspaceBackupDirectory(backupDir);
  const result: VerifyWorkspaceBackupResult = {
    backup_id: verification.manifest.backup_id,
    backup_dir: backupDir,
    manifest: verification.manifest,
    checksum_file_hash: verification.checksumFileHash,
    files_checked: verification.files,
    bytes_checked: verification.bytes,
    warnings: verification.manifest.warnings,
  };
  if (input.root !== undefined && input.recordEvent !== false) {
    result.event = await appendBackupEvent(path.resolve(input.root), {
      type: "backup.verified",
      actorId: input.actorId ?? DEFAULT_BACKUP_ACTOR_ID,
      backupId: verification.manifest.backup_id,
      backupDir,
      data: {
        checksum_file_hash: verification.checksumFileHash,
        files_checked: verification.files,
        bytes_checked: verification.bytes,
      },
    });
  }
  return result;
}

export async function restoreWorkspaceBackup(input: RestoreWorkspaceBackupInput): Promise<RestoreWorkspaceBackupResult> {
  const materialized = isCloudBackupReference(input.backupDir)
    ? await materializeCloudBackup(await requireCloudBackupDestination(input.root, input.destinationId), input.backupDir)
    : undefined;
  const backupDir = materialized?.localDir ?? path.resolve(input.backupDir);
  const displayBackupDir = materialized?.backupDir ?? backupDir;
  const targetRoot = path.resolve(input.targetRoot);
  const verification = await verifyWorkspaceBackupDirectory(backupDir);
  const manifest = verification.manifest;
  const repoDir = path.join(backupDir, "repo");
  try {
    await assertRestoreTargetAvailable(targetRoot, manifest, input.force ?? false);
    await fs.mkdir(targetRoot, { recursive: true });

    const restoredPaths: string[] = [];
    for (const relativePath of manifest.included_paths) {
      const sourcePath = path.join(repoDir, relativePath);
      if (!(await pathExists(sourcePath))) {
        continue;
      }
      const targetPath = path.join(targetRoot, relativePath);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.cp(sourcePath, targetPath, { recursive: true, force: true });
      restoredPaths.push(relativePath);
    }

    if (!restoredPaths.includes("openwiki.json")) {
      throw new Error(`Backup ${displayBackupDir} does not contain openwiki.json`);
    }

    const event = await appendBackupEvent(targetRoot, {
      type: "backup.restored",
      actorId: input.actorId ?? DEFAULT_BACKUP_ACTOR_ID,
      backupId: manifest.backup_id,
      backupDir: displayBackupDir,
      data: {
        restored_paths: restoredPaths,
        checksum_file_hash: verification.checksumFileHash,
      },
    });
    const searchIndex = await buildSearchIndex(targetRoot);
    const indexStore = await rebuildIndexStore(targetRoot);
    return {
      backup_dir: displayBackupDir,
      target_root: targetRoot,
      manifest,
      verification: {
        backup_id: verification.manifest.backup_id,
        backup_dir: displayBackupDir,
        manifest: verification.manifest,
        checksum_file_hash: verification.checksumFileHash,
        files_checked: verification.files,
        bytes_checked: verification.bytes,
        warnings: verification.manifest.warnings,
      },
      restored_paths: restoredPaths,
      search_index: searchIndex,
      index_store: indexStore,
      event,
    };
  } finally {
    await materialized?.cleanup();
  }
}

export async function pruneWorkspaceBackups(input: PruneWorkspaceBackupsInput): Promise<PruneWorkspaceBackupsResult> {
  const repo = await loadRepository(input.root);
  const cloudDestination = resolveCloudBackupDestination(repo.config.workspace_id, repo.config.runtime?.backups, {
    ...(input.outDir === undefined ? {} : { outDir: input.outDir }),
    ...(input.destinationId === undefined ? {} : { destinationId: input.destinationId }),
  });
  const keepLast = input.keepLast ?? repo.config.runtime?.backups?.retention?.keep_last;
  const keepDays = input.keepDays ?? repo.config.runtime?.backups?.retention?.keep_days;
  const retention = {
    ...(keepLast === undefined ? {} : { keep_last: keepLast }),
    ...(keepDays === undefined ? {} : { keep_days: keepDays }),
  };
  if (retention.keep_last === undefined && retention.keep_days === undefined) {
    throw new Error("No backup retention policy is configured. Set runtime.backups.retention or pass --keep-last/--keep-days.");
  }
  const now = Date.parse(input.now ?? isoNow());
  if (!Number.isFinite(now)) {
    throw new Error(`Invalid backup prune timestamp: ${input.now}`);
  }
  if (cloudDestination !== undefined) {
    return pruneBackupEntries({
      root: repo.root,
      destination: cloudDestination.destination,
      backups: (await listCloudBackups(cloudDestination)).filter((backup) => backup.status === "ok"),
      retention,
      now,
      dryRun: input.dryRun === true,
      actorId: input.actorId ?? DEFAULT_BACKUP_ACTOR_ID,
      deleteBackup: (backup) => deleteCloudBackup(cloudDestination, backup),
    });
  }
  const destination = resolveBackupDestination(repo.root, repo.config.runtime?.backups, {
    ...(input.outDir === undefined ? {} : { outDir: input.outDir }),
    ...(input.destinationId === undefined ? {} : { destinationId: input.destinationId }),
  });
  if (destination.path === undefined) {
    throw new Error("Local backup destination does not define a path.");
  }
  const backups = (await discoverBackups(destination.path)).filter((backup) => backup.status === "ok");
  return pruneBackupEntries({
    root: repo.root,
    destination,
    backups,
    retention,
    now,
    dryRun: input.dryRun === true,
    actorId: input.actorId ?? DEFAULT_BACKUP_ACTOR_ID,
    deleteBackup: async (backup) => {
      if (destination.path === undefined) {
        throw new Error("Local backup destination does not define a path.");
      }
      assertPathWithinDirectory(destination.path, backup.backup_dir, "backup prune");
      await fs.rm(backup.backup_dir, { recursive: true, force: true });
    },
  });
}

async function pruneBackupEntries(input: {
  root: string;
  destination: WorkspaceBackupDestinationSummary;
  backups: WorkspaceBackupEntry[];
  retention: { keep_last?: number; keep_days?: number };
  now: number;
  dryRun: boolean;
  actorId: string;
  deleteBackup(backup: WorkspaceBackupEntry): Promise<void>;
}): Promise<PruneWorkspaceBackupsResult> {
  const sorted = input.backups.sort((left, right) => backupCreatedAtMs(right) - backupCreatedAtMs(left));
  const kept: WorkspaceBackupPruneEntry[] = [];
  const deleted: WorkspaceBackupPruneEntry[] = [];
  for (const [index, backup] of sorted.entries()) {
    const reason = pruneReason(backup, index, input.now, {
      ...(input.retention.keep_last === undefined ? {} : { keep_last: input.retention.keep_last }),
      ...(input.retention.keep_days === undefined ? {} : { keep_days: input.retention.keep_days }),
    });
    const entry = {
      backup_id: backup.backup_id,
      backup_dir: backup.backup_dir,
      ...(backup.created_at === undefined ? {} : { created_at: backup.created_at }),
      reason: reason ?? "retained by policy",
    };
    if (reason === undefined) {
      kept.push(entry);
      continue;
    }
    deleted.push(entry);
    if (!input.dryRun) {
      await input.deleteBackup(backup);
    }
  }
  const result: PruneWorkspaceBackupsResult = {
    root: input.root,
    destination: input.destination,
    dry_run: input.dryRun,
    retention: {
      ...(input.retention.keep_last === undefined ? {} : { keep_last: input.retention.keep_last }),
      ...(input.retention.keep_days === undefined ? {} : { keep_days: input.retention.keep_days }),
    },
    backups_considered: input.backups.length,
    kept,
    deleted,
  };
  result.event = await appendBackupEvent(input.root, {
    type: input.dryRun ? "backup.prune_planned" : "backup.pruned",
    actorId: input.actorId,
    backupId: `backup-prune:${Date.now()}`,
    backupDir: destinationLabel(input.destination),
    data: {
      dry_run: result.dry_run,
      retention: result.retention,
      deleted: deleted.map((entry) => ({ backup_id: entry.backup_id, backup_dir: entry.backup_dir, reason: entry.reason })),
      kept_count: kept.length,
    },
  });
  return result;
}

async function requireCloudBackupDestination(
  root: string | undefined,
  destinationId: string | undefined,
) {
  if (root === undefined || destinationId === undefined) {
    throw new Error("Cloud backup references require --root and --destination so credentials can be resolved.");
  }
  const repo = await loadRepository(root);
  const destination = resolveCloudBackupDestination(repo.config.workspace_id, repo.config.runtime?.backups, { destinationId });
  if (destination === undefined) {
    throw new Error(`Backup destination '${destinationId}' is not a configured cloud backup destination.`);
  }
  return destination;
}

function destinationLabel(destination: WorkspaceBackupDestinationSummary): string {
  return destination.path ?? destination.uri ?? destination.id ?? destination.kind;
}

function requireLocalDestinationPath(destination: WorkspaceBackupDestinationSummary): string {
  if (destination.path === undefined) {
    throw new Error(`Backup destination '${destination.id ?? destination.kind}' does not define a local path.`);
  }
  return destination.path;
}

async function assertRestoreTargetAvailable(targetRoot: string, manifest: WorkspaceBackupManifest, force: boolean): Promise<void> {
  if (isFilesystemRoot(targetRoot)) {
    throw new Error(`Refusing to restore into filesystem root: ${targetRoot}`);
  }
  const targetStats = await fs.lstat(targetRoot).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (targetStats?.isSymbolicLink()) {
    throw new Error(`Refusing to restore into symlinked target root: ${targetRoot}`);
  }
  if (targetStats !== undefined && !targetStats.isDirectory()) {
    throw new Error(`Restore target is not a directory: ${targetRoot}`);
  }
  const entries = await fs.readdir(targetRoot).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (entries === undefined || entries.length === 0) {
    return;
  }
  if (!force) {
    throw new Error(`Restore target is not empty: ${targetRoot}. Use --force to replace it.`);
  }
  await assertSafeForceRestoreTarget(targetRoot, manifest);
  for (const entry of entries) {
    await fs.rm(path.join(targetRoot, entry), { recursive: true, force: true });
  }
}

async function assertSafeForceRestoreTarget(targetRoot: string, manifest: WorkspaceBackupManifest): Promise<void> {
  const configPath = path.join(targetRoot, "openwiki.json");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Refusing to force restore into non-OpenWiki directory: ${targetRoot}`);
    }
    throw new Error(`Refusing to force restore into invalid OpenWiki directory: ${targetRoot}`);
  }
  if (
    parsed.protocol_version !== OPENWIKI_PROTOCOL_VERSION ||
    parsed.repo_format !== OPENWIKI_REPO_FORMAT ||
    parsed.workspace_id !== manifest.workspace_id ||
    manifest.protocol_version !== OPENWIKI_PROTOCOL_VERSION ||
    manifest.repo_format !== OPENWIKI_REPO_FORMAT
  ) {
    throw new Error(`Refusing to force restore into incompatible OpenWiki workspace: ${targetRoot}`);
  }
}

async function discoverBackups(destinationPath: string): Promise<WorkspaceBackupEntry[]> {
  const resolvedDestination = path.resolve(destinationPath);
  const names = await fs.readdir(resolvedDestination).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const backups: WorkspaceBackupEntry[] = [];
  for (const name of names) {
    if (!name.startsWith("openwiki-backup-")) {
      continue;
    }
    const backupDir = path.join(resolvedDestination, name);
    const manifestPath = path.join(backupDir, "manifest.json");
    try {
      const stat = await fs.lstat(backupDir);
      if (!stat.isDirectory()) {
        continue;
      }
      const manifest = await readWorkspaceBackupManifest(backupDir);
      const checksumFile = await fs.readFile(path.join(backupDir, manifest.checksum_file));
      if (sha256Hex(checksumFile) !== manifest.checksum_file_hash) {
        throw new Error(`Backup ${backupDir} checksum file hash does not match manifest`);
      }
      backups.push({
        backup_id: manifest.backup_id,
        backup_dir: backupDir,
        manifest_path: manifestPath,
        created_at: manifest.created_at,
        workspace_id: manifest.workspace_id,
        workspace_title: manifest.workspace_title,
        checksum_file_hash: manifest.checksum_file_hash,
        file_count: manifest.file_count,
        byte_count: manifest.byte_count,
        status: "ok",
      });
    } catch (error) {
      backups.push({
        backup_id: name,
        backup_dir: backupDir,
        manifest_path: manifestPath,
        status: "invalid",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return backups.sort((left, right) => backupCreatedAtMs(right) - backupCreatedAtMs(left));
}

function resolveBackupDestination(
  root: string,
  config: { destinations?: Array<{ id: string; kind: string; path?: string }>; retention?: { keep_last?: number; keep_days?: number } } | undefined,
  input: { outDir?: string; destinationId?: string },
): WorkspaceBackupDestinationSummary {
  if (input.outDir !== undefined && input.destinationId !== undefined) {
    throw new Error("Use either --out-dir or --destination for backup commands, not both.");
  }
  if (input.outDir !== undefined) {
    return { kind: "local", path: path.resolve(root, input.outDir) };
  }
  const destinations = config?.destinations ?? [];
  if (input.destinationId !== undefined) {
    const destination = destinations.find((candidate) => candidate.id === input.destinationId);
    if (destination === undefined) {
      throw new Error(`Backup destination '${input.destinationId}' is not configured.`);
    }
    if (destination.kind !== "local") {
      throw new Error(`Backup destination '${input.destinationId}' uses '${destination.kind}', but this release only supports local artifact commands.`);
    }
    if (destination.path === undefined) {
      throw new Error(`Backup destination '${input.destinationId}' does not define a local path.`);
    }
    return { id: destination.id, kind: "local", path: resolveConfigPath(root, destination.path) };
  }
  const localDestinations = destinations.filter((destination) => destination.kind === "local" && destination.path !== undefined);
  if (localDestinations.length === 1) {
    const destination = localDestinations[0];
    if (destination !== undefined) {
      return { id: destination.id, kind: "local", path: resolveConfigPath(root, destination.path ?? DEFAULT_BACKUP_OUT_DIR) };
    }
  }
  return { kind: "local", path: path.resolve(root, DEFAULT_BACKUP_OUT_DIR) };
}

async function uniqueBackupPath(destinationPath: string, backupId: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${String(attempt).padStart(3, "0")}`;
    const candidate = path.join(destinationPath, `${backupId}${suffix}`);
    try {
      await fs.lstat(candidate);
      continue;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return candidate;
      }
      throw error;
    }
  }
  throw new Error(`Unable to create unique backup directory for ${backupId}`);
}

async function appendBackupEvent(
  root: string,
  input: {
    type: string;
    actorId: string;
    backupId: string;
    backupDir: string;
    data: Record<string, unknown>;
  },
) {
  return appendEvent(root, {
    type: input.type,
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

function pruneReason(
  backup: WorkspaceBackupEntry,
  index: number,
  now: number,
  retention: { keep_last?: number; keep_days?: number },
): string | undefined {
  const withinKeepLast = retention.keep_last !== undefined && index < retention.keep_last;
  if (withinKeepLast) {
    return undefined;
  }
  const ageReason = retention.keep_days === undefined ? undefined : backupOlderThan(backup, now, retention.keep_days);
  if (retention.keep_last !== undefined && retention.keep_days === undefined) {
    return `older than keep_last=${retention.keep_last}`;
  }
  if (retention.keep_last === undefined && ageReason !== undefined) {
    return ageReason;
  }
  if (retention.keep_last !== undefined && ageReason !== undefined) {
    return `outside keep_last=${retention.keep_last} and ${ageReason}`;
  }
  return undefined;
}

function backupOlderThan(backup: WorkspaceBackupEntry, now: number, keepDays: number): string | undefined {
  const createdAt = backup.created_at === undefined ? Number.NaN : Date.parse(backup.created_at);
  if (!Number.isFinite(createdAt)) {
    return "missing or invalid created_at";
  }
  return now - createdAt > keepDays * DAY_MS ? `older than keep_days=${keepDays}` : undefined;
}

function backupCreatedAtMs(backup: Pick<WorkspaceBackupEntry, "created_at" | "backup_id">): number {
  const parsed = backup.created_at === undefined ? Number.NaN : Date.parse(backup.created_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveConfigPath(root: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(root, trimmed);
}

function assertPathWithinDirectory(parent: string, child: string, context: string): void {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  if (resolvedChild === resolvedParent || !isPathWithin(resolvedChild, resolvedParent)) {
    throw new Error(`Refusing ${context} outside backup destination: ${child}`);
  }
}

function isPathWithin(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isFilesystemRoot(targetRoot: string): boolean {
  return targetRoot === path.parse(targetRoot).root;
}
