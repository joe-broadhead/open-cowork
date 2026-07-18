import { promises as fs } from "node:fs";
import path from "node:path";
import { type ValidationReport, atomicWriteFile, validationReportFromUnknown } from "@openwiki/core";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readValidationReport(root: string, reportPath: string | undefined): Promise<ValidationReport | null> {
  if (!reportPath) {
    return null;
  }
  try {
    const raw = await fs.readFile(await safeExistingRepoPath(root, reportPath), "utf8");
    return validationReportFromUnknown(JSON.parse(raw) as unknown, reportPath);
  } catch {
    return null;
  }
}

export async function writeText(root: string, relativePath: string, content: string): Promise<void> {
  const target = await safeRepoWritePath(root, relativePath);
  await atomicWriteFile(target, content);
}

export function safeRepoPath(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes OpenWiki root: ${relativePath}`);
  }
  return resolved;
}

export async function safeExistingRepoPath(root: string, relativePath: string): Promise<string> {
  const target = safeRepoPath(root, relativePath);
  await assertNoSymlinkEscape(root, path.dirname(target), true);
  await assertNoSymlinkEscape(root, target, true);
  return target;
}

export async function safeRepoWritePath(root: string, relativePath: string): Promise<string> {
  const target = safeRepoPath(root, relativePath);
  const parent = path.dirname(target);
  await assertNoSymlinkEscape(root, parent, true);
  await fs.mkdir(parent, { recursive: true });
  await assertNoSymlinkEscape(root, parent, true);
  return target;
}

async function assertNoSymlinkEscape(root: string, target: string, includeFinal: boolean): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const realRoot = await fs.realpath(resolvedRoot);
  const relative = path.relative(resolvedRoot, path.resolve(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes OpenWiki root: ${target}`);
  }
  const parts = relative.split(path.sep).filter(Boolean);
  let cursor = resolvedRoot;
  const limit = includeFinal ? parts.length : Math.max(parts.length - 1, 0);
  for (let index = 0; index < limit; index += 1) {
    cursor = path.join(cursor, parts[index] ?? "");
    let stats;
    try {
      stats = await fs.lstat(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`Path traverses symlink inside OpenWiki root: ${path.relative(resolvedRoot, cursor)}`);
    }
    const realCursor = await fs.realpath(cursor);
    if (realCursor !== realRoot && !realCursor.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`Path escapes OpenWiki root: ${path.relative(resolvedRoot, cursor)}`);
    }
  }
}
