import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "@openwiki/core";
import type { WorkspaceBackupManifest } from "./types.ts";

interface BackupChecksumSummary {
  checksumFileHash: string;
  files: number;
  bytes: number;
}

export async function writeBackupChecksums(
  backupDir: string,
  checksumFile: string,
  restoreReadmeFile: string,
): Promise<BackupChecksumSummary> {
  const entries = await backupPayloadFiles(backupDir, restoreReadmeFile);
  const lines: string[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const hash = await sha256File(entry.absolutePath);
    const stat = await fs.stat(entry.absolutePath);
    bytes += stat.size;
    lines.push(`${hash}  ${entry.relativePath}`);
  }
  const checksumsPath = path.join(backupDir, checksumFile);
  await atomicWriteFile(checksumsPath, `${lines.join("\n")}\n`);
  return { checksumFileHash: await sha256File(checksumsPath), files: entries.length, bytes };
}

export async function verifyBackupChecksums(
  backupDir: string,
  manifest: WorkspaceBackupManifest,
): Promise<BackupChecksumSummary> {
  const checksumsPath = path.join(backupDir, manifest.checksum_file);
  const checksumFileHash = await sha256File(checksumsPath);
  if (checksumFileHash !== manifest.checksum_file_hash) {
    throw new Error(`Backup ${backupDir} checksum file hash does not match manifest`);
  }
  const declared = parseChecksumFile(await fs.readFile(checksumsPath, "utf8"), manifest.checksum_file);
  const actualFiles = await backupPayloadFiles(backupDir, "restore-readme.txt");
  const actualPaths = new Set(actualFiles.map((entry) => entry.relativePath));
  const declaredPaths = new Set(declared.map((entry) => entry.relativePath));
  const missingDeclarations = actualFiles.filter((entry) => !declaredPaths.has(entry.relativePath)).map((entry) => entry.relativePath);
  const missingPayload = declared.filter((entry) => !actualPaths.has(entry.relativePath)).map((entry) => entry.relativePath);
  if (missingDeclarations.length > 0) {
    throw new Error(`Backup ${backupDir} has payload files missing from checksums: ${missingDeclarations.join(", ")}`);
  }
  if (missingPayload.length > 0) {
    throw new Error(`Backup ${backupDir} is missing checksummed files: ${missingPayload.join(", ")}`);
  }
  let bytes = 0;
  for (const entry of declared) {
    const absolutePath = safeBackupPayloadPath(backupDir, entry.relativePath, manifest.checksum_file);
    const hash = await sha256File(absolutePath);
    if (hash !== entry.hash) {
      throw new Error(`Backup ${backupDir} checksum mismatch for ${entry.relativePath}`);
    }
    bytes += (await fs.stat(absolutePath)).size;
  }
  return { checksumFileHash, files: declared.length, bytes };
}

async function backupPayloadFiles(backupDir: string, restoreReadmeFile: string): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const files: Array<{ absolutePath: string; relativePath: string }> = [];
  const repoDir = path.join(backupDir, "repo");
  if (await pathExists(repoDir)) {
    await collectFiles(repoDir, backupDir, files);
  }
  const readmePath = path.join(backupDir, restoreReadmeFile);
  if (await pathExists(readmePath)) {
    files.push({ absolutePath: readmePath, relativePath: restoreReadmeFile });
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function collectFiles(
  currentPath: string,
  backupDir: string,
  files: Array<{ absolutePath: string; relativePath: string }>,
): Promise<void> {
  const stat = await fs.lstat(currentPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to include symbolic link in backup artifact: ${toPosixRelative(backupDir, currentPath)}`);
  }
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(currentPath)) {
      await collectFiles(path.join(currentPath, entry), backupDir, files);
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to include non-file backup payload entry: ${toPosixRelative(backupDir, currentPath)}`);
  }
  const relativePath = toPosixRelative(backupDir, currentPath);
  if (relativePath.includes("\n") || relativePath.includes("\r")) {
    throw new Error(`Backup payload path contains a line break: ${relativePath}`);
  }
  files.push({ absolutePath: currentPath, relativePath });
}

function parseChecksumFile(raw: string, checksumFile: string): Array<{ hash: string; relativePath: string }> {
  const entries: Array<{ hash: string; relativePath: string }> = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      throw new Error(`Invalid backup checksum line: ${line}`);
    }
    entries.push({ hash: match[1], relativePath: normalizeBackupPayloadPath(match[2], checksumFile) });
  }
  return entries;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

function safeBackupPayloadPath(backupDir: string, relativePath: string, checksumFile: string): string {
  const normalized = normalizeBackupPayloadPath(relativePath, checksumFile);
  const resolved = path.resolve(backupDir, normalized);
  if (resolved !== backupDir && !isPathWithin(resolved, backupDir)) {
    throw new Error(`Invalid backup payload path: ${relativePath}`);
  }
  return resolved;
}

function normalizeBackupPayloadPath(relativePath: string, checksumFile: string): string {
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, "/").trim());
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.isAbsolute(relativePath) ||
    normalized === "manifest.json" ||
    normalized === checksumFile
  ) {
    throw new Error(`Invalid backup payload path: ${relativePath}`);
  }
  return normalized;
}

function isPathWithin(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toPosixRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}
