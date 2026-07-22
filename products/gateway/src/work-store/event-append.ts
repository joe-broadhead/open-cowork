/**
 * Event append primitives for Durable Gateway work-store (JOE-942).
 * Leaf module: no imports from work-store.ts (breaks domain cycles).
 */
import type { DatabaseSync } from 'node:sqlite'
import { pruneWorkEvents, readAuditLedgerRetentionAnchorHash } from './retention.js'
import { auditLedgerRecordFromWorkEvent } from '../audit-ledger.js'
import { redactSensitiveText } from '../security.js'
import type {
  DelegatedWorkProgressKind,
  DelegationProgressRouteReceiptRecord,
  DelegationProgressRouteReceiptState,
  WorkEventRecord,
} from './types.js'

export function appendWorkEventRow(db: DatabaseSync, type: string, subjectId?: string, payload: Record<string, unknown> = {}, createdAt = new Date().toISOString()): number {
  const result = db.prepare('INSERT INTO events (type, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?)')
    .run(type, subjectId || null, JSON.stringify(payload), createdAt) as any
  const id = Number(result?.lastInsertRowid || 0)
  const record = { id, type, subjectId, payload, createdAt }
  appendAuditLedgerRowForWorkEvent(db, record)
  upsertDelegationProgressRouteReceiptFromEvent(db, record)
  pruneWorkEvents(db, createdAt)
  return id
}

export function upsertDelegationProgressRouteReceiptFromEvent(db: DatabaseSync, event: WorkEventRecord): void {
  if (!isDelegationProgressRouteEvent(event.type)) return
  const payload = event.payload || {}
  const dedupeKey = typeof payload['dedupeKey'] === 'string' ? payload['dedupeKey'].trim() : ''
  if (!dedupeKey) return

  const previous = db.prepare('SELECT state, attempt_count FROM delegation_progress_route_receipts WHERE dedupe_key = ?').get(dedupeKey) as any
  const state = routeReceiptStateFromEvent(event.type, payload, previous?.state)
  const now = routeIso(event.createdAt) || new Date().toISOString()
  db.prepare(`INSERT INTO delegation_progress_route_receipts (
    dedupe_key, progress_key, idempotency_key, progress, target_key, provider, session_id,
    delivery, state, reason, error, deferred_until, suppressed_until, progress_event_id,
    attempt_count, last_event_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  ON CONFLICT(dedupe_key) DO UPDATE SET
    progress_key = COALESCE(excluded.progress_key, delegation_progress_route_receipts.progress_key),
    idempotency_key = COALESCE(excluded.idempotency_key, delegation_progress_route_receipts.idempotency_key),
    progress = COALESCE(excluded.progress, delegation_progress_route_receipts.progress),
    target_key = COALESCE(excluded.target_key, delegation_progress_route_receipts.target_key),
    provider = COALESCE(excluded.provider, delegation_progress_route_receipts.provider),
    session_id = COALESCE(excluded.session_id, delegation_progress_route_receipts.session_id),
    delivery = COALESCE(excluded.delivery, delegation_progress_route_receipts.delivery),
    state = excluded.state,
    reason = COALESCE(excluded.reason, delegation_progress_route_receipts.reason),
    error = COALESCE(excluded.error, delegation_progress_route_receipts.error),
    deferred_until = COALESCE(excluded.deferred_until, delegation_progress_route_receipts.deferred_until),
    suppressed_until = COALESCE(excluded.suppressed_until, delegation_progress_route_receipts.suppressed_until),
    progress_event_id = COALESCE(excluded.progress_event_id, delegation_progress_route_receipts.progress_event_id),
    attempt_count = delegation_progress_route_receipts.attempt_count + 1,
    last_event_id = COALESCE(excluded.last_event_id, delegation_progress_route_receipts.last_event_id),
    updated_at = excluded.updated_at`)
    .run(
      dedupeKey,
      routeString(payload['progressKey']) || null,
      routeString(payload['idempotencyKey']) || null,
      routeProgress(payload['progress']) || null,
      routeString(payload['targetKey']) || null,
      routeString(payload['provider']) || null,
      routeString(payload['sessionId']) || null,
      routeString(payload['delivery']) || null,
      state,
      routeReceiptText(payload['reason']) || null,
      routeReceiptText(payload['error']) || null,
      routeIso(payload['deferredUntil']) || null,
      routeIso(payload['suppressedUntil']) || null,
      routeNumber(payload['progressEventId']) ?? null,
      event.id || null,
      now,
      now,
    )
}

export function rowToDelegationProgressRouteReceipt(row: any): DelegationProgressRouteReceiptRecord | undefined {
  const dedupeKey = typeof row?.dedupe_key === 'string' && row.dedupe_key ? row.dedupe_key : ''
  if (!dedupeKey) return undefined
  const state = routeReceiptState(row.state)
  const receipt: DelegationProgressRouteReceiptRecord = {
    dedupeKey,
    progressKey: routeString(row.progress_key),
    idempotencyKey: routeString(row.idempotency_key),
    progress: routeProgress(row.progress),
    targetKey: routeString(row.target_key),
    provider: routeString(row.provider),
    sessionId: routeString(row.session_id),
    delivery: routeString(row.delivery),
    state,
    reason: routeReceiptText(row.reason),
    error: routeReceiptText(row.error),
    deferredUntil: routeIso(row.deferred_until),
    suppressedUntil: routeIso(row.suppressed_until),
    progressEventId: routeNumber(row.progress_event_id),
    attemptCount: Math.max(1, Number(row.attempt_count || 1)),
    lastEventId: routeNumber(row.last_event_id),
    createdAt: routeIso(row.created_at) || new Date(0).toISOString(),
    updatedAt: routeIso(row.updated_at) || routeIso(row.created_at) || new Date(0).toISOString(),
    nextAction: '',
  }
  receipt.nextAction = delegationProgressRouteReceiptNextAction(receipt)
  return receipt
}

