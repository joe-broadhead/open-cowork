/**
 * JOE-838: Canonical OpenCode SDK → product event translator.
 *
 * Desktop, Cloud, and Standalone Gateway must share one envelope normalizer and
 * one SDK-type classification table. Surfaces fan out *after* translation only
 * (payload shaping, IPC, channel delivery) — they must not re-parse raw SDK
 * envelopes independently.
 */

import {
  asRecord,
  readRecordString,
  readString,
  type JsonRecord,
} from './normalizer-utils.js'

export type NormalizedOpencodeEventEnvelope = {
  type: string
  properties: JsonRecord
}

/** Product kinds that survive into Cloud/Desktop projection contracts. */
export type OpencodeProductEventKind =
  | 'assistant.message'
  | 'tool.call'
  | 'permission.requested'
  | 'permission.resolved'
  | 'question.asked'
  | 'question.resolved'
  | 'todos.updated'
  | 'session.status'
  | 'session.idle'
  | 'runtime.error'
  | 'cost.updated'

/**
 * Standalone channel vocabulary is a slim subset of the product contract.
 * Tool lifecycle is expanded (started/completed/failed) for channel UX.
 */
export type StandaloneProductEventKind =
  | 'assistant.message'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'permission.requested'
  | 'permission.resolved'
  | 'question.asked'
  | 'question.resolved'
  | 'session.status'
  | 'session.error'

export type OpencodeEventDisposition =
  | { status: 'project'; kinds: OpencodeProductEventKind[] }
  | { status: 'private' }
  | { status: 'benign' }
  | { status: 'live-only' }
  | { status: 'unknown' }

export type OpencodeEventTranslation = {
  envelope: NormalizedOpencodeEventEnvelope | null
  disposition: OpencodeEventDisposition | { status: 'invalid' }
}

/**
 * Control-plane / catalog noise that must never spam unknown-event logs and
 * must never enter product projection.
 */
export const OPENCODE_BENIGN_EVENT_TYPES = Object.freeze(new Set([
  'server.connected',
  'plugin.added',
  'plugin.removed',
  'catalog.updated',
  'reference.updated',
  'integration.updated',
  'installation.updated',
  'lsp.updated',
  'file.edited',
  'file.watcher.updated',
  'vcs.branch.updated',
  'project.updated',
  'server.heartbeat',
]))

/**
 * Live desktop streaming types that the desktop SessionEngine projects
 * incrementally. Cloud/standalone either ignore them or map them through
 * content-sensitive paths — they are not "unknown".
 */
export const OPENCODE_LIVE_ONLY_EVENT_TYPES = Object.freeze(new Set([
  'message.updated',
  'message.part.delta',
  'message.part.updated',
  'session.next.text.delta',
  'session.next.text.ended',
  'session.next.reasoning.delta',
  'session.next.reasoning.ended',
  'session.next.tool.called',
  'session.next.tool.progress',
  'session.next.tool.success',
  'session.next.tool.failed',
  'session.next.step.started',
  'session.next.step.ended',
  'session.next.step.failed',
]))

function hasEnumerableOwnProperty(value: Record<string, unknown>) {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return true
  }
  return false
}

/**
 * Normalize any SDK / SSE / durable envelope into `{ type, properties }`.
 * Accepts stringified JSON (Standalone SSE sometimes delivers strings).
 */
export function normalizeOpencodeEventEnvelope(value: unknown): NormalizedOpencodeEventEnvelope | null {
  const parsed = typeof value === 'string' ? parseJsonObject(value) : value
  const envelope = asRecord(parsed)
  const payload = asRecord(envelope.payload)
  const source = readRecordString(payload, ['type']) ? payload : envelope
  const nested = asRecord(source.data)
  const sourceType = readRecordString(source, ['type'])
  const rawType = sourceType === 'sync'
    ? readRecordString(source, ['name']) || readRecordString(nested, ['type'])
    : sourceType || readRecordString(nested, ['type'])
  const type = rawType?.replace(/\.\d+$/, '') || null
  if (!type) return null
  const sourceProperties = asRecord(source.properties)
  const nestedProperties = asRecord(nested.properties)
  const properties = hasEnumerableOwnProperty(sourceProperties)
    ? sourceProperties
    : hasEnumerableOwnProperty(nestedProperties)
      ? nestedProperties
      : nested
  return {
    type,
    properties,
  }
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return {}
  }
}

