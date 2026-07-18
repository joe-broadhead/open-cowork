import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OPENWIKI_REPO_FORMAT,
  OPENWIKI_VERSION,
  atomicWriteFile,
  type OpenWikiStorageConfig,
} from "@openwiki/core";
import { verifyBackupChecksums, writeBackupChecksums } from "./backup-checksums.ts";
import { currentGitCommit, currentGitDirtyState, OPENWIKI_BACKUP_PATHS } from "./git.ts";
import type { WorkspaceBackupManifest } from "./types.ts";

const BACKUP_SCHEMA_VERSION = "openwiki.backup.v1" as const;
export const CHECKSUM_FILE = "checksums.sha256" as const;
export const RESTORE_README_FILE = "restore-readme.txt" as const;

interface WorkspaceBackupArtifactInput {
  root: string;
  workspaceId: string;
  workspaceTitle: string;
  protocolVersion: string;
  repoFormat: string;
  storage?: OpenWikiStorageConfig;
  backupId: string;
  actorId: string;
  createdAt: string;
  stagingDir: string;
  includeGit: boolean;
  counts: WorkspaceBackupManifest["counts"];
}

interface WorkspaceBackupArtifactResult {
  manifest: WorkspaceBackupManifest;
  manifestPath: string;
  checksumsPath: string;
  restoreReadmePath: string;
  checksumFileHash: string;
  files: number;
  bytes: number;
  sourceCommit?: string;
  sourceDirty: boolean | null;
  warnings: string[];
}

export async function buildWorkspaceBackupArtifact(input: WorkspaceBackupArtifactInput): Promise<WorkspaceBackupArtifactResult> {
  const repoDir = path.join(input.stagingDir, "repo");
  await fs.mkdir(repoDir, { recursive: true });

  const excludedPaths: string[] = [];
  const includedPaths: string[] = [];
  const backupPaths = backupPathsForWorkspace(input.root, input.storage, input.includeGit);
  for (const relativePath of backupPaths) {
    const copied = await copyBackupPathIfPresent(input.root, repoDir, relativePath, excludedPaths);
    if (copied) {
      includedPaths.push(relativePath);
    }
  }

  const sourceCommit = await currentGitCommit(input.root).catch(() => undefined);
  const sourceDirty = await currentGitDirtyState(input.root).catch(() => undefined);
  const warnings = backupWarnings(input.storage, includedPaths, excludedPaths);
  const restoreReadmePath = path.join(input.stagingDir, RESTORE_README_FILE);
  await atomicWriteFile(
    restoreReadmePath,
    renderRestoreReadme({
      backupId: input.backupId,
      workspaceTitle: input.workspaceTitle,
      workspaceId: input.workspaceId,
      createdAt: input.createdAt,
      warnings,
    }),
  );

  const payload = await writeBackupChecksums(input.stagingDir, CHECKSUM_FILE, RESTORE_README_FILE);
  const manifest: WorkspaceBackupManifest = {
    schema_version: BACKUP_SCHEMA_VERSION,
    backup_id: input.backupId,
    openwiki_version: OPENWIKI_VERSION,
    workspace_id: input.workspaceId,
    workspace_title: input.workspaceTitle,
    protocol_version: input.protocolVersion,
    repo_format: input.repoFormat,
    created_at: input.createdAt,
    created_by_actor: input.actorId,
    created_on_host: os.hostname(),
    ...(sourceCommit === undefined ? {} : { source_commit: sourceCommit }),
    source_dirty: sourceDirty ?? null,
    included_paths: includedPaths,
    derived_stores: {
      search_index: "excluded",
      sqlite_index: "excluded",
    },
    object_storage: objectStorageSummary(input.storage, includedPaths),
    postgres: {
      included: false,
      warning: "Postgres runtime tables are not bundled in workspace backup artifacts; restore Postgres from database-native backups when enabled.",
    },
    checksum_file: CHECKSUM_FILE,
    checksum_file_hash: payload.checksumFileHash,
    file_count: payload.files,
    byte_count: payload.bytes,
    compatibility: {
      min_openwiki_version: OPENWIKI_VERSION,
      protocol_version: input.protocolVersion,
      repo_format: input.repoFormat,
      requires_checksum_verification: true,
    },
    warnings,
    counts: input.counts,
  };
  const manifestPath = path.join(input.stagingDir, "manifest.json");
  await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return {
    manifest,
    manifestPath,
    checksumsPath: path.join(input.stagingDir, CHECKSUM_FILE),
    restoreReadmePath,
    checksumFileHash: payload.checksumFileHash,
    files: payload.files,
    bytes: payload.bytes,
    ...(sourceCommit === undefined ? {} : { sourceCommit }),
    sourceDirty: sourceDirty ?? null,
    warnings,
  };
}

