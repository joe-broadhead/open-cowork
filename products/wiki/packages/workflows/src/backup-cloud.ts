import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cloudBackupObjectUri,
  createCloudBackupDestination,
  assertBackupObjectListConfinedToPrefix,
  putVerifiedCloudBackupObject,
  type CloudBackupDestinationAdapter,
} from "@openwiki/storage";
import type { OpenWikiBackupConfig, OpenWikiBackupDestinationConfig } from "@openwiki/core";
import {
  CHECKSUM_FILE,
  normalizeBackupRelativePath,
  RESTORE_README_FILE,
  workspaceBackupManifestFromJson,
} from "./backup-artifact.ts";
import type { WorkspaceBackupDestinationSummary, WorkspaceBackupEntry } from "./types.ts";

const CLOUD_BACKUP_KINDS = new Set(["s3", "minio", "gcs", "rclone"]);

export interface CloudBackupDestinationHandle {
  config: OpenWikiBackupDestinationConfig;
  destination: WorkspaceBackupDestinationSummary;
  adapter: CloudBackupDestinationAdapter;
  basePrefix: string;
}

interface CloudBackupCommitResult {
  backupDir: string;
  manifestPath: string;
  checksumsPath: string;
  restoreReadmePath: string;
}

interface MaterializedCloudBackup {
  backupDir: string;
  localDir: string;
  cleanup(): Promise<void>;
}

export function resolveCloudBackupDestination(
  workspaceId: string,
  config: OpenWikiBackupConfig | undefined,
  input: { outDir?: string; destinationId?: string },
): CloudBackupDestinationHandle | undefined {
  if (input.outDir !== undefined) {
    return undefined;
  }
  const destinations = config?.destinations ?? [];
  if (input.destinationId === undefined) {
    return undefined;
  }
  const destination = destinations.find((candidate) => candidate.id === input.destinationId);
  if (destination === undefined || !CLOUD_BACKUP_KINDS.has(destination.kind)) {
    return undefined;
  }
  const adapter = createCloudBackupDestination(destination);
  const basePrefix = backupBasePrefix(destination.prefix, workspaceId);
  return {
    config: destination,
    adapter,
    basePrefix,
    destination: summarizeCloudDestination(destination, basePrefix),
  };
}

export function isCloudBackupReference(value: string): boolean {
  return value.startsWith("s3://") || value.startsWith("gs://") || value.startsWith("rclone://");
}

export async function uniqueCloudBackupId(handle: CloudBackupDestinationHandle, backupId: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
    const suffix = attempt === 0 ? `-${nonce}` : `-${nonce}-${String(attempt).padStart(3, "0")}`;
    const candidate = `${backupId}${suffix}`;
    const manifestKey = cloudBackupKey(handle, candidate, "manifest.json");
    const existing = await handle.adapter.listObjects(manifestKey);
    if (!existing.some((object) => object.key === manifestKey)) {
      return candidate;
    }
  }
  throw new Error(`Unable to create unique cloud backup id for ${backupId}`);
}

export async function uploadCloudBackupArtifact(
  handle: CloudBackupDestinationHandle,
  stagingDir: string,
  backupId: string,
): Promise<CloudBackupCommitResult> {
  const files = await listFiles(stagingDir);
  const manifestFile = path.join(stagingDir, "manifest.json");
  const payloadFiles = files.filter((file) => file !== manifestFile);
  for (const file of payloadFiles) {
    await uploadFile(handle, stagingDir, backupId, file);
  }
  await uploadFile(handle, stagingDir, backupId, manifestFile);
  await assertUploadedObjectMatches(handle, stagingDir, backupId, "manifest.json");
  await assertUploadedObjectMatches(handle, stagingDir, backupId, CHECKSUM_FILE);
  return {
    backupDir: cloudBackupObjectUri(handle.config, cloudBackupKey(handle, backupId, "")),
    manifestPath: cloudBackupObjectUri(handle.config, cloudBackupKey(handle, backupId, "manifest.json")),
    checksumsPath: cloudBackupObjectUri(handle.config, cloudBackupKey(handle, backupId, CHECKSUM_FILE)),
    restoreReadmePath: cloudBackupObjectUri(handle.config, cloudBackupKey(handle, backupId, RESTORE_README_FILE)),
  };
}

