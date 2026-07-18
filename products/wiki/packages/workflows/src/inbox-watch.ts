import { promises as fs } from "node:fs";
import path from "node:path";
import { isoNow, openWikiRepoRelativePath, type InboxItemRecord } from "@openwiki/core";
import { submitInboxItem } from "./inbox-submit.ts";
import { DEFAULT_INBOX_MAX_BYTES, sha256 } from "./inbox-shared.ts";
import type { WatchInboxOnceInput, WatchInboxOnceResult } from "./types.ts";

export async function watchInboxOnce(input: WatchInboxOnceInput): Promise<WatchInboxOnceResult> {
  const root = await fs.realpath(path.resolve(input.root));
  const dir = await fs.realpath(path.resolve(input.dir));
  assertExternalInboxDir(root, dir);
  const maxBytes = Math.max(input.maxBytes ?? DEFAULT_INBOX_MAX_BYTES, 1);
  const candidates = await listInputFiles(dir);
  const items: InboxItemRecord[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  let duplicates = 0;
  let skipped = 0;
  let failed = 0;

  await writeAutomationState(root, {
    last_scan_at: isoNow(),
    directory: dir,
    adapter: input.adapter ?? "file",
    provider: input.provider ?? "file",
  });

  for (const filePath of candidates) {
    try {
      const stat = await stableFileStat(filePath);
      if (stat === undefined) {
        skipped += 1;
        continue;
      }
      if (stat.size > maxBytes) {
        throw new Error(`File exceeds max inbox bytes (${maxBytes}): ${stat.size}`);
      }
      const adapter = input.adapter ?? "file";
      const payload = await readInboxFilePayload(filePath, input.provider);
      const result = await submitInboxItem({
        root,
        title: payload.title,
        content: payload.content,
        inboxKind: input.inboxKind ?? payload.inboxKind,
        provider: payload.provider,
        adapter,
        ...(input.ownerActorId === undefined ? {} : { ownerActorId: input.ownerActorId }),
        ...(input.targetSpaceId === undefined ? {} : { targetSpaceId: input.targetSpaceId }),
        externalId: payload.externalId,
        origin: filePath,
        idempotencyKey: payload.idempotencyKey,
        mediaType: payload.mediaType,
        metadata: payload.metadata,
      });
      if (result.duplicate) {
        duplicates += 1;
      } else {
        items.push(result.item);
        if (input.archiveDir !== undefined) {
          await moveWatchedFile(filePath, input.archiveDir);
        }
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ path: filePath, message });
      if (input.quarantineDir !== undefined) {
        await moveWatchedFile(filePath, input.quarantineDir).catch(() => undefined);
      }
    }
  }
  return {
    scanned: candidates.length,
    submitted: items.length,
    duplicates,
    skipped,
    failed,
    items,
    errors,
  };
}

function assertExternalInboxDir(root: string, dir: string): void {
  const relative = path.relative(root, dir);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new Error("Inbox watch directory must not be inside the live OpenWiki workspace");
  }
}

async function listInputFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dir, entry.name))
    .filter((filePath) => /\.(?:txt|md|json)$/i.test(filePath) && !/\.(?:txt|md)\.json$/i.test(filePath));
  return files.sort();
}

async function stableFileStat(filePath: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  const first = await fs.lstat(filePath);
  if (!first.isFile() || first.isSymbolicLink()) {
    return undefined;
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = await fs.lstat(filePath);
  if (!second.isFile() || second.isSymbolicLink()) {
    return undefined;
  }
  return first.size === second.size && first.mtimeMs === second.mtimeMs ? { size: second.size, mtimeMs: second.mtimeMs } : undefined;
}

interface InboxFilePayload {
  title: string;
  content: string;
  inboxKind: string;
  provider: string;
  externalId: string;
  idempotencyKey: string;
  mediaType: string;
  metadata: Record<string, unknown>;
}

async function readInboxFilePayload(filePath: string, providerOverride: string | undefined): Promise<InboxFilePayload> {
  const raw = await fs.readFile(filePath, "utf8");
  const stat = await fs.stat(filePath);
  const hash = `sha256:${sha256(Buffer.from(raw, "utf8"))}`;
  const ext = path.extname(filePath).toLowerCase();
  const sidecar = await readSidecarMetadata(filePath);
  const provider = providerOverride ?? sidecarProvider(sidecar) ?? "file";
  const baseMetadata: Record<string, unknown> = {
    file_name: path.basename(filePath),
    source_path: filePath,
    source_mtime: new Date(stat.mtimeMs).toISOString(),
    content_hash: hash,
    ...sidecar,
  };
  if (ext === ".json") {
    const json = parseJsonRecord(raw);
    const jsonProvider = providerOverride ?? sidecarProvider(json) ?? provider;
    const content = stringFromRecord(json, ["transcript", "text", "content", "body"], raw);
    const title = stringFromRecord(json, ["title", "meeting_title", "name"], titleFromFilename(filePath));
    return {
      title,
      content,
      inboxKind: "meeting_transcript",
      provider: jsonProvider,
      externalId: stringFromRecord(json, ["id", "meeting_id", "recording_id"], openWikiRepoRelativePath(path.dirname(filePath), filePath)),
      idempotencyKey: `${jsonProvider}:${hash}`,
      mediaType: "application/json",
      metadata: { ...baseMetadata, json },
    };
  }
  return {
    title: sidecarTitle(sidecar) ?? titleFromFilename(filePath),
    content: raw,
    inboxKind: "note",
    provider,
    externalId: openWikiRepoRelativePath(path.dirname(filePath), filePath),
    idempotencyKey: `${provider}:${hash}`,
    mediaType: ext === ".md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
    metadata: baseMetadata,
  };
}

async function readSidecarMetadata(filePath: string): Promise<Record<string, unknown>> {
  const sidecarPath = `${filePath}.json`;
  const raw = await fs.readFile(sidecarPath, "utf8").catch(() => undefined);
  return raw === undefined ? {} : parseJsonRecord(raw);
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stringFromRecord(record: Record<string, unknown>, keys: string[], fallback: string): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return fallback;
}

function sidecarTitle(sidecar: Record<string, unknown>): string | undefined {
  const title = sidecar.title ?? sidecar.meeting_title ?? sidecar.name;
  return typeof title === "string" && title.trim() ? title : undefined;
}

function sidecarProvider(sidecar: Record<string, unknown>): string | undefined {
  const provider = sidecar.provider ?? sidecar.source_provider;
  return typeof provider === "string" && provider.trim() ? provider.trim() : undefined;
}

function titleFromFilename(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)).replace(/[_-]+/g, " ").trim() || "Inbox item";
}

async function moveWatchedFile(filePath: string, outDir: string): Promise<void> {
  const resolvedOut = path.resolve(outDir);
  await fs.mkdir(resolvedOut, { recursive: true });
  await fs.rename(filePath, path.join(resolvedOut, path.basename(filePath)));
}

async function writeAutomationState(root: string, state: Record<string, unknown>): Promise<void> {
  const statePath = path.join(root, ".openwiki", "inbox", "automation", "state.json");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}
