import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { atomicWriteFile, isoNow, type PageRecord } from "@openwiki/core";
import { markRepositoryChanged } from "./cache.ts";
import { yamlScalar } from "./frontmatter.ts";
import type { ProposalTextArtifact } from "./types.ts";

type FileHandle = Awaited<ReturnType<typeof fs.open>>;

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

interface OpenRepoFileForReadResult {
  path: string;
  stats: Stats;
  handle: FileHandle;
}

interface WorkspaceFileLockMetadata {
  pid: number;
  hostname: string;
  token: string;
  created_at: string;
  heartbeat_at: string;
}

const WORKSPACE_FILE_LOCK_TIMEOUT_MS = 30000;
const WORKSPACE_FILE_LOCK_HEARTBEAT_MS = 5000;

export function renderPageMarkdown(page: PageRecord): string {
  const lines = [
    "---",
    `id: ${page.id}`,
    `type: ${page.page_type}`,
    `title: ${yamlScalar(page.title)}`,
    `summary: ${yamlScalar(page.summary ?? "")}`,
    `status: ${page.status}`,
    "topics:",
    ...page.topics.map((topic) => `  - ${yamlScalar(topic)}`),
    "source_ids:",
    ...page.source_ids.map((sourceId) => `  - ${sourceId}`),
    "claim_ids:",
    ...page.claim_ids.map((claimId) => `  - ${claimId}`),
    `created_at: ${page.created_at}`,
    `updated_at: ${page.updated_at}`,
    "---",
    "",
    page.body.trim(),
    "",
  ];
  return `${lines.join("\n")}`;
}

export function normalizeRepoPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export async function readOptionalTextArtifact(root: string, repoPath: string): Promise<ProposalTextArtifact | undefined> {
  const body = await readRepoTextFileIfExists(root, repoPath);
  if (body === undefined) {
    return undefined;
  }
  return {
    path: repoPath,
    body,
  };
}

export function safeRepoPath(root: string, repoPath: string): string {
  if (path.isAbsolute(repoPath)) {
    throw new Error(`Path escapes OpenWiki workspace: ${repoPath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, repoPath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes OpenWiki workspace: ${repoPath}`);
  }
  return resolvedPath;
}

export async function openRepoFileForRead(root: string, repoPath: string): Promise<OpenRepoFileForReadResult | undefined> {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = safeRepoPath(resolvedRoot, repoPath);
  const status = await assertRepoPathHasNoSymlinkComponents(resolvedRoot, resolvedPath, repoPath);
  if (status === "missing") {
    return undefined;
  }

  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile()) {
      await handle.close();
      return undefined;
    }
    await assertRealPathInsideRepo(resolvedRoot, resolvedPath, repoPath);
    return { path: resolvedPath, stats, handle };
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function readRepoTextFileIfExists(root: string, repoPath: string): Promise<string | undefined> {
  const opened = await openRepoFileForRead(root, repoPath);
  if (opened === undefined) {
    return undefined;
  }
  try {
    return await opened.handle.readFile("utf8");
  } finally {
    await opened.handle.close();
  }
}

export async function listRepoFiles(root: string, repoPath: string): Promise<string[]> {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = safeRepoPath(resolvedRoot, repoPath);
  const status = await assertRepoPathHasNoSymlinkComponents(resolvedRoot, resolvedPath, repoPath);
  if (status === "missing") {
    return [];
  }
  const stats = await fs.lstat(resolvedPath);
  if (!stats.isDirectory()) {
    return [];
  }
  await assertRealPathInsideRepo(resolvedRoot, resolvedPath, repoPath);
  return listFiles(resolvedPath);
}

export async function appendRepoTextFile(root: string, repoPath: string, body: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = safeRepoPath(resolvedRoot, repoPath);
  const parentPath = path.dirname(resolvedPath);
  const parentIdentity = await ensureRepoDirectory(resolvedRoot, parentPath, repoPath);
  const existingTarget = await fs.lstat(resolvedPath).catch((error: unknown) => {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  });
  if (existingTarget?.isSymbolicLink()) {
    throw new Error(`OpenWiki repo path must not include symbolic links: ${repoPath}`);
  }

  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(
      resolvedPath,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o666,
    );
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`OpenWiki repo path is not a file: ${repoPath}`);
    }
    await assertDirectoryIdentity(parentPath, parentIdentity, repoPath);
    await assertRealPathInsideRepo(resolvedRoot, resolvedPath, repoPath);
    await handle.writeFile(body);
    await assertDirectoryIdentity(parentPath, parentIdentity, repoPath);
    markRepositoryChanged(resolvedRoot);
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
  }
}