export async function listCloudBackups(handle: CloudBackupDestinationHandle): Promise<WorkspaceBackupEntry[]> {
  const base = `${handle.basePrefix}/`;
  const objects = await handle.adapter.listObjects(base);
  assertBackupObjectListConfinedToPrefix(objects, base);
  const candidates = new Set<string>();
  for (const object of objects) {
    const relative = object.key.startsWith(base) ? object.key.slice(base.length) : "";
    const [backupId] = relative.split("/");
    if (backupId?.startsWith("openwiki-backup-")) {
      candidates.add(backupId);
    }
  }
  const backups: WorkspaceBackupEntry[] = [];
  for (const backupId of [...candidates].sort()) {
    const backupDir = cloudBackupObjectUri(handle.config, cloudBackupKey(handle, backupId, ""));
    const manifestKey = cloudBackupKey(handle, backupId, "manifest.json");
    const checksumKey = cloudBackupKey(handle, backupId, CHECKSUM_FILE);
    const manifestPath = cloudBackupObjectUri(handle.config, manifestKey);
    try {
      const manifest = workspaceBackupManifestFromJson((await handle.adapter.getObject(manifestKey)).toString("utf8"), backupDir);
      const checksumFile = await handle.adapter.getObject(checksumKey);
      const checksumFileHash = sha256Hex(checksumFile);
      if (checksumFileHash !== manifest.checksum_file_hash) {
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
        backup_id: backupId,
        backup_dir: backupDir,
        manifest_path: manifestPath,
        status: "invalid",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return backups.sort((left, right) => backupCreatedAtMs(right) - backupCreatedAtMs(left));
}

export async function materializeCloudBackup(
  handle: CloudBackupDestinationHandle,
  backupReference: string,
): Promise<MaterializedCloudBackup> {
  const backupId = backupIdFromCloudReference(backupReference);
  const prefix = `${handle.basePrefix}/${backupId}/`;
  const localDir = await fs.mkdtemp(path.join(os.tmpdir(), "openwiki-cloud-backup-"));
  try {
    const objects = await handle.adapter.listObjects(prefix);
    assertBackupObjectListConfinedToPrefix(objects, prefix);
    if (objects.length === 0) {
      throw new Error(`Cloud backup '${backupReference}' was not found.`);
    }
    for (const object of objects) {
      const relative = object.key.slice(prefix.length);
      if (!relative) {
        continue;
      }
      const normalized = normalizeBackupRelativePath(relative);
      const target = path.join(localDir, normalized);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, await handle.adapter.getObject(object.key));
    }
    const manifest = workspaceBackupManifestFromJson(await fs.readFile(path.join(localDir, "manifest.json"), "utf8"), localDir);
    for (const relativePath of manifest.included_paths) {
      if (isDirectoryIncludedPath(relativePath)) {
        await fs.mkdir(path.join(localDir, "repo", normalizeBackupRelativePath(relativePath)), { recursive: true });
      }
    }
    return {
      backupDir: backupReference,
      localDir,
      cleanup: () => fs.rm(localDir, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(localDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function deleteCloudBackup(handle: CloudBackupDestinationHandle, backup: WorkspaceBackupEntry): Promise<void> {
  const backupId = backupIdFromCloudReference(backup.backup_dir);
  await handle.adapter.deletePrefix(`${handle.basePrefix}/${backupId}/`);
}

function summarizeCloudDestination(
  destination: OpenWikiBackupDestinationConfig,
  basePrefix: string,
): WorkspaceBackupDestinationSummary {
  return {
    id: destination.id,
    kind: destination.kind as WorkspaceBackupDestinationSummary["kind"],
    uri: cloudBackupObjectUri(destination, basePrefix),
    ...(destination.bucket === undefined ? {} : { bucket: destination.bucket }),
    ...(destination.remote === undefined ? {} : { remote: destination.remote }),
    prefix: basePrefix,
    ...(destination.endpoint_url === undefined ? {} : { endpoint_url: destination.endpoint_url }),
    ...(destination.region === undefined ? {} : { region: destination.region }),
  };
}

function backupBasePrefix(prefix: string | undefined, workspaceId: string): string {
  const base = safePrefix(prefix ?? "openwiki-backups");
  return `${base}/${safePathSegment(workspaceId)}`;
}

function cloudBackupKey(handle: CloudBackupDestinationHandle, backupId: string, relativePath: string): string {
  const base = `${handle.basePrefix}/${safePathSegment(backupId)}`;
  const relative = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return relative ? `${base}/${normalizeBackupRelativePath(relative)}` : base;
}

async function uploadFile(
  handle: CloudBackupDestinationHandle,
  stagingDir: string,
  backupId: string,
  filePath: string,
): Promise<void> {
  const relative = path.relative(stagingDir, filePath).split(path.sep).join("/");
  await putVerifiedCloudBackupObject(handle.adapter, {
    key: cloudBackupKey(handle, backupId, relative),
    data: await fs.readFile(filePath),
    contentType: contentTypeForPath(relative),
  });
}

async function assertUploadedObjectMatches(
  handle: CloudBackupDestinationHandle,
  stagingDir: string,
  backupId: string,
  relativePath: string,
): Promise<void> {
  const local = await fs.readFile(path.join(stagingDir, relativePath));
  const remote = await handle.adapter.getObject(cloudBackupKey(handle, backupId, relativePath));
  if (!local.equals(remote)) {
    throw new Error(`Cloud backup upload verification failed for ${relativePath}.`);
  }
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return listFiles(filePath);
    }
    return entry.isFile() ? [filePath] : [];
  }));
  return nested.flat();
}

function backupIdFromCloudReference(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/g, "");
  const backupId = normalized.split("/").pop();
  if (backupId === undefined || !backupId.startsWith("openwiki-backup-")) {
    throw new Error(`Invalid cloud backup reference: ${value}`);
  }
  return backupId;
}

function contentTypeForPath(relativePath: string): string {
  if (relativePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (relativePath.endsWith(".txt") || relativePath.endsWith(".sha256") || relativePath.endsWith(".md")) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}

function isDirectoryIncludedPath(relativePath: string): boolean {
  return relativePath !== ".gitignore" && relativePath !== "openwiki.json";
}

function safePrefix(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.split("/").some((part) => part === "." || part === ".." || part === "")) {
    throw new Error(`Invalid backup destination prefix: ${value}`);
  }
  return normalized.split("/").map(safePathSegment).join("/");
}

function safePathSegment(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!cleaned) {
    throw new Error(`Invalid backup path segment: ${value}`);
  }
  return cleaned;
}

function backupCreatedAtMs(backup: Pick<WorkspaceBackupEntry, "created_at" | "backup_id">): number {
  const parsed = backup.created_at === undefined ? Number.NaN : Date.parse(backup.created_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
