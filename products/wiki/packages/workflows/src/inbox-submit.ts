import { idToUri, isoNow, slugify, uniqueStrings, type InboxItemRecord, type InboxItemStatus } from "@openwiki/core";
import { appendEvent, appendInboxItem, listInboxItems, loadRepository, readInboxItem, readInboxPayload, updateInboxItem } from "@openwiki/repo";
import { assertOpenWikiId } from "@openwiki/core";
import { writeText } from "./io.ts";
import { withWriteCoordination } from "./write-coordinator.ts";
import { recordInboxDuplicateMetric, recordInboxReceivedMetric } from "./inbox-metrics.ts";
import { sha256 } from "./inbox-shared.ts";
import type { ListInboxWorkflowInput, ListInboxWorkflowResult, ReadInboxWorkflowInput, ReadInboxWorkflowResult, SubmitInboxItemInput, SubmitInboxItemResult, UpdateInboxStatusInput, UpdateInboxStatusResult } from "./types.ts";

export async function submitInboxItem(input: SubmitInboxItemInput): Promise<SubmitInboxItemResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.inbox_submit",
      ...(input.submittedBy === undefined ? {} : { actorId: input.submittedBy }),
      metadata: { title: input.title, provider: input.provider ?? "manual" },
    },
    () => submitInboxItemUnlocked(input),
  );
}

async function submitInboxItemUnlocked(input: SubmitInboxItemInput): Promise<SubmitInboxItemResult> {
  const repo = await loadRepository(input.root);
  const title = input.title.trim();
  if (!title) {
    throw new Error("Inbox title cannot be empty");
  }
  const content = input.content ?? "";
  const contentPayload = content.length === 0 ? "" : content.endsWith("\n") ? content : `${content}\n`;
  const contentBuffer = Buffer.from(contentPayload, "utf8");
  const contentHash = `sha256:${sha256(contentBuffer)}`;
  const provider = safeToken(input.provider ?? "manual");
  const idempotencyScope = inboxIdempotencyScope(input);
  const idempotencyKey = input.idempotencyKey === undefined
    ? `${idempotencyScope}:${input.externalId === undefined ? `${provider}:${contentHash}` : `${provider}:external:${input.externalId}`}`
    : `${idempotencyScope}:key:${input.idempotencyKey}`;
  const duplicate = repo.inbox.find((item) => item.idempotency_key === idempotencyKey);
  if (duplicate !== undefined) {
    recordInboxReceivedMetric(duplicate, "duplicate");
    recordInboxDuplicateMetric(duplicate, "submit");
    return {
      item: duplicate,
      duplicate: true,
      existing_id: duplicate.id,
      ...(duplicate.payload?.path === undefined ? {} : { payload_path: duplicate.payload.path }),
    };
  }

  const now = isoNow();
  const receivedAt = input.receivedAt ?? now;
  const sequence = nextInboxSequence(repo.inbox.map((item) => item.id), receivedAt);
  const id = `inbox:${receivedAt.slice(0, 10)}-${String(sequence).padStart(3, "0")}`;
  const stem = id.replace(/:/g, "_").replace(/-/g, "_");
  const extension = extensionForMediaType(input.mediaType, input.adapter);
  const payloadPath = content.length === 0 ? undefined : `inbox/payloads/${stem}.${extension}`;
  if (payloadPath !== undefined) {
    await writeText(repo.root, payloadPath, contentPayload);
  }
  const item: InboxItemRecord = {
    id,
    uri: idToUri(id),
    type: "inbox",
    title,
    inbox_kind: safeToken(input.inboxKind ?? "note"),
    provider,
    status: "received",
    received_at: receivedAt,
    updated_at: now,
    idempotency_key: idempotencyKey,
    path: "inbox/items.jsonl",
    content_hash: contentHash,
    ...(input.adapter === undefined ? {} : { adapter: safeToken(input.adapter) }),
    ...(input.ownerActorId === undefined ? {} : { owner_actor_id: validatedActor(input.ownerActorId, "ownerActorId") }),
    ...(input.submittedBy === undefined ? {} : { submitted_by: validatedActor(input.submittedBy, "submittedBy") }),
    ...(input.targetSpaceId === undefined ? {} : { target_space_id: input.targetSpaceId }),
    ...(input.targetPath === undefined ? {} : { target_path: input.targetPath }),
    ...(input.externalId === undefined ? {} : { external_id: input.externalId }),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
    ...(input.sourceUrl === undefined ? {} : { source_url: input.sourceUrl }),
    ...(payloadPath === undefined
      ? {}
      : {
          payload: {
            kind: "git" as const,
            path: payloadPath,
            media_type: input.mediaType ?? "text/plain; charset=utf-8",
            bytes: contentBuffer.byteLength,
            content_hash: contentHash,
          },
        }),
    sensitivity: input.sensitivity ?? "private",
    metadata: {
      ...(input.metadata ?? {}),
      content_hash: contentHash,
    },
    validation_report: { status: "passed", issues: [] },
  };
  const saved = await appendInboxItem(repo.root, item);
  const event = await appendEvent(repo.root, {
    type: "inbox.submitted",
    ...(input.submittedBy === undefined ? {} : { actor_id: input.submittedBy }),
    operation: "wiki.inbox_submit",
    record_id: saved.id,
    record_type: "inbox",
    occurred_at: now,
    data: {
      provider: saved.provider,
      inbox_kind: saved.inbox_kind,
      ...(payloadPath === undefined ? {} : { payload_path: payloadPath }),
    },
    subject_ids: [saved.id],
    subject_paths: payloadPath === undefined ? [saved.path] : [saved.path, payloadPath],
    ...(saved.sensitivity === undefined ? {} : { sensitivity: saved.sensitivity }),
  });
  const savedWithEvent = await updateInboxItem(repo.root, {
    ...saved,
    event_ids: uniqueStrings([...(saved.event_ids ?? []), event.id]),
    updated_at: now,
  });
  recordInboxReceivedMetric(savedWithEvent);
  return {
    item: savedWithEvent,
    duplicate: false,
    ...(payloadPath === undefined ? {} : { payload_path: payloadPath }),
    event,
  };
}