export async function verifyWorkspaceBackupDirectory(backupDir: string): Promise<{
  manifest: WorkspaceBackupManifest;
  checksumFileHash: string;
  files: number;
  bytes: number;
}> {
  const manifest = await readWorkspaceBackupManifest(backupDir);
  const checksumResult = await verifyBackupChecksums(backupDir, manifest);
  await assertValidBackupContents(backupDir, path.join(backupDir, "repo"), manifest);
  return {
    manifest,
    checksumFileHash: checksumResult.checksumFileHash,
    files: checksumResult.files,
    bytes: checksumResult.bytes,
  };
}

export async function readWorkspaceBackupManifest(backupDir: string): Promise<WorkspaceBackupManifest> {
  const raw = await fs.readFile(path.join(backupDir, "manifest.json"), "utf8");
  return workspaceBackupManifestFromJson(raw, backupDir);
}

export function workspaceBackupManifestFromJson(raw: string, context: string): WorkspaceBackupManifest {
  const parsed = JSON.parse(raw) as Partial<WorkspaceBackupManifest>;
  if (parsed.schema_version !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`Unsupported OpenWiki backup manifest schema: ${String(parsed.schema_version)}`);
  }
  if (
    !parsed.backup_id ||
    !parsed.openwiki_version ||
    !parsed.workspace_id ||
    !parsed.workspace_title ||
    !parsed.protocol_version ||
    !parsed.repo_format ||
    !parsed.created_at ||
    !parsed.created_by_actor ||
    !parsed.created_on_host ||
    !Array.isArray(parsed.included_paths) ||
    parsed.checksum_file !== CHECKSUM_FILE ||
    typeof parsed.checksum_file_hash !== "string" ||
    typeof parsed.file_count !== "number" ||
    typeof parsed.byte_count !== "number" ||
    parsed.compatibility?.requires_checksum_verification !== true
  ) {
    throw new Error(`Invalid OpenWiki backup manifest in ${context}`);
  }
  for (const relativePath of parsed.included_paths) {
    normalizeBackupRelativePath(relativePath);
  }
  return parsed as WorkspaceBackupManifest;
}

