import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import { normalizeRuntimeEventEnvelope } from '@open-cowork/runtime-host'
import { asRecord, readRecordString, readString } from '@open-cowork/shared'
import { classifyOpenCodeProgressEvent } from '@open-cowork/shared/progress-watchdog'

export type NativeRuntimeEventIdentity = {
  id: string | null
  sessionId: string | null
  aggregateId: string | null
  sequence: number | null
  type: string | null
}

export function readNativeSessionId(properties: Record<string, unknown>) {
  const part = asRecord(properties.part)
  const info = asRecord(properties.info)
  const status = asRecord(properties.status)
  return readRecordString(properties, ['sessionID', 'sessionId'])
    || readRecordString(part, ['sessionID', 'sessionId'])
    || readRecordString(info, ['sessionID', 'sessionId'])
    || readRecordString(status, ['sessionID', 'sessionId'])
}

export function readNativeMessageId(properties: Record<string, unknown>) {
  const part = asRecord(properties.part)
  const info = asRecord(properties.info)
  return readRecordString(properties, ['messageID', 'messageId'])
    || readRecordString(part, ['messageID', 'messageId'])
    || readRecordString(info, ['id'])
}

export function nativeRuntimeEventIdentity(raw: unknown): NativeRuntimeEventIdentity {
  const envelope = asRecord(raw)
  const payload = asRecord(envelope.payload)
  const source = readString(payload.type) ? payload : envelope
  const durable = asRecord(source.durable)
  const normalized = normalizeRuntimeEventEnvelope(raw)
  const sequence = typeof durable.seq === 'number' && Number.isSafeInteger(durable.seq)
    ? durable.seq
    : null
  return {
    id: readString(source.id) || readString(envelope.id),
    sessionId: normalized ? readNativeSessionId(normalized.properties || {}) : null,
    aggregateId: readString(durable.aggregateID),
    sequence,
    type: normalized?.type || null,
  }
}

export function stableProjectedRuntimeEventId(identity: NativeRuntimeEventIdentity, index: number) {
  if (identity.aggregateId && identity.sequence !== null) {
    return `opencode:${identity.aggregateId}:${identity.sequence}:${index}`
  }
  if (identity.id) return `opencode:${identity.id}:${index}`
  return undefined
}

export function nativeRuntimeStatusType(raw: unknown) {
  const normalized = normalizeRuntimeEventEnvelope(raw)
  if (normalized?.type !== 'session.status') return null
  const properties = normalized.properties || {}
  const status = asRecord(properties.status)
  return readRecordString(status, ['type']) || readRecordString(properties, ['statusType'])
}

export function nativeRuntimeOutputMeasure(raw: unknown) {
  const normalized = normalizeRuntimeEventEnvelope(raw)
  const properties = normalized?.properties || {}
  const part = asRecord(properties.part)
  const text = readString(part.text)
    || (normalized?.type?.endsWith('.ended') ? readString(properties.text) : null)
  if (!text) return null
  const messageId = readNativeMessageId(properties)
    || readRecordString(properties, ['assistantMessageID'])
  const outputId = readRecordString(part, ['id'])
    || readRecordString(properties, ['textID', 'reasoningID'])
    || messageId
    || normalized?.type
  const streamId = outputId
    ? [normalized?.type || 'output', messageId || 'message', outputId].join(':')
    : null
  return streamId ? { streamId, length: text.length } : null
}

function nativeRuntimeRetryDeadline(raw: unknown, observedAtMs: number) {
  const normalized = normalizeRuntimeEventEnvelope(raw)
  const status = asRecord(normalized?.properties?.status)
  const next = typeof status.next === 'number' && Number.isFinite(status.next) ? status.next : null
  return next === null ? undefined : observedAtMs + Math.max(0, next - Date.now())
}

export function classifyNativeRuntimeProgress(raw: unknown, progressCursor?: number) {
  const identity = nativeRuntimeEventIdentity(raw)
  if (!identity.type) return null
  const observedAtMs = performance.now()
  const classified = classifyOpenCodeProgressEvent({
    type: identity.type,
    sequence: identity.sequence,
    statusType: nativeRuntimeStatusType(raw),
    retryAtMs: nativeRuntimeRetryDeadline(raw, observedAtMs),
    progressCursor,
  })
  if (!classified) return null
  const eventKey = identity.sequence === null && identity.id
    ? createHash('sha256').update(identity.id).digest('hex').slice(0, 24)
    : null
  return {
    ...classified,
    ...(eventKey ? { semanticKey: `${classified.semanticKey}:${eventKey}` } : {}),
    observedAtMs,
    runtimeSessionId: identity.sessionId,
  }
}
