import type {
  DelegationProgressDeliveryEventType,
  DelegationProgressReadModel,
} from '../../delegation-progress-read-model.js'
import type { DelegationProgressRouteReceiptRecord, DelegationProgressRouteReceiptState, WorkEventRecord } from '../../work-store.js'

export interface FakeDelegationProgressReadModel extends DelegationProgressReadModel {
  readonly events: WorkEventRecord[]
  append(...events: WorkEventRecord[]): void
}

export function createFakeDelegationProgressReadModel(input: { events?: WorkEventRecord[] } = {}): FakeDelegationProgressReadModel {
  const events = [...(input.events || [])]
  return {
    events,
    append(...newEvents) {
      events.push(...newEvents)
    },
    listProgressEvents(options = {}) {
      return newestFirst(events.filter(event => event.type === 'delegation.progress'), clampLimit(options.limit, 1000))
        .reverse()
    },
    listDeliveryEvents(input) {
      const since = input.since.getTime()
      return newestFirst(events.filter(event =>
        isDeliveryType(event.type)
        && event.type === input.type
        && event.subjectId === input.dedupeKey
        && Date.parse(event.createdAt) >= since
      ), clampLimit(input.limit, 1000))
    },
    listRouteReceipts(input = {}) {
      const since = input.since?.getTime()
      const latestByDedupeKey = new Map<string, WorkEventRecord>()
      for (const event of newestFirst(events.filter(isRouteReceiptEvent), 5000)) {
        const dedupeKey = String(event.payload['dedupeKey'] || event.subjectId || '')
        if (dedupeKey && !latestByDedupeKey.has(dedupeKey)) latestByDedupeKey.set(dedupeKey, event)
      }
      return [...latestByDedupeKey.values()].slice(0, clampLimit(input.limit, 1000))
        .map(event => routeReceiptFromEvent(event, routeReceiptPreviousState(events, event)))
        .filter(receipt =>
          (!input.dedupeKey || receipt.dedupeKey === input.dedupeKey) &&
          (!input.progressKey || receipt.progressKey === input.progressKey) &&
          (!input.idempotencyKey || receipt.idempotencyKey === input.idempotencyKey) &&
          (since === undefined || Date.parse(receipt.updatedAt) >= since)
        )
    },
  }
}

function newestFirst(events: WorkEventRecord[], limit: number): WorkEventRecord[] {
  return [...events].sort((a, b) => b.id - a.id).slice(0, limit)
}

function clampLimit(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(value || fallback, 5000))
}

function isDeliveryType(value: string): value is DelegationProgressDeliveryEventType {
  return value === 'delegation.progress.notified' || value === 'delegation.progress.failed'
}

function isRouteReceiptEvent(event: WorkEventRecord): boolean {
  return event.type === 'delegation.progress.attempting' || event.type === 'delegation.progress.notified' || event.type === 'delegation.progress.failed' || event.type === 'delegation.progress.suppressed'
}

function routeReceiptFromEvent(event: WorkEventRecord, previousState?: DelegationProgressRouteReceiptState): DelegationProgressRouteReceiptRecord {
  const state = routeReceiptStateFromEvent(event, previousState)
  const receipt: DelegationProgressRouteReceiptRecord = {
    dedupeKey: String(event.payload['dedupeKey'] || event.subjectId || ''),
    progressKey: stringValue(event.payload['progressKey']),
    idempotencyKey: stringValue(event.payload['idempotencyKey']),
    progress: event.payload['progress'] as any,
    targetKey: stringValue(event.payload['targetKey']),
    provider: stringValue(event.payload['provider']),
    sessionId: stringValue(event.payload['sessionId']),
    delivery: stringValue(event.payload['delivery']),
    state,
    reason: stringValue(event.payload['reason']),
    error: stringValue(event.payload['error']),
    deferredUntil: stringValue(event.payload['deferredUntil']),
    suppressedUntil: stringValue(event.payload['suppressedUntil']),
    progressEventId: numberValue(event.payload['progressEventId']),
    attemptCount: 1,
    lastEventId: event.id,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
    nextAction: routeReceiptNextAction(state, stringValue(event.payload['error']), stringValue(event.payload['deferredUntil'])),
  }
  return receipt
}

function routeReceiptPreviousState(events: WorkEventRecord[], event: WorkEventRecord): DelegationProgressRouteReceiptState | undefined {
  const dedupeKey = String(event.payload['dedupeKey'] || event.subjectId || '')
  const previous = events
    .filter(row => row.id < event.id && isRouteReceiptEvent(row) && String(row.payload['dedupeKey'] || row.subjectId || '') === dedupeKey)
    .sort((a, b) => b.id - a.id)[0]
  return previous ? routeReceiptStateFromEvent(previous) : undefined
}

function routeReceiptStateFromEvent(event: WorkEventRecord, previousState?: DelegationProgressRouteReceiptState): DelegationProgressRouteReceiptState {
  if (event.type === 'delegation.progress.attempting') return 'pending'
  if (event.type === 'delegation.progress.notified') return previousState === 'failed' ? 'retried' : 'delivered'
  if (event.type === 'delegation.progress.failed') return 'failed'
  const delivery = stringValue(event.payload['delivery'])
  const reason = stringValue(event.payload['reason'])?.toLowerCase() || ''
  if (delivery === 'muted') return 'muted'
  if (delivery === 'deferred' && reason.includes('missing parent session')) return 'orphaned'
  if (delivery === 'deferred' && reason.includes('session client unavailable')) return 'stale_parent'
  if (delivery === 'deferred') return 'deferred'
  return 'suppressed'
}

function routeReceiptNextAction(state: DelegationProgressRouteReceiptState, error?: string, deferredUntil?: string): string {
  if (state === 'delivered') return 'No action; delivery receipt is present.'
  if (state === 'retried') return 'No action; delivery succeeded after a previous failed attempt.'
  if (state === 'failed' && error && /\btimed out after \d+ms\b/.test(error)) return 'Retry after the timeout cooldown, or repair the target adapter before rerunning progress delivery.'
  if (state === 'failed') return 'Repair the delivery target and rerun delegated progress delivery.'
  if (state === 'stale_parent') return 'Reconnect the parent OpenCode session client, then rerun delegated progress delivery.'
  if (state === 'orphaned') return 'Rebind the delegated work to a parent session or trusted channel before claiming delivery.'
  if (state === 'muted') return 'Unmute the target or change notification policy before expecting delivery.'
  if (state === 'deferred') return deferredUntil ? `Wait until ${deferredUntil}, then rerun delegated progress delivery.` : 'Resolve the deferral reason, then rerun delegated progress delivery.'
  if (state === 'suppressed') return 'Inspect notification policy and target binding before retrying.'
  return 'Run delegated progress delivery for this pending route.'
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}