function partType(properties: JsonRecord): string | null {
  return readString(asRecord(properties.part).type)
}

function partHasText(properties: JsonRecord): boolean {
  const text = asRecord(properties.part).text
  return typeof text === 'string' && text.length > 0
}

function isUserRole(properties: JsonRecord): boolean {
  const role = readString(properties.role)
    || readString(asRecord(properties.info).role)
    || readString(asRecord(properties.message).role)
  return role === 'user'
}

/**
 * Classify an already-normalized SDK event type into a product disposition.
 * Content-sensitive types (message.part.updated, native tools/text) inspect
 * properties so Cloud/Desktop/Standalone share the same kind decisions.
 */
export function classifyOpencodeSdkEvent(
  sdkType: string,
  properties: JsonRecord = {},
): OpencodeEventDisposition {
  if (OPENCODE_BENIGN_EVENT_TYPES.has(sdkType)) {
    return { status: 'benign' }
  }

  switch (sdkType) {
    case 'session.next.reasoning.delta':
    case 'session.next.reasoning.ended':
      return { status: 'private' }

    case 'permission.asked':
    case 'permission.updated':
    case 'permission.v2.asked':
      return { status: 'project', kinds: ['permission.requested'] }

    case 'permission.replied':
    case 'permission.v2.replied':
      return { status: 'project', kinds: ['permission.resolved'] }

    case 'question.asked':
    case 'question.v2.asked':
      return { status: 'project', kinds: ['question.asked'] }

    case 'question.replied':
    case 'question.rejected':
    case 'question.v2.replied':
    case 'question.v2.rejected':
      return { status: 'project', kinds: ['question.resolved'] }

    case 'todo.updated':
      return { status: 'project', kinds: ['todos.updated'] }

    case 'session.idle':
      return { status: 'project', kinds: ['session.idle'] }

    case 'session.status':
      return { status: 'project', kinds: ['session.status'] }

    case 'session.next.step.started':
      return { status: 'project', kinds: ['session.status'] }

    case 'session.next.step.ended':
      return { status: 'project', kinds: ['cost.updated'] }

    case 'session.next.step.failed':
    case 'session.error':
      return { status: 'project', kinds: ['runtime.error'] }

    case 'session.next.tool.called':
    case 'session.next.tool.progress':
    case 'session.next.tool.success':
    case 'session.next.tool.failed':
      return { status: 'project', kinds: ['tool.call'] }

    case 'session.next.text.delta':
    case 'session.next.text.ended':
      return { status: 'project', kinds: ['assistant.message'] }

    case 'message.part.delta': {
      if (readString(properties.field) !== 'text') return { status: 'private' }
      const delta = properties.delta
      if (typeof delta !== 'string' || !delta) return { status: 'private' }
      return { status: 'project', kinds: ['assistant.message'] }
    }

    case 'message.part.updated': {
      const type = partType(properties)
      if (type === 'tool') return { status: 'project', kinds: ['tool.call'] }
      if (type === 'step-finish') return { status: 'project', kinds: ['cost.updated'] }
      if (type === 'text' && partHasText(properties) && !isUserRole(properties)) {
        return { status: 'project', kinds: ['assistant.message'] }
      }
      // Non-projectable part updates are still recognized (not unknown).
      return { status: 'live-only' }
    }

    case 'message.updated':
      // Full message snapshots: Cloud may project assistant text; desktop live
      // path owns incremental UI. Mark live-only when not clearly projectable.
      return { status: 'live-only' }

    default:
      if (OPENCODE_LIVE_ONLY_EVENT_TYPES.has(sdkType)) {
        return { status: 'live-only' }
      }
      return { status: 'unknown' }
  }
}

/** Full raw → envelope + disposition (invalid when envelope cannot parse). */
export function translateOpencodeEvent(raw: unknown): OpencodeEventTranslation {
  const envelope = normalizeOpencodeEventEnvelope(raw)
  if (!envelope) {
    return { envelope: null, disposition: { status: 'invalid' } }
  }
  return {
    envelope,
    disposition: classifyOpencodeSdkEvent(envelope.type, envelope.properties),
  }
}

