import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export function openWikiPathPatternMatches(pattern: string, repoPath: string): boolean {
  const normalizedPattern = normalizeOpenWikiRepoPath(pattern);
  const normalizedPath = normalizeOpenWikiRepoPath(repoPath);
  if (normalizedPattern === "**" || normalizedPattern === "*") {
    return true;
  }
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(prefix + "/");
  }
  if (!normalizedPattern.includes("*")) {
    return normalizedPath === normalizedPattern;
  }
  return new RegExp("^" + openWikiPathPatternRegexSource(normalizedPattern) + "$", "u").test(normalizedPath);
}

export function openWikiOffsetCursor(offset: number): string {
  return `offset:${offset}`;
}

export function boundedOpenWikiListLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return Math.min(Math.max(Math.trunc(fallback), 0), max);
  }
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

export function tokenizeOpenWikiText(value: string): string[] {
  return value.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

export async function openWikiPathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWriteFile(filePath: string, data: string | Uint8Array): Promise<void> {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(tempPath, "wx");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
    await fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function fsyncDirectory(dirPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(dirPath, "r");
    await handle.sync();
  } catch {
    return;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export const OPENWIKI_GIT_HARDENING_FLAGS = ["-c", "protocol.ext.allow=never", "-c", "protocol.file.allow=user"] as const;

export function openWikiGitArgs(root: string | undefined, args: string[]): string[] {
  return root === undefined ? [...OPENWIKI_GIT_HARDENING_FLAGS, ...args] : [...OPENWIKI_GIT_HARDENING_FLAGS, "-C", root, ...args];
}

export function openWikiGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, GIT_TERMINAL_PROMPT: "0" };
}

export function openWikiRepoRelativePath(root: string, filePath: string): string {
  return path.relative(path.resolve(root), path.resolve(filePath)).replace(/\\/g, "/");
}

export function normalizeOpenWikiRepoPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function openWikiPathPatternRegexSource(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length;) {
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 2;
      continue;
    }
    const char = pattern[index] ?? "";
    source += char === "*" ? "[^/]*" : escapeOpenWikiPathPatternRegex(char);
    index += 1;
  }
  return source;
}

function escapeOpenWikiPathPatternRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
