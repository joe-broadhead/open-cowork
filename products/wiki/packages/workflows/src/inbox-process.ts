import { isoNow, uniqueStrings, writeOpenWikiLog, type InboxItemRecord, type OpenWikiPolicyBundle, type SourceRecord } from "@openwiki/core";
import { assertPathAuthorized, canReadInboxItemRecord } from "@openwiki/policy";
import { appendEvent, loadRepository, readInboxPayload, updateInboxItem } from "@openwiki/repo";
import { ingestSource } from "./sources.ts";
import { runPostEventAutomation } from "./sync.ts";
import { withWriteCoordination } from "./write-coordinator.ts";
import { recordInboxDuplicateMetric, recordInboxProcessingDuration, recordInboxProcessingFailure, recordInboxProposalCount, recordInboxProviderAttempt } from "./inbox-metrics.ts";
import { failureDetail, inboxFailureFromError, InboxProcessingError, type InboxProcessingFailureDetail } from "./inbox-failures.ts";
import { DEFAULT_INBOX_MAX_BYTES } from "./inbox-shared.ts";
import type { ProcessInboxItemInput, ProcessInboxItemResult } from "./types.ts";

const INBOX_PROCESSOR_ID = "openwiki.inbox.process";

export async function processInboxItem(input: ProcessInboxItemInput): Promise<ProcessInboxItemResult> {
  const result = await withWriteCoordination(
    {
      root: input.root,
      operation: "wiki.inbox_process",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      metadata: { inbox_item_id: input.id, dry_run: input.dryRun === true },
      waitMs: 30000,
    },
    async () => {
      const startedAt = Date.now();
      const processor = input.processor ?? "deterministic";
      const plan = [
        "Read inbox payload",
        "Verify actor permissions and payload hash",
        "Create a source record from the payload",
        "Mark the inbox item as proposed and link the source",
      ];
      let payload = await readInboxPayload(input.root, input.id, { maxBytes: DEFAULT_INBOX_MAX_BYTES });
      let item = payload.item;
      let providerAttemptStarted = false;
      if (input.dryRun === true) {
        recordInboxProcessingDuration(item, "dry_run", Date.now() - startedAt);
        return { item, dry_run: true, plan };
      }

      try {
        await assertInboxProcessAuthorized(input, item);
        const existingSource = await findExistingInboxSource(input.root, item);
        if (existingSource !== undefined && input.force !== true) {
          const now = isoNow();
          const updated = await updateInboxItem(input.root, {
            ...item,
            status: item.status === "failed" || item.status === "received" || item.status === "processing" || item.status === "queued" ? "proposed" : item.status,
            updated_at: now,
            source_ids: uniqueStrings([...(item.source_ids ?? []), existingSource.id]),
            ...(input.runId === undefined ? {} : { run_ids: uniqueStrings([...(item.run_ids ?? []), input.runId]) }),
            processing: successfulInboxProcessing(item, now, input.runId),
          });
          recordInboxDuplicateMetric(item, "process");
          recordInboxProcessingDuration(updated, "duplicate", Date.now() - startedAt);
          writeInboxProcessLog("inbox_process_idempotent", updated, input, {
            source_id: existingSource.id,
            processor,
          });
          return { item: updated, dry_run: false, plan, idempotent: true, source: existingSource };
        }

        item = await markInboxProcessing(input, item, processor);
        payload = await readInboxPayload(input.root, item.id, { maxBytes: DEFAULT_INBOX_MAX_BYTES });
        if (payload.content === null) {
          throw new InboxProcessingError(failureDetail("payload_unavailable", `Inbox item payload is unavailable: ${payload.unavailable_reason ?? "unknown"}`, item));
        }
        if (payload.content.hash_verified === false) {
          throw new InboxProcessingError(failureDetail("validation_failed", "Inbox payload content hash did not match the captured hash", item));
        }
        recordInboxProviderAttempt(item, processor, "started");
        providerAttemptStarted = true;
        if (input.fakeProviderFailure !== undefined) {
          throw new InboxProcessingError(failureDetail(input.fakeProviderFailure, `Fake inbox provider reported ${input.fakeProviderFailure}`, item));
        }
        const sourceResult = await ingestSource({
          root: input.root,
          title: item.title,
          sourceType: sourceTypeForInboxKind(item.inbox_kind),
          content: payload.content.body,
          ...(item.source_url === undefined ? {} : { url: item.source_url }),
          ...((input.actorId ?? item.submitted_by ?? item.owner_actor_id) === undefined ? {} : { actorId: input.actorId ?? item.submitted_by ?? item.owner_actor_id }),
          trust: {
            source: "inbox",
            inbox_item_id: item.id,
            provider: item.provider,
            sensitivity: item.sensitivity ?? "private",
            ...(item.adapter === undefined ? {} : { adapter: item.adapter }),
            ...(item.external_id === undefined ? {} : { external_id: item.external_id }),
            processor,
          },
          storage: {
            inbox_item_id: item.id,
            inbox_payload_path: payload.content.path,
          },
          postEventAutomation: false,
        });
        recordInboxProviderAttempt(item, processor, "succeeded");
        const now = isoNow();
        const updated = await updateInboxItem(input.root, {
          ...item,
          status: "proposed",
          updated_at: now,
          source_ids: uniqueStrings([...(item.source_ids ?? []), sourceResult.source.id]),
          ...(input.runId === undefined ? {} : { run_ids: uniqueStrings([...(item.run_ids ?? []), input.runId]) }),
          processing: successfulInboxProcessing(item, now, input.runId),
        });
        const event = await appendEvent(input.root, {
          type: "inbox.processed",
          ...(input.actorId === undefined ? {} : { actor_id: input.actorId }),
          operation: "wiki.inbox_process",
          record_id: updated.id,
          record_type: "inbox",
          occurred_at: now,
          data: { source_id: sourceResult.source.id, processor, proposal_count: updated.proposal_ids?.length ?? 0 },
          subject_ids: [updated.id, sourceResult.source.id, ...(input.runId === undefined ? [] : [input.runId])],
          subject_paths: [updated.path, ...(updated.payload?.path === undefined ? [] : [updated.payload.path]), sourceResult.manifest_path],
          ...(updated.sensitivity === undefined ? {} : { sensitivity: updated.sensitivity }),
        });
        const finalItem = await updateInboxItem(input.root, { ...updated, event_ids: uniqueStrings([...(updated.event_ids ?? []), event.id]) });
        recordInboxProcessingDuration(finalItem, "succeeded", Date.now() - startedAt);
        recordInboxProposalCount(finalItem);
        writeInboxProcessLog("inbox_process_succeeded", finalItem, input, {
          source_id: sourceResult.source.id,
          processor,
        });
        return { item: finalItem, dry_run: false, plan, source: sourceResult.source, event };
      } catch (error) {
        const failure = inboxFailureFromError(error, item);
        if (providerAttemptStarted) {
          recordInboxProviderAttempt(item, processor, "failed");
        }
        const failed = await markInboxFailed(input, item, failure);
        recordInboxProcessingFailure(failed.item, failure.category);
        recordInboxProcessingDuration(failed.item, "failed", Date.now() - startedAt);
        writeInboxProcessLog("inbox_process_failed", failed.item, input, {
          category: failure.category,
          retryable: failure.retryable,
          processor,
        }, failure.message);
        return { item: failed.item, dry_run: false, plan, failure, event: failed.event };
      }
    },
  );
  if (result.dry_run !== true && result.failure === undefined && result.event !== undefined) {
    await runPostEventAutomation({
      root: input.root,
      eventType: "inbox.processed",
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      recordId: result.item.id,
      recordType: "inbox",
      subjectIds: [result.item.id, ...(result.source === undefined ? [] : [result.source.id]), ...(input.runId === undefined ? [] : [input.runId])],
      subjectPaths: [
        result.item.path,
        ...(result.item.payload?.path === undefined ? [] : [result.item.payload.path]),
        ...(result.source === undefined ? [] : [result.source.path]),
      ],
    }).catch((error) => {
      writeOpenWikiLog({
        event: "post_event_automation_failed",
        level: "error",
        actor_id: input.actorId ?? result.item.submitted_by ?? result.item.owner_actor_id,
        metadata: { trigger_event: "inbox.processed", inbox_item_id: result.item.id },
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return result;
}

async function markInboxProcessing(
  input: ProcessInboxItemInput,
  item: InboxItemRecord,
  processor: string,
): Promise<InboxItemRecord> {
  const now = isoNow();
  return updateInboxItem(input.root, {
    ...item,
    status: "processing",
    updated_at: now,
    ...(input.runId === undefined ? {} : { run_ids: uniqueStrings([...(item.run_ids ?? []), input.runId]) }),
    processing: {
      ...(item.processing?.ignored_reason === undefined ? {} : { ignored_reason: item.processing.ignored_reason }),
      ...(item.processing?.retry_count === undefined ? {} : { retry_count: item.processing.retry_count }),
      attempt_count: (item.processing?.attempt_count ?? 0) + 1,
      last_processed_at: now,
      processor: INBOX_PROCESSOR_ID,
      ...(input.runId === undefined ? {} : { run_id: input.runId }),
      ...(processor === "deterministic" ? {} : { next_action: `Waiting on ${processor} processor result` }),
    },
  });
}

function successfulInboxProcessing(item: InboxItemRecord, processedAt: string, runId: string | undefined): NonNullable<InboxItemRecord["processing"]> {
  return {
    ...(item.processing?.ignored_reason === undefined ? {} : { ignored_reason: item.processing.ignored_reason }),
    ...(item.processing?.retry_count === undefined ? {} : { retry_count: item.processing.retry_count }),
    ...(item.processing?.attempt_count === undefined ? {} : { attempt_count: item.processing.attempt_count }),
    last_processed_at: processedAt,
    processor: INBOX_PROCESSOR_ID,
    ...(runId === undefined ? {} : { run_id: runId }),
  };
}

async function markInboxFailed(
  input: ProcessInboxItemInput,
  item: InboxItemRecord,
  failure: InboxProcessingFailureDetail,
): Promise<{ item: InboxItemRecord; event: NonNullable<ProcessInboxItemResult["event"]> }> {
  const now = isoNow();
  const updated = await updateInboxItem(input.root, {
    ...item,
    status: "failed",
    updated_at: now,
    ...(input.runId === undefined ? {} : { run_ids: uniqueStrings([...(item.run_ids ?? []), input.runId]) }),
    processing: {
      ...(item.processing ?? {}),
      error: failure.message,
      failure_category: failure.category,
      next_action: failure.next_action,
      retryable: failure.retryable,
      ...(failure.next_retry_at === undefined ? {} : { next_retry_at: failure.next_retry_at }),
      last_processed_at: now,
      processor: INBOX_PROCESSOR_ID,
      ...(input.runId === undefined ? {} : { run_id: input.runId }),
    },
  });
  const event = await appendEvent(input.root, {
    type: "inbox.processing_failed",
    ...(input.actorId === undefined ? {} : { actor_id: input.actorId }),
    operation: "wiki.inbox_process",
    record_id: updated.id,
    record_type: "inbox",
    occurred_at: now,
    data: {
      category: failure.category,
      retryable: failure.retryable,
      next_action: failure.next_action,
      ...(failure.next_retry_at === undefined ? {} : { next_retry_at: failure.next_retry_at }),
      ...(input.runId === undefined ? {} : { run_id: input.runId }),
    },
    subject_ids: [updated.id, ...(input.runId === undefined ? [] : [input.runId])],
    subject_paths: [updated.path, ...(updated.payload?.path === undefined ? [] : [updated.payload.path])],
    ...(updated.sensitivity === undefined ? {} : { sensitivity: updated.sensitivity }),
  });
  const finalItem = await updateInboxItem(input.root, { ...updated, event_ids: uniqueStrings([...(updated.event_ids ?? []), event.id]) });
  return { item: finalItem, event };
}

async function assertInboxProcessAuthorized(input: ProcessInboxItemInput, item: InboxItemRecord): Promise<void> {
  if (input.policyContext === undefined) {
    return;
  }
  const repo = await loadRepository(input.root);
  if (!canReadInboxItemRecord(repo, input.policyContext, item)) {
    throw new Error(`Inbox item is not visible to processing actor: ${item.id}`);
  }
  const repoPath = inboxProcessAuthorizationPath(item, repo.policy);
  assertPathAuthorized("wiki.inbox_process", input.policyContext, repo.policy, repoPath, "maintainer");
}

export function inboxProcessAuthorizationPath(item: InboxItemRecord, policy: Pick<OpenWikiPolicyBundle, "sections">): string {
  return item.target_path ?? policy.sections.find((section) => section.id === item.target_space_id)?.paths[0] ?? item.payload?.path ?? item.path;
}

async function findExistingInboxSource(root: string, item: InboxItemRecord): Promise<SourceRecord | undefined> {
  const repo = await loadRepository(root);
  const linked = (item.source_ids ?? [])
    .map((id) => repo.sources.find((source) => source.id === id))
    .find((source): source is SourceRecord => source !== undefined);
  if (linked !== undefined) {
    return linked;
  }
  return repo.sources.find((source) => sourceMatchesInboxItem(source, item));
}

function sourceMatchesInboxItem(source: SourceRecord, item: InboxItemRecord): boolean {
  return recordField(source.trust, "inbox_item_id") === item.id || recordField(source.storage, "inbox_item_id") === item.id;
}

function recordField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const entry = value?.[key];
  return typeof entry === "string" && entry.trim() ? entry : undefined;
}

function writeInboxProcessLog(
  event: string,
  item: InboxItemRecord,
  input: ProcessInboxItemInput,
  metadata: Record<string, unknown>,
  error?: string,
): void {
  writeOpenWikiLog({
    event,
    ...(error === undefined ? {} : { level: "error", error }),
    actor_id: input.actorId ?? item.submitted_by ?? item.owner_actor_id,
    correlation_id: input.runId ?? item.id,
    metadata: {
      inbox_item_id: item.id,
      provider: item.provider,
      inbox_kind: item.inbox_kind,
      status: item.status,
      ...(input.runId === undefined ? {} : { run_id: input.runId }),
      ...metadata,
    },
  });
}

function sourceTypeForInboxKind(kind: string): string {
  return kind === "meeting_transcript" || kind === "transcript" ? "transcript" : "manual";
}
