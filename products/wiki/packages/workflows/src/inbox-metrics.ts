import type { InboxItemRecord, InboxProcessingFailureCategory } from "@openwiki/core";

export interface InboxMetricSnapshot {
  received: Array<{ provider: string; inbox_kind: string; status: string; count: number }>;
  processing_duration_seconds: Array<{ provider: string; inbox_kind: string; status: string; seconds: number; count: number }>;
  failures: Array<{ provider: string; inbox_kind: string; category: InboxProcessingFailureCategory; count: number }>;
  duplicates: Array<{ provider: string; inbox_kind: string; stage: string; count: number }>;
  provider_attempts: Array<{ provider: string; processor: string; status: string; count: number }>;
  proposal_counts: Array<{ provider: string; inbox_kind: string; proposals: number; count: number }>;
}

const inboxReceivedMetrics = new Map<string, { provider: string; inbox_kind: string; status: string; count: number }>();
const inboxProcessingDurationMetrics = new Map<string, { provider: string; inbox_kind: string; status: string; seconds: number; count: number }>();
const inboxFailureMetrics = new Map<string, { provider: string; inbox_kind: string; category: InboxProcessingFailureCategory; count: number }>();
const inboxDuplicateMetrics = new Map<string, { provider: string; inbox_kind: string; stage: string; count: number }>();
const inboxProviderAttemptMetrics = new Map<string, { provider: string; processor: string; status: string; count: number }>();
const inboxProposalCountMetrics = new Map<string, { provider: string; inbox_kind: string; proposals: number; count: number }>();

const KNOWN_PROVIDERS = new Set(["manual", "file", "transcript_file", "api", "webhook", "github", "gitlab"]);
const KNOWN_INBOX_KINDS = new Set(["note", "meeting_transcript", "transcript", "source", "task", "question"]);
const KNOWN_PROCESSORS = new Set(["deterministic", "fake", "opencode", "claude", "codex"]);
const KNOWN_STATUSES = new Set(["received", "queued", "processing", "proposed", "processed", "applied", "ignored", "failed", "superseded", "duplicate", "started", "succeeded"]);
const KNOWN_DUPLICATE_STAGES = new Set(["submit", "process", "watch", "reconcile"]);

export function inboxMetricsSnapshot(): InboxMetricSnapshot {
  return {
    received: [...inboxReceivedMetrics.values()],
    processing_duration_seconds: [...inboxProcessingDurationMetrics.values()],
    failures: [...inboxFailureMetrics.values()],
    duplicates: [...inboxDuplicateMetrics.values()],
    provider_attempts: [...inboxProviderAttemptMetrics.values()],
    proposal_counts: [...inboxProposalCountMetrics.values()],
  };
}

export function resetInboxMetricsForTests(): void {
  inboxReceivedMetrics.clear();
  inboxProcessingDurationMetrics.clear();
  inboxFailureMetrics.clear();
  inboxDuplicateMetrics.clear();
  inboxProviderAttemptMetrics.clear();
  inboxProposalCountMetrics.clear();
}

export function recordInboxReceivedMetric(item: InboxItemRecord, status: string = item.status): void {
  const provider = boundedLabel(item.provider, KNOWN_PROVIDERS);
  const inboxKind = boundedLabel(item.inbox_kind, KNOWN_INBOX_KINDS);
  const safeStatus = boundedLabel(status, KNOWN_STATUSES);
  const key = `${provider}|${inboxKind}|${safeStatus}`;
  const current = inboxReceivedMetrics.get(key) ?? { provider, inbox_kind: inboxKind, status: safeStatus, count: 0 };
  current.count += 1;
  inboxReceivedMetrics.set(key, current);
}

export function recordInboxProcessingDuration(item: InboxItemRecord, status: string, elapsedMs: number): void {
  const provider = boundedLabel(item.provider, KNOWN_PROVIDERS);
  const inboxKind = boundedLabel(item.inbox_kind, KNOWN_INBOX_KINDS);
  const safeStatus = boundedLabel(status, KNOWN_STATUSES);
  const key = `${provider}|${inboxKind}|${safeStatus}`;
  const current = inboxProcessingDurationMetrics.get(key) ?? { provider, inbox_kind: inboxKind, status: safeStatus, seconds: 0, count: 0 };
  current.seconds += Math.max(elapsedMs, 0) / 1000;
  current.count += 1;
  inboxProcessingDurationMetrics.set(key, current);
}

export function recordInboxProcessingFailure(item: InboxItemRecord, category: InboxProcessingFailureCategory): void {
  const provider = boundedLabel(item.provider, KNOWN_PROVIDERS);
  const inboxKind = boundedLabel(item.inbox_kind, KNOWN_INBOX_KINDS);
  const key = `${provider}|${inboxKind}|${category}`;
  const current = inboxFailureMetrics.get(key) ?? { provider, inbox_kind: inboxKind, category, count: 0 };
  current.count += 1;
  inboxFailureMetrics.set(key, current);
}

export function recordInboxDuplicateMetric(item: InboxItemRecord, stage: string): void {
  const provider = boundedLabel(item.provider, KNOWN_PROVIDERS);
  const inboxKind = boundedLabel(item.inbox_kind, KNOWN_INBOX_KINDS);
  const safeStage = boundedLabel(stage, KNOWN_DUPLICATE_STAGES);
  const key = `${provider}|${inboxKind}|${safeStage}`;
  const current = inboxDuplicateMetrics.get(key) ?? { provider, inbox_kind: inboxKind, stage: safeStage, count: 0 };
  current.count += 1;
  inboxDuplicateMetrics.set(key, current);
}

export function recordInboxProviderAttempt(item: InboxItemRecord, processor: string, status: string): void {
  const provider = boundedLabel(item.provider, KNOWN_PROVIDERS);
  const safeProcessor = boundedLabel(processor, KNOWN_PROCESSORS);
  const safeStatus = boundedLabel(status, KNOWN_STATUSES);
  const key = `${provider}|${safeProcessor}|${safeStatus}`;
  const current = inboxProviderAttemptMetrics.get(key) ?? { provider, processor: safeProcessor, status: safeStatus, count: 0 };
  current.count += 1;
  inboxProviderAttemptMetrics.set(key, current);
}

export function recordInboxProposalCount(item: InboxItemRecord): void {
  const provider = boundedLabel(item.provider, KNOWN_PROVIDERS);
  const inboxKind = boundedLabel(item.inbox_kind, KNOWN_INBOX_KINDS);
  const proposals = Math.min(item.proposal_ids?.length ?? 0, 10);
  const key = `${provider}|${inboxKind}|${proposals}`;
  const current = inboxProposalCountMetrics.get(key) ?? { provider, inbox_kind: inboxKind, proposals, count: 0 };
  current.count += 1;
  inboxProposalCountMetrics.set(key, current);
}

function boundedLabel(value: string, knownValues: Set<string>): string {
  return knownValues.has(value) ? value : "other";
}