export async function writeRepoTextFile(root: string, repoPath: string, body: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = safeRepoPath(resolvedRoot, repoPath);
  const parentPath = path.dirname(resolvedPath);
  const parentIdentity = await ensureRepoDirectory(resolvedRoot, parentPath, repoPath);
  const existingTarget = await fs.lstat(resolvedPath).catch((error: unknown) => {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  });
  if (existingTarget?.isSymbolicLink()) {
    throw new Error(`OpenWiki repo path must not include symbolic links: ${repoPath}`);
  }
  if (existingTarget !== undefined && !existingTarget.isFile()) {
    throw new Error(`OpenWiki repo path is not a file: ${repoPath}`);
  }
  await assertDirectoryIdentity(parentPath, parentIdentity, repoPath);
  await atomicWriteFile(resolvedPath, body);
  await assertDirectoryIdentity(parentPath, parentIdentity, repoPath);
  await assertRealPathInsideRepo(resolvedRoot, resolvedPath, repoPath);
  markRepositoryChanged(resolvedRoot);
}

async function ensureRepoDirectory(resolvedRoot: string, directoryPath: string, repoPath: string): Promise<DirectoryIdentity> {
  const relativePath = path.relative(resolvedRoot, directoryPath);
  if (!relativePath || relativePath === ".") {
    const stats = await fs.lstat(resolvedRoot);
    return directoryIdentity(stats);
  }
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Path escapes OpenWiki workspace: ${repoPath}`);
  }

  let currentPath = resolvedRoot;
  for (const part of relativePath.split(path.sep)) {
    currentPath = path.join(currentPath, part);
    let stats: Stats | undefined;
    try {
      stats = await fs.lstat(currentPath);
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
      await fs.mkdir(currentPath, { mode: 0o777 });
      stats = await fs.lstat(currentPath);
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`OpenWiki repo path must not include symbolic links: ${repoPath}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`OpenWiki repo parent path is not a directory: ${repoPath}`);
    }
  }
  await assertRealPathInsideRepo(resolvedRoot, directoryPath, repoPath);
  return directoryIdentity(await fs.lstat(directoryPath));
}

async function assertDirectoryIdentity(directoryPath: string, expected: DirectoryIdentity, repoPath: string): Promise<void> {
  const stats = await fs.lstat(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`OpenWiki repo parent path changed during write: ${repoPath}`);
  }
  const actual = directoryIdentity(stats);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`OpenWiki repo parent path changed during write: ${repoPath}`);
  }
}

function directoryIdentity(stats: Stats): DirectoryIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

async function assertRepoPathHasNoSymlinkComponents(
  resolvedRoot: string,
  resolvedPath: string,
  repoPath: string,
): Promise<"ok" | "missing"> {
  const relativePath = path.relative(resolvedRoot, resolvedPath);
  if (!relativePath || relativePath === ".") {
    return "ok";
  }
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Path escapes OpenWiki workspace: ${repoPath}`);
  }

  let currentPath = resolvedRoot;
  for (const part of relativePath.split(path.sep)) {
    currentPath = path.join(currentPath, part);
    let stats: Stats;
    try {
      stats = await fs.lstat(currentPath);
    } catch (error) {
      if (isMissingFileError(error)) {
        return "missing";
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`OpenWiki repo path must not include symbolic links: ${repoPath}`);
    }
  }
  return "ok";
}

async function assertRealPathInsideRepo(resolvedRoot: string, resolvedPath: string, repoPath: string): Promise<void> {
  const realRoot = await fs.realpath(resolvedRoot);
  const realPath = await fs.realpath(resolvedPath);
  if (realPath !== realRoot && !realPath.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`Path escapes OpenWiki workspace: ${repoPath}`);
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

export async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return listFiles(entryPath);
      }
      if (entry.isFile()) {
        return [entryPath];
      }
      return [];
    }),
  );
  return files.flat();
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function withWorkspaceFileLock<T>(root: string, lockName: string, callback: () => Promise<T>): Promise<T> {
  const lockDir = path.join(root, ".openwiki", "locks");
  const lockPath = path.join(lockDir, `${safeLockName(lockName)}.lock`);
  const deadline = Date.now() + WORKSPACE_FILE_LOCK_TIMEOUT_MS;
  await fs.mkdir(lockDir, { recursive: true });

  while (true) {
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let metadata: WorkspaceFileLockMetadata | undefined;
    try {
      handle = await fs.open(lockPath, "wx");
      metadata = createWorkspaceFileLockMetadata();
      await writeWorkspaceFileLockMetadata(lockPath, metadata);
      heartbeat = setInterval(() => {
        if (metadata === undefined) {
          return;
        }
        metadata.heartbeat_at = isoNow();
        void writeWorkspaceFileLockMetadata(lockPath, metadata).catch(() => undefined);
      }, WORKSPACE_FILE_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      try {
        return await callback();
      } finally {
        if (heartbeat !== undefined) {
          clearInterval(heartbeat);
        }
        await handle.close();
        await removeOwnedWorkspaceFileLock(lockPath, metadata.token);
      }
    } catch (error) {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
      }
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (!isFileExistsError(error)) {
        if (handle !== undefined) {
          if (metadata !== undefined) {
            await removeOwnedWorkspaceFileLock(lockPath, metadata.token).catch(() => undefined);
          } else {
            await fs.rm(lockPath, { force: true }).catch(() => undefined);
          }
        }
        throw error;
      }
      if (Date.now() > deadline) {
        const recovered = await recoverStaleWorkspaceFileLock(lockPath);
        if (recovered) {
          continue;
        }
        const stats = await fs.stat(lockPath).catch(() => undefined);
        if (stats !== undefined && Date.now() - stats.mtimeMs > WORKSPACE_FILE_LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for stale OpenWiki workspace file lock: ${lockName}`);
        }
        throw new Error(`Timed out waiting for OpenWiki workspace file lock: ${lockName}`);
      }
      await sleepMs(25);
    }
  }
}