export function readOpencodeEntityId(
  sdkType: string,
  properties: JsonRecord,
  envelopeId?: string | null,
): string | null {
  switch (sdkType) {
    case 'permission.asked':
    case 'permission.updated':
    case 'permission.v2.asked':
      return readRecordString(properties, ['id'])
        || readString(asRecord(properties.permission).id)
        || envelopeId
        || null
    case 'permission.replied':
    case 'permission.v2.replied':
      return readRecordString(properties, ['requestID', 'requestId', 'id']) || envelopeId || null
    case 'question.asked':
    case 'question.v2.asked':
      return readRecordString(properties, ['id', 'requestID', 'requestId']) || envelopeId || null
    case 'question.replied':
    case 'question.rejected':
    case 'question.v2.replied':
    case 'question.v2.rejected':
      return readRecordString(properties, ['requestID', 'requestId', 'id']) || envelopeId || null
    case 'session.next.tool.called':
    case 'session.next.tool.progress':
    case 'session.next.tool.success':
    case 'session.next.tool.failed':
      return readRecordString(properties, ['callID', 'callId', 'id']) || envelopeId || null
    default:
      return readRecordString(properties, ['id', 'callID', 'callId', 'requestID', 'requestId'])
        || envelopeId
        || null
  }
}

/**
 * Map a classified SDK event into Standalone channel event kinds.
 * Tool call expands by lifecycle; runtime.error maps to session.error.
 */
export function mapToStandaloneProductKinds(
  sdkType: string,
  disposition: OpencodeEventDisposition,
): StandaloneProductEventKind[] {
  if (disposition.status !== 'project') return []

  switch (sdkType) {
    case 'session.next.tool.called':
    case 'session.next.tool.progress':
      return ['tool.started']
    case 'session.next.tool.success':
      return ['tool.completed']
    case 'session.next.tool.failed':
      return ['tool.failed']
    case 'session.next.step.failed':
    case 'session.error':
      return ['session.error']
    case 'session.idle':
    case 'session.status':
    case 'session.next.step.started':
      return ['session.status']
    default:
      break
  }

  const kinds: StandaloneProductEventKind[] = []
  for (const kind of disposition.kinds) {
    if (kind === 'assistant.message') kinds.push('assistant.message')
    else if (kind === 'permission.requested') kinds.push('permission.requested')
    else if (kind === 'permission.resolved') kinds.push('permission.resolved')
    else if (kind === 'question.asked') kinds.push('question.asked')
    else if (kind === 'question.resolved') kinds.push('question.resolved')
    else if (kind === 'runtime.error') kinds.push('session.error')
    else if (kind === 'session.status' || kind === 'session.idle') kinds.push('session.status')
    else if (kind === 'tool.call') {
      // message.part.updated tool snapshots project as completed for channels
      kinds.push('tool.completed')
    }
    // todos.updated / cost.updated intentionally omitted from standalone channels
  }
  return kinds
}

export type StandaloneTranslatedEvent = {
  type: StandaloneProductEventKind
  entityId?: string | null
  payload: JsonRecord
  sdkType: string
}

/**
 * Canonical Standalone projection: envelope + classify + channel kinds.
 * Payload is the normalized properties bag (surfaces may sanitize further).
 */
export function translateOpencodeEventForStandalone(raw: unknown): StandaloneTranslatedEvent[] {
  const { envelope, disposition } = translateOpencodeEvent(raw)
  if (!envelope || disposition.status === 'invalid') return []
  if (disposition.status !== 'project') return []

  // Standalone channel contract intentionally drops reasoning, todos, and cost.
  // Only durable channel-relevant project kinds are emitted.
  const kinds = mapToStandaloneProductKinds(envelope.type, disposition)
  if (kinds.length === 0) return []

  // Text-ended only when there is text (matches historical standalone behavior).
  if (
    (envelope.type === 'session.next.text.ended' || envelope.type === 'session.next.text.delta')
    && !readRecordString(envelope.properties, [envelope.type.endsWith('.delta') ? 'delta' : 'text'])
  ) {
    return []
  }

  const entityId = readOpencodeEntityId(envelope.type, envelope.properties)
  return kinds.map((type) => ({
    type,
    entityId,
    payload: envelope.properties,
    sdkType: envelope.type,
  }))
}