function isDelegationProgressRouteEvent(type: string): boolean {
  return type === 'delegation.progress.attempting' || type === 'delegation.progress.notified' || type === 'delegation.progress.failed' || type === 'delegation.progress.suppressed'
}

function routeReceiptStateFromEvent(type: string, payload: Record<string, unknown>, previousState: unknown): DelegationProgressRouteReceiptState {
  if (type === 'delegation.progress.attempting') return 'pending'
  if (type === 'delegation.progress.notified') return previousState === 'failed' ? 'retried' : 'delivered'
  if (type === 'delegation.progress.failed') return 'failed'
  const delivery = routeString(payload['delivery'])
  const reason = routeString(payload['reason'])?.toLowerCase() || ''
  if (delivery === 'muted') return 'muted'
  if (delivery === 'deferred' && reason.includes('missing parent session')) return 'orphaned'
  if (delivery === 'deferred' && reason.includes('session client unavailable')) return 'stale_parent'
  if (delivery === 'deferred') return 'deferred'
  return 'suppressed'
}

function delegationProgressRouteReceiptNextAction(receipt: Pick<DelegationProgressRouteReceiptRecord, 'state' | 'error' | 'deferredUntil' | 'suppressedUntil' | 'provider' | 'sessionId'>): string {
  if (receipt.state === 'delivered') return 'No action; delivery receipt is present.'
  if (receipt.state === 'retried') return 'No action; delivery succeeded after a previous failed attempt.'
  if (receipt.state === 'failed') {
    if (receipt.error && /\btimed out after \d+ms\b/.test(receipt.error)) return 'Retry after the timeout cooldown, or repair the target adapter before rerunning progress delivery.'
    return 'Repair the delivery target and rerun delegated progress delivery.'
  }
  if (receipt.state === 'stale_parent') return 'Reconnect the parent OpenCode session client, then rerun delegated progress delivery.'
  if (receipt.state === 'orphaned') return 'Rebind the delegated work to a parent session or trusted channel before claiming delivery.'
  if (receipt.state === 'muted') return 'Unmute the target or change notification policy before expecting delivery.'
  if (receipt.state === 'deferred') return receipt.deferredUntil ? `Wait until ${receipt.deferredUntil}, then rerun delegated progress delivery.` : 'Resolve the deferral reason, then rerun delegated progress delivery.'
  if (receipt.state === 'suppressed') return receipt.suppressedUntil ? `Suppressed until ${receipt.suppressedUntil}; inspect notification policy before retrying.` : 'Inspect notification policy and target binding before retrying.'
  return 'Run delegated progress delivery for this pending route.'
}

function routeReceiptState(value: unknown): DelegationProgressRouteReceiptState {
  return value === 'pending' || value === 'delivered' || value === 'failed' || value === 'retried' || value === 'suppressed' || value === 'deferred' || value === 'muted' || value === 'stale_parent' || value === 'orphaned' ? value : 'pending'
}

function routeProgress(value: unknown): DelegatedWorkProgressKind | undefined {
  return value === 'created' || value === 'dispatched' || value === 'stage_advanced' || value === 'blocked' || value === 'gate_opened' || value === 'completed' || value === 'failed' || value === 'completion_proposed' ? value : undefined
}

function routeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().substring(0, 1000) : undefined
}

function routeReceiptText(value: unknown): string | undefined {
  const text = routeString(value)
  return text ? redactSensitiveText(text).substring(0, 1000) : undefined
}

function routeIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

function routeNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

export function appendAuditLedgerRowForWorkEvent(db: DatabaseSync, event: WorkEventRecord): void {
  if (!event.id) return
  if (db.prepare('SELECT id FROM audit_ledger WHERE source_event_id = ?').get(event.id)) return
  const previous = db.prepare('SELECT entry_hash FROM audit_ledger ORDER BY id DESC LIMIT 1').get() as any
  // When retention has pruned the entire ledger, the chain continues from the
  // recorded retention anchor instead of restarting at genesis.
  const previousHash = previous?.entry_hash ? String(previous.entry_hash) : readAuditLedgerRetentionAnchorHash(db)
  const record = auditLedgerRecordFromWorkEvent(event, previousHash)
  if (!record) return
  db.prepare(`INSERT INTO audit_ledger (
    schema_version, event_id, source_event_id, source_event_type, class, actor_kind, actor_ref,
    resource_kind, resource_ref, action, result, occurred_at, trace_id, correlation_id,
    retention_class, evidence_refs_json, redacted_payload_json, previous_hash, entry_hash
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      record.schemaVersion,
      record.eventId,
      record.sourceEventId || null,
      record.sourceEventType || null,
      record.class,
      record.actorKind,
      record.actorRef,
      record.resourceKind,
      record.resourceRef,
      record.action,
      record.result,
      record.occurredAt,
      record.traceId,
      record.correlationId || null,
      record.retentionClass,
      JSON.stringify(record.evidenceRefs),
      JSON.stringify(record.redactedPayload),
      record.previousHash || null,
      record.entryHash,
    )
}