function createWorkspaceFileLockMetadata(): WorkspaceFileLockMetadata {
  const now = isoNow();
  return {
    pid: process.pid,
    hostname: hostname(),
    token: randomUUID(),
    created_at: now,
    heartbeat_at: now,
  };
}

async function writeWorkspaceFileLockMetadata(lockPath: string, metadata: WorkspaceFileLockMetadata): Promise<void> {
  await fs.writeFile(lockPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
}

async function recoverStaleWorkspaceFileLock(lockPath: string): Promise<boolean> {
  const before = await fs.lstat(lockPath).catch((error: unknown) => {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  });
  if (before === undefined || before.isSymbolicLink() || !before.isFile()) {
    return false;
  }
  const body = await fs.readFile(lockPath, "utf8").catch((error: unknown) => {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  });
  if (body === undefined) {
    return false;
  }
  const metadata = parseWorkspaceFileLockMetadata(body);
  if (metadata === undefined || metadata.hostname !== hostname()) {
    return false;
  }
  const heartbeatTime = Date.parse(metadata.heartbeat_at);
  if (!Number.isFinite(heartbeatTime) || Date.now() - heartbeatTime <= WORKSPACE_FILE_LOCK_TIMEOUT_MS) {
    return false;
  }
  if (isProcessAlive(metadata.pid)) {
    return false;
  }
  const current = await fs.lstat(lockPath).catch((error: unknown) => {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  });
  if (current === undefined || current.dev !== before.dev || current.ino !== before.ino || current.mtimeMs !== before.mtimeMs || current.size !== before.size) {
    return false;
  }
  await fs.rm(lockPath, { force: true });
  return true;
}

function parseWorkspaceFileLockMetadata(body: string): WorkspaceFileLockMetadata | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Partial<WorkspaceFileLockMetadata>;
  if (
    typeof record.pid !== "number" ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.hostname !== "string" ||
    typeof record.token !== "string" ||
    typeof record.created_at !== "string" ||
    typeof record.heartbeat_at !== "string"
  ) {
    return undefined;
  }
  return {
    pid: record.pid,
    hostname: record.hostname,
    token: record.token,
    created_at: record.created_at,
    heartbeat_at: record.heartbeat_at,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
    return code !== "ESRCH";
  }
}

async function removeOwnedWorkspaceFileLock(lockPath: string, token: string): Promise<void> {
  const body = await fs.readFile(lockPath, "utf8").catch((error: unknown) => {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  });
  const metadata = body === undefined ? undefined : parseWorkspaceFileLockMetadata(body);
  if (metadata?.token === token) {
    await fs.rm(lockPath, { force: true });
  }
}

function safeLockName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-") || "workspace";
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function nextDailySequence(ids: string[], kind: "comment" | "event" | "run" | "inbox", iso: string): number {
  const prefix = `${kind}:${iso.slice(0, 10)}-`;
  const numbers = ids
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter((value) => Number.isInteger(value));
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

export function dateSequenceId(kind: "source" | "claim" | "comment" | "event" | "run" | "inbox", iso: string, sequence: number): string {
  const date = iso.slice(0, 10);
  return `${kind}:${date}-${String(sequence).padStart(3, "0")}`;
}

export function titleFromPath(repoPath: string): string {
  const base = path.basename(repoPath, path.extname(repoPath));
  return base
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

export function inferPageType(repoPath: string): string {
  const firstSegment = repoPath.split("/")[1] ?? "reference";
  return firstSegment.endsWith("s") ? firstSegment.slice(0, -1) : firstSegment;
}

export function stringValue(value: unknown, fallback?: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error("Expected non-empty string value");
}

export function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(String).filter(Boolean);
}

export function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function stringMetadata(value: Record<string, unknown>, key: string): string | undefined {
  const entry = value[key];
  return typeof entry === "string" && entry.trim() ? entry : undefined;
}

export function parseEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

export function verifySha256(buffer: Buffer, expectedHash: string): boolean | undefined {
  if (!expectedHash.startsWith("sha256:")) {
    return undefined;
  }
  return createHash("sha256").update(buffer).digest("hex") === expectedHash.slice("sha256:".length);
}