export async function listInboxWorkflow(input: ListInboxWorkflowInput): Promise<ListInboxWorkflowResult> {
  return listInboxItems(input.root, {
    ...(input.statuses === undefined ? {} : { statuses: input.statuses }),
    ...(input.ownerActorId === undefined ? {} : { ownerActorId: input.ownerActorId }),
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.inboxKind === undefined ? {} : { inboxKind: input.inboxKind }),
    ...(input.targetSpaceId === undefined ? {} : { targetSpaceId: input.targetSpaceId }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}

export async function readInboxWorkflow(input: ReadInboxWorkflowInput): Promise<ReadInboxWorkflowResult> {
  if (input.includeContent !== true) {
    return { item: await readInboxItem(input.root, input.id) };
  }
  const payload = await readInboxPayload(input.root, input.id, input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes });
  return {
    item: payload.item,
    ...(payload.content === null
      ? {}
      : {
          content: {
            path: payload.content.path,
            ...(payload.content.media_type === undefined ? {} : { media_type: payload.content.media_type }),
            bytes: payload.content.bytes,
            body: payload.content.body,
            truncated: payload.content.truncated,
          },
        }),
  };
}

export async function ignoreInboxItem(input: UpdateInboxStatusInput): Promise<UpdateInboxStatusResult> {
  return updateInboxStatus(input, "ignored", "wiki.inbox_ignore");
}

export async function retryInboxItem(input: UpdateInboxStatusInput): Promise<UpdateInboxStatusResult> {
  return updateInboxStatus(input, "received", "wiki.inbox_retry");
}

async function updateInboxStatus(
  input: UpdateInboxStatusInput,
  status: InboxItemStatus,
  operation: "wiki.inbox_ignore" | "wiki.inbox_retry",
): Promise<UpdateInboxStatusResult> {
  return withWriteCoordination(
    {
      root: input.root,
      operation,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: { inbox_item_id: input.id },
    },
    async () => {
      const item = await readInboxItem(input.root, input.id);
      const now = isoNow();
      const nextRetryCount = status === "received" ? (item.processing?.retry_count ?? 0) + 1 : item.processing?.retry_count;
      const updated = await updateInboxItem(input.root, {
        ...item,
        status,
        updated_at: now,
        processing: {
          ...(item.processing ?? {}),
          ...(input.reason === undefined ? {} : { ignored_reason: input.reason }),
          ...(nextRetryCount === undefined ? {} : { retry_count: nextRetryCount }),
          last_processed_at: now,
        },
      });
      const event = await appendEvent(input.root, {
        type: status === "ignored" ? "inbox.ignored" : "inbox.retried",
        ...(input.actorId === undefined ? {} : { actor_id: input.actorId }),
        operation,
        record_id: updated.id,
        record_type: "inbox",
        occurred_at: now,
        data: { status, ...(input.reason === undefined ? {} : { reason: input.reason }) },
        subject_ids: [updated.id],
        subject_paths: [updated.path, ...(updated.payload?.path === undefined ? [] : [updated.payload.path])],
        ...(updated.sensitivity === undefined ? {} : { sensitivity: updated.sensitivity }),
      });
      return { item: await updateInboxItem(input.root, { ...updated, event_ids: uniqueStrings([...(updated.event_ids ?? []), event.id]) }), event };
    },
  );
}

function nextInboxSequence(ids: string[], iso: string): number {
  const prefix = `inbox:${iso.slice(0, 10)}-`;
  const numbers = ids
    .filter((id) => id.startsWith(prefix))
    .map((id) => Number(id.slice(prefix.length)))
    .filter((value) => Number.isInteger(value));
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

function validatedActor(value: string, label: string): string {
  try {
    return assertOpenWikiId(value, "actor");
  } catch (error) {
    throw new Error(`${label} must be an actor ID: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function safeToken(value: string): string {
  return slugify(value.trim()).replace(/-/g, "_") || "item";
}

function extensionForMediaType(mediaType: string | undefined, adapter: string | undefined): "txt" | "md" | "json" {
  if (mediaType?.includes("json") || adapter === "json") {
    return "json";
  }
  if (mediaType?.includes("markdown") || adapter === "markdown") {
    return "md";
  }
  return "txt";
}

function inboxIdempotencyScope(input: SubmitInboxItemInput): string {
  if (input.targetSpaceId !== undefined) {
    return `space:${input.targetSpaceId}`;
  }
  if (input.ownerActorId !== undefined) {
    return `owner:${input.ownerActorId}`;
  }
  if (input.targetPath !== undefined) {
    return `path:${input.targetPath}`;
  }
  return "workspace";
}