async function assertValidBackupContents(
  backupDir: string,
  repoDir: string,
  manifest: WorkspaceBackupManifest,
): Promise<void> {
  const configPath = path.join(repoDir, "openwiki.json");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Backup ${backupDir} does not contain repo/openwiki.json`);
    }
    throw new Error(`Backup ${backupDir} contains invalid repo/openwiki.json`);
  }
  if (
    parsed.protocol_version !== manifest.protocol_version ||
    parsed.repo_format !== manifest.repo_format ||
    parsed.repo_format !== OPENWIKI_REPO_FORMAT ||
    parsed.workspace_id !== manifest.workspace_id
  ) {
    throw new Error(`Backup ${backupDir} contains incompatible repo/openwiki.json`);
  }
  const missingPaths: string[] = [];
  for (const relativePath of manifest.included_paths) {
    const normalized = normalizeBackupRelativePath(relativePath);
    if (!(await pathExists(path.join(repoDir, normalized)))) {
      missingPaths.push(normalized);
    }
  }
  if (missingPaths.length > 0) {
    throw new Error(`Backup ${backupDir} is missing declared paths: ${missingPaths.join(", ")}`);
  }
}

export function normalizeBackupRelativePath(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, "/").trim());
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.isAbsolute(relativePath)) {
    throw new Error(`Invalid backup relative path: ${relativePath}`);
  }
  return normalized;
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function backupPathsForWorkspace(root: string, storage: OpenWikiStorageConfig | undefined, includeGit: boolean): string[] {
  const paths = includeGit ? [...OPENWIKI_BACKUP_PATHS] : OPENWIKI_BACKUP_PATHS.filter((entry) => entry !== ".git");
  const storageBackend = storage?.backend ?? "local";
  const localPath = storage?.local_path ?? ".openwiki/objects";
  if (storageBackend === "local" && localPath !== ".openwiki/objects") {
    if (path.isAbsolute(localPath)) {
      return paths;
    }
    const normalized = normalizeBackupRelativePath(localPath);
    const resolved = path.resolve(root, normalized);
    if (resolved !== path.parse(resolved).root && isPathWithin(resolved, root) && !paths.includes(normalized)) {
      paths.push(normalized);
    }
  }
  return paths;
}

function backupWarnings(
  storage: OpenWikiStorageConfig | undefined,
  includedPaths: string[],
  excludedPaths: string[],
): string[] {
  const warnings: string[] = [];
  const objectStorage = objectStorageSummary(storage, includedPaths);
  if (!objectStorage.restore_complete_from_git && objectStorage.warning !== undefined) {
    warnings.push(objectStorage.warning);
  }
  if (excludedPaths.length > 0) {
    warnings.push(`Excluded local, generated, or secret-like files from backup artifact: ${excludedPaths.sort().join(", ")}`);
  }
  return warnings;
}

function objectStorageSummary(
  storage: OpenWikiStorageConfig | undefined,
  includedPaths: string[],
): WorkspaceBackupManifest["object_storage"] {
  const mode = storage?.backend ?? "local";
  const localPath = storage?.local_path ?? ".openwiki/objects";
  const normalizedLocalPath = localPath.startsWith("/") ? localPath : normalizeBackupRelativePath(localPath);
  const externalObjectsIncluded = mode === "local" && includedPaths.includes(normalizedLocalPath);
  if (externalObjectsIncluded) {
    return { mode, external_objects_included: true, restore_complete_from_git: true };
  }
  if (mode === "local" && localPath === ".openwiki/objects") {
    return { mode, external_objects_included: false, restore_complete_from_git: true };
  }
  return {
    mode,
    external_objects_included: false,
    restore_complete_from_git: mode === "local" ? includedPaths.includes(".openwiki/objects") : false,
    warning: "External or custom object storage is not bundled in this artifact; restore the object store separately before treating the workspace as complete.",
  };
}

async function copyBackupPathIfPresent(root: string, repoDir: string, relativePath: string, excludedPaths: string[]): Promise<boolean> {
  const normalized = normalizeBackupRelativePath(relativePath);
  const sourcePath = path.join(root, normalized);
  if (!(await pathExists(sourcePath))) {
    return false;
  }
  const targetPath = path.join(repoDir, normalized);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.cp(sourcePath, targetPath, {
    recursive: true,
    force: true,
    filter: (source) => {
      const relative = toPosixRelative(root, source);
      if (isExcludedBackupPath(relative)) {
        excludedPaths.push(relative);
        return false;
      }
      return true;
    },
  });
  return true;
}

function renderRestoreReadme(input: {
  backupId: string;
  workspaceTitle: string;
  workspaceId: string;
  createdAt: string;
  warnings: string[];
}): string {
  return [
    `OpenWiki backup: ${input.backupId}`,
    `Workspace: ${input.workspaceTitle} (${input.workspaceId})`,
    `Created: ${input.createdAt}`,
    "",
    "Verify this artifact before restore:",
    "",
    "  openwiki backup verify latest --destination <destination-id> --json",
    "",
    "Restore into a new path first, then lint and rebuild derived stores:",
    "",
    "  openwiki backup restore <backup-id-or-path> --target-root /tmp/openwiki-restore --json",
    "  openwiki --root /tmp/openwiki-restore run lint --json",
    "  openwiki --root /tmp/openwiki-restore index --json",
    "",
    "Secrets, local environment files, and raw credentials are intentionally not included.",
    ...(input.warnings.length === 0 ? [] : ["", "Warnings:", ...input.warnings.map((warning) => `- ${warning}`)]),
    "",
  ].join("\n");
}

function toPosixRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function isExcludedBackupPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const base = path.posix.basename(normalized);
  return (
    isGeneratedAgentRuntimePath(normalized) ||
    normalized === ".git/config" ||
    normalized === ".git/config.worktree" ||
    normalized === ".git/credentials" ||
    base === ".env" ||
    base.startsWith(".env.") ||
    base === "id_rsa" ||
    base === "id_ed25519" ||
    base.endsWith(".pem") ||
    base.endsWith(".key")
  );
}

function isGeneratedAgentRuntimePath(normalizedPath: string): boolean {
  return (
    normalizedPath === ".opencode/node_modules" ||
    normalizedPath.startsWith(".opencode/node_modules/") ||
    normalizedPath === ".opencode/package-lock.json" ||
    normalizedPath === ".opencode/package.json" ||
    normalizedPath === ".opencode/.gitignore"
  );
}

function isPathWithin(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
