import path from "node:path";
import {
  boundedOpenWikiListLimit,
  openWikiRepoRelativePath,
  type InboxItemRecord,
} from "@openwiki/core";
import { createContentStore } from "@openwiki/storage";
import {
  assertInboxObjectArtifactPath,
  assertInboxPayloadArtifactPath,
} from "./artifacts.ts";
import { loadInboxItems } from "./loaders.ts";
import { normalizeInboxItem } from "./normalizers.ts";
import { loadRepository } from "./workspace.ts";
import {
  appendRepoTextFile,
  openRepoFileForRead,
  stringMetadata,
  verifySha256,
  withWorkspaceFileLock,
  writeRepoTextFile,
} from "./io.ts";
import type { InboxPayloadRead, ListInboxItemsOptions } from "./types.ts";

export async function listInboxItems(root: string, options: ListInboxItemsOptions = {}): Promise<{ items: InboxItemRecord[]; total: number }> {
  const repo = await loadRepository(root);
  const statuses = options.statuses === undefined ? undefined : new Set(options.statuses);
  const items = repo.inbox
    .filter((item) => statuses === undefined || statuses.has(item.status))
    .filter((item) => options.ownerActorId === undefined || item.owner_actor_id === options.ownerActorId)
    .filter((item) => options.provider === undefined || item.provider === options.provider)
    .filter((item) => options.inboxKind === undefined || item.inbox_kind === options.inboxKind)
    .filter((item) => options.targetSpaceId === undefined || item.target_space_id === options.targetSpaceId)
    .filter((item) => options.updatedAfter === undefined || item.updated_at >= options.updatedAfter)
    .filter((item) => options.updatedBefore === undefined || item.updated_at <= options.updatedBefore)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.id.localeCompare(left.id));
  const limit = boundedOpenWikiListLimit(options.limit, items.length, 1000);
  return {
    items: items.slice(0, limit),
    total: items.length,
  };
}

export async function readInboxItem(root: string, id: string): Promise<InboxItemRecord> {
  const repo = await loadRepository(root);
  const match = repo.inbox.find((item) => item.id === id || item.uri === id);
  if (!match) {
    throw new Error(`Inbox item not found: ${id}`);
  }
  return match;
}

export async function appendInboxItem(root: string, item: InboxItemRecord): Promise<InboxItemRecord> {
  const resolved = path.resolve(root);
  return withWorkspaceFileLock(resolved, "inbox", async () => {
    const normalized = normalizeInboxItem({ ...item, path: "inbox/items.jsonl" });
    const items = await loadInboxItems(resolved);
    if (items.some((candidate) => candidate.id === normalized.id)) {
      throw new Error(`Inbox item already exists: ${normalized.id}`);
    }
    await appendRepoTextFile(resolved, normalized.path, `${JSON.stringify(normalized)}\n`);
    return normalized;
  });
}

export async function updateInboxItem(root: string, item: InboxItemRecord): Promise<InboxItemRecord> {
  const resolved = path.resolve(root);
  return withWorkspaceFileLock(resolved, "inbox", async () => {
    const normalized = normalizeInboxItem({ ...item, path: "inbox/items.jsonl" });
    const items = await loadInboxItems(resolved);
    if (!items.some((candidate) => candidate.id === normalized.id)) {
      throw new Error(`Inbox item not found: ${normalized.id}`);
    }
    const nextItems = items
      .map((candidate) => (candidate.id === normalized.id ? normalized : candidate))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.id.localeCompare(left.id));
    await writeRepoTextFile(resolved, normalized.path, nextItems.map((record) => JSON.stringify(record)).join("\n").concat("\n"));
    return normalized;
  });
}

export async function readInboxPayload(root: string, id: string, options: { maxBytes?: number } = {}): Promise<InboxPayloadRead> {
  const repo = await loadRepository(root);
  const item = repo.inbox.find((candidate) => candidate.id === id || candidate.uri === id);
  if (!item) {
    throw new Error(`Inbox item not found: ${id}`);
  }
  if (item.payload === undefined) {
    return { item, content: null, unavailable_reason: "not_captured" };
  }
  if (item.payload.kind === "object") {
    let objectPath: string;
    try {
      objectPath = assertInboxObjectArtifactPath(item.payload.path);
    } catch {
      return { item, content: null, unavailable_reason: "invalid_storage" };
    }
    const store = await createContentStore(repo.root, repo.config.runtime?.storage);
    const object = await store.get(objectPath, options).catch((error: unknown) => {
      if (error instanceof Error && /HTTP (404|410)\b/u.test(error.message)) {
        return undefined;
      }
      throw error;
    });
    if (object === undefined) {
      return { item, content: null, unavailable_reason: "missing" };
    }
    const truncated = object.data.byteLength < object.bytes;
    const contentHash = item.payload.content_hash ?? object.content_hash ?? item.content_hash;
    const hashVerified = truncated || contentHash === undefined ? undefined : verifySha256(object.data, contentHash);
    if (hashVerified === false) {
      return { item, content: null, unavailable_reason: "hash_mismatch" };
    }
    return {
      item,
      content: {
        path: object.path,
        kind: "object",
        ...(object.media_type === undefined ? {} : { media_type: object.media_type }),
        ...(contentHash === undefined ? {} : { content_hash: contentHash }),
        bytes: object.bytes,
        body: object.data.toString("utf8"),
        truncated,
        ...(hashVerified === undefined ? {} : { hash_verified: hashVerified }),
      },
    };
  }

  let payloadPath: string;
  try {
    payloadPath = assertInboxPayloadArtifactPath(item.payload.path);
  } catch {
    return { item, content: null, unavailable_reason: "invalid_storage" };
  }
  const opened = await openRepoFileForRead(repo.root, payloadPath);
  if (opened === undefined) {
    return { item, content: null, unavailable_reason: "missing" };
  }
  const stats = opened.stats;
  const maxBytes = Math.min(Math.max(options.maxBytes ?? 128 * 1024, 0), 1024 * 1024);
  const readLimit = Math.min(stats.size, maxBytes + 1);
  const buffer = Buffer.alloc(readLimit);
  try {
    const { bytesRead } = await opened.handle.read(buffer, 0, readLimit, 0);
    const truncated = stats.size > maxBytes || bytesRead > maxBytes;
    const data = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    const contentHash = item.payload.content_hash ?? item.content_hash;
    const mediaType = stringMetadata(item.payload as unknown as Record<string, unknown>, "media_type");
    const hashVerified = truncated || contentHash === undefined ? undefined : verifySha256(data, contentHash);
    if (hashVerified === false) {
      return { item, content: null, unavailable_reason: "hash_mismatch" };
    }
    return {
      item,
      content: {
        path: openWikiRepoRelativePath(repo.root, opened.path),
        kind: "git",
        ...(mediaType === undefined ? {} : { media_type: mediaType }),
        ...(contentHash === undefined ? {} : { content_hash: contentHash }),
        bytes: stats.size,
        body: data.toString("utf8"),
        truncated,
        ...(hashVerified === undefined ? {} : { hash_verified: hashVerified }),
      },
    };
  } finally {
    await opened.handle.close();
  }
}
