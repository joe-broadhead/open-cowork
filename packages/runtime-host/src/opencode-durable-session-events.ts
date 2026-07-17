/**
 * Shared helpers for OpenCode V2 durable per-session event streams
 * (`v2.session.events` + `admittedSeq` / `after` cursors).
 *
 * Cloud workers and standalone gateway already consume the durable aggregate
 * for transcript truth. Desktop local runtime uses the same predicates so the
 * global control-plane stream and per-session durable tails do not double-project.
 */

import { readString } from '@open-cowork/shared'

export type DurableSequenceCursor = {
  /** Last observed durable.seq for this session, or -1 if none. */
  lastSequence: number
  /** Optional last SSE event id used when durable.seq is absent. */
  after?: string
}

/**
 * Initial `after` cursor for a durable subscription.
 *
 * - After live events: resume from the last observed sequence (exclusive upper
 *   bound is encoded by OpenCode as `after: lastSequence`).
 * - On first admission: start just before the admitted input sequence so the
 *   admitted prompt and its outputs are replayable (standalone/cloud contract).
 */
export function durableAfterCursor(options: {
  lastSequence?: number | null
  admittedSeq?: number | null
}): string | undefined {
  const last = options.lastSequence
  if (typeof last === 'number' && Number.isSafeInteger(last) && last >= 0) {
    return String(last)
  }
  const admitted = options.admittedSeq
  if (typeof admitted === 'number' && Number.isSafeInteger(admitted) && admitted > 0) {
    return String(admitted - 1)
  }
  return undefined
}

export function isTrackedTranscriptEventType(type: string | null | undefined): boolean {
  if (!type) return false
  return type.startsWith('session.next.')
    || type === 'message.updated'
    || type === 'message.part.updated'
    || type === 'message.part.delta'
}

export function isTrackedTerminalEventType(
  type: string | null | undefined,
  statusType?: string | null,
): boolean {
  if (type === 'session.idle') return true
  if (type === 'session.status' && statusType === 'idle') return true
  return false
}

/**
 * When a session is owned by a durable `v2.session.events` subscription, the
 * global `v2.event.subscribe` tail must not project the same transcript or
 * idle terminal — two independent SSE connections cannot guarantee order.
 */
export function shouldSuppressGlobalEventForTrackedSession(
  tracked: boolean,
  type: string | null | undefined,
  statusType?: string | null,
): boolean {
  if (!tracked) return false
  return isTrackedTranscriptEventType(type)
    || isTrackedTerminalEventType(type, statusType)
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function readDurableSequenceFromEvent(raw: unknown): number | null {
  const envelope = objectRecord(raw)
  if (!envelope) return null
  // Prefer nested payload (cloud envelopes) then the event root.
  const payload = objectRecord(envelope.payload) || envelope
  const durable = objectRecord(payload.durable) || objectRecord(envelope.durable)
  if (!durable) return null
  const seq = durable.seq
  if (typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0) return seq
  return null
}

export function readSessionStatusType(properties: Record<string, unknown> | null | undefined): string | null {
  if (!properties) return null
  const status = objectRecord(properties.status)
  return readString(status?.type)
    || readString(properties.statusType)
    || null
}

export function advanceDurableCursor(
  cursor: DurableSequenceCursor,
  raw: unknown,
  fallbackAfter?: string,
): DurableSequenceCursor {
  const sequence = readDurableSequenceFromEvent(raw)
  if (sequence !== null) {
    if (sequence <= cursor.lastSequence) return cursor
    return {
      lastSequence: sequence,
      after: String(sequence),
    }
  }
  if (fallbackAfter && fallbackAfter !== cursor.after) {
    return { ...cursor, after: fallbackAfter }
  }
  return cursor
}
