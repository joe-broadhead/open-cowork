
import { promises as fs } from "node:fs";
import path from "node:path";

import { DEFAULT_STATIC_EXPORT_OUT_DIR, RESERVED_EXPORT_TOP_LEVEL_DIRS } from "./types.ts";

export async function resolveStaticExportOutDir(root: string, outDir = DEFAULT_STATIC_EXPORT_OUT_DIR): Promise<string> {
  const repoRoot = path.resolve(root);
  const rawOutDir = outDir.trim();
  if (rawOutDir.length === 0) {
    throw new Error("Static export outDir must be a non-empty relative path");
  }
  if (path.isAbsolute(rawOutDir)) {
    throw new Error("Static export outDir must be relative to the OpenWiki workspace");
  }

  const normalized = path.normalize(rawOutDir);
  const parts = normalized.split(path.sep).filter(Boolean);
  if (normalized === "." || parts.length === 0 || parts.includes("..")) {
    throw new Error("Static export outDir must resolve to a child directory inside the OpenWiki workspace");
  }
  if (RESERVED_EXPORT_TOP_LEVEL_DIRS.has(parts[0] ?? "")) {
    throw new Error(`Static export outDir cannot target reserved workspace directory '${parts[0]}'`);
  }

  const resolved = path.resolve(repoRoot, normalized);
  assertPathInside(repoRoot, resolved, "Static export outDir must stay inside the OpenWiki workspace");
  await assertExportPathDoesNotEscapeViaSymlink(repoRoot, resolved);
  return resolved;
}

async function assertExportPathDoesNotEscapeViaSymlink(repoRoot: string, outDir: string): Promise<void> {
  const repoRootReal = await fs.realpath(repoRoot);
  const relative = path.relative(path.resolve(repoRoot), outDir);
  let current = path.resolve(repoRoot);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (isNotFound(error)) {
        break;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error("Static export outDir cannot include symbolic links");
    }
    const currentReal = await fs.realpath(current);
    assertPathInside(repoRootReal, currentReal, "Static export outDir cannot resolve outside the OpenWiki workspace");
  }
}

function assertPathInside(parent: string, child: string, message: string): void {
  const relative = path.relative(parent, child);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(message);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
