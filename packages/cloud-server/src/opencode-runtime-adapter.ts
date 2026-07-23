import { createNodeManagedOpencodeServer } from '@open-cowork/runtime-host/runtime-node-managed-server'
import { buildManagedRuntimeEnvironment } from '@open-cowork/runtime-host/runtime-environment'
import {
  createManagedOpencodeServerAuth,
  normalizeMessagePart,
  normalizeRuntimeEventEnvelope,
  normalizeSessionInfo,
  normalizeToolAttachments,
  type ManagedOpencodeServerAuth,
  type ManagedOpencodeServerLogLevel,
  type ManagedOpencodeServerUnexpectedExit,
} from '@open-cowork/runtime-host'
import {
  asRecord,
  deriveToolStatus,
  normalizeCloudToolAttachments,
  normalizePermissionEvent,
  readRecordNestedRecord,
  readRecordString,
  readString,
  RUNTIME_EVENT_MAX_COLLECTION_ENTRIES,
  RUNTIME_EVENT_MAX_STRING_BYTES,
  sanitizeRuntimeEventRecord,
  sanitizeRuntimeEventValue,
  sanitizeCloudToolOutput,
  translateOpencodeEvent,
} from '@open-cowork/shared'
import type { OpencodeClient, OpencodeClientConfig } from '@opencode-ai/sdk/v2'
import {
  buildAuthenticatedOpencodeV2ClientConfig,
  createOpencodeV2Client,
} from '@open-cowork/runtime-host/opencode-client-kernel'
import {
  cloudDurableReconnectDelayMs,
  nextReconnectFailureCount,
  OPENCODE_SSE_OWNED_MAX_RETRY_ATTEMPTS,
  waitForAbortableDelay,
} from '@open-cowork/runtime-host'
import type { ServerOptions as OpencodeServerOptions } from '@opencode-ai/sdk/v2/server'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PathProvider } from './path-provider.ts'
import {
  createSdkCloudRuntimeAdapter,
  type CloudRuntimeAdapter,
  type CloudRuntimeDroppedEvent,
  type CloudRuntimeEvent,
  type CloudRuntimeEventListener,
  type CloudRuntimeSubscribeOptions,
} from './runtime-adapter.ts'

export type NodeOpencodeCloudRuntimeAdapter = CloudRuntimeAdapter & {
  url: string
  auth: ManagedOpencodeServerAuth
}

export type NodeOpencodeCloudRuntimeOptions = {
  paths: PathProvider
  config?: OpencodeServerOptions['config']
  configDelivery?: 'env' | 'ephemeral-file'
  env?: NodeJS.ProcessEnv
  hostname?: string
  port?: number
  timeout?: number
  cwd?: string
  logLevel?: ManagedOpencodeServerLogLevel
  opencodeBinPath?: string | null
  enableNativeWebSearch?: boolean
  onUnexpectedExit?: (event: ManagedOpencodeServerUnexpectedExit) => void
}

export type OpencodeRuntimeEventTranslation = {
  events: CloudRuntimeEvent[]
  dropped: CloudRuntimeDroppedEvent | null
}

function boundedArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, RUNTIME_EVENT_MAX_COLLECTION_ENTRIES) : []
}

function hasEnumerableOwnProperty(value: Record<string, unknown>) {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return true
  }
  return false
}

function boundedTextContent(value: unknown) {
  let output = ''
  for (const candidate of boundedArray(value)) {
    const entry = asRecord(candidate)
    if (readString(entry.type) !== 'text') continue
    const text = readString(entry.text) || ''
    const remaining = RUNTIME_EVENT_MAX_STRING_BYTES - output.length
    if (remaining <= 0) break
    output += text.slice(0, remaining)
  }
  return output
}

// SDK-payload reader helpers (asRecord/readString/readRecordString/
// readRecordNestedRecord) are consolidated in @open-cowork/shared so the
// cloud projection and the desktop runtime share one definition. The prior
// local `readString` copy trimmed whitespace while the shared one keys off
// length; for the SDK event fields read here (ids, roles, tool names) the
// two are equivalent — neither ever carries a whitespace-only value — so the
// shared definition is the single source of truth.

function readSessionId(properties: Record<string, unknown>) {
  const part = asRecord(properties.part)
  const info = asRecord(properties.info)
  const status = asRecord(properties.status)
  return readRecordString(properties, ['sessionID', 'sessionId'])
    || readRecordString(part, ['sessionID', 'sessionId'])
    || readRecordString(info, ['sessionID', 'sessionId'])
    || readRecordString(status, ['sessionID', 'sessionId'])
}

function readMessageId(properties: Record<string, unknown>) {
  const part = asRecord(properties.part)
  const info = asRecord(properties.info)
  return readRecordString(properties, ['messageID', 'messageId'])
    || readRecordString(part, ['messageID', 'messageId'])
    || readRecordString(info, ['id'])
}

function readErrorMessage(properties: Record<string, unknown>) {
  const error = asRecord(properties.error)
  const message = readRecordString(properties, ['message', 'error'])
    || readRecordString(error, ['message', 'error'])
    || 'OpenCode runtime reported an error.'
  const sanitized = sanitizeRuntimeEventValue(message)
  return typeof sanitized === 'string' ? sanitized : 'OpenCode runtime reported an error.'
}

function boundedRuntimeString(value: unknown, fallback?: string) {
  const sanitized = sanitizeRuntimeEventValue(value)
  return typeof sanitized === 'string' && sanitized ? sanitized : fallback
}

function eventFromMessagePartUpdated(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const part = normalizeMessagePart(properties.part)
  if (!part) return []

  if (part.type === 'tool') {
    const state = part.state
    const status = deriveToolStatus({
      hasOutput: state.output !== undefined,
      hasError: state.status === 'error' || state.error !== undefined,
      statusHint: typeof state.status === 'string' ? state.status : undefined,
    })
    const input = sanitizeRuntimeEventRecord(hasEnumerableOwnProperty(state.input) ? state.input : state.args)
    const sessionId = readSessionId(properties)
    const rawOutput = state.output !== undefined ? state.output : state.result
    const output = rawOutput !== undefined ? sanitizeCloudToolOutput(rawOutput, state.outputPaths) : undefined
    const attachments = normalizeCloudToolAttachments(normalizeToolAttachments(state.attachments, part.attachments))
    return [{
      type: 'tool.call',
      payload: {
        ...(sessionId ? { sessionId } : {}),
        id: boundedRuntimeString(part.callId || part.id),
        name: boundedRuntimeString(part.tool || part.name || part.title, 'tool'),
        input,
        status,
        ...(output !== undefined ? { output } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(part.agent ? { agent: part.agent } : {}),
      },
    }]
  }

  if (part.type === 'step-finish' && (part.cost !== null || part.tokens)) {
    const sessionId = readSessionId(properties)
    return [{
      type: 'cost.updated',
      payload: {
        ...(sessionId ? { sessionId } : {}),
        id: [
          sessionId || 'session',
          readMessageId(properties) || 'message',
          part.id || 'step-finish',
        ].join(':'),
        cost: part.cost || 0,
        tokens: part.tokens,
      },
    }]
  }

  if (part.type !== 'text' || !part.text) return []
  const role = readString(properties.role)
    || readString(asRecord(properties.info).role)
    || readString(asRecord(properties.message).role)
  if (role === 'user') return []
  const sessionId = readSessionId(properties)
  return [{
    type: 'assistant.message',
    payload: {
      ...(sessionId ? { sessionId } : {}),
      messageId: readMessageId(properties) || part.id || undefined,
      content: part.text,
    },
  }]
}

// `message.part.delta` carries an incremental token chunk for a single
// message part ({ sessionID, messageID, partID, field, delta }). Projecting
// it as an append-mode assistant.message lets cloud SSE stream token-granular
// like the desktop runtime instead of re-sending a full snapshot on every
// `message.part.updated`. Only the streamed text field is surfaced as
// assistant content; the delta string is read verbatim so word-boundary
// whitespace is preserved.
function eventFromMessagePartDelta(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  if (readString(properties.field) !== 'text') return []
  const delta = typeof properties.delta === 'string' ? properties.delta : ''
  if (!delta) return []
  const sessionId = readSessionId(properties)
  const messageId = readMessageId(properties)
  return [{
    type: 'assistant.message',
    payload: {
      ...(sessionId ? { sessionId } : {}),
      ...(messageId ? { messageId } : {}),
      content: delta,
      mode: 'append',
    },
  }]
}

function eventFromNativeText(properties: Record<string, unknown>, mode: 'append' | 'replace'): CloudRuntimeEvent[] {
  const content = readRecordString(properties, [mode === 'append' ? 'delta' : 'text'])
  if (!content) return []
  const sessionId = readSessionId(properties)
  const messageId = readRecordString(properties, ['assistantMessageID'])
  return [{
    type: 'assistant.message',
    payload: {
      ...(sessionId ? { sessionId } : {}),
      ...(messageId ? { messageId } : {}),
      content,
      mode,
    },
  }]
}

function eventsFromNativeTool(eventType: string, properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const sessionId = readSessionId(properties)
  const toolName = boundedRuntimeString(readRecordString(properties, ['tool']))
  const content = boundedArray(properties.content)
  const attachments = normalizeCloudToolAttachments(normalizeToolAttachments(content))
  const textOutput = boundedTextContent(content)
  const output = properties.result !== undefined
    ? sanitizeCloudToolOutput(properties.result, properties.outputPaths)
    : textOutput
      ? sanitizeCloudToolOutput(textOutput, properties.outputPaths)
      : undefined
  const status = eventType === 'session.next.tool.success'
    ? 'complete'
    : eventType === 'session.next.tool.failed'
      ? 'error'
      : 'running'
  return [{
    type: 'tool.call',
    payload: {
      ...(sessionId ? { sessionId } : {}),
      id: boundedRuntimeString(readRecordString(properties, ['callID'])),
      ...(toolName ? { name: toolName } : {}),
      input: sanitizeRuntimeEventRecord(properties.input),
      status,
      ...(output !== undefined ? { output } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(properties.error !== undefined ? { error: sanitizeRuntimeEventValue(properties.error) } : {}),
    },
  }]
}

function eventsFromNativeStepEnded(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const sessionId = readSessionId(properties)
  // Step settlement is the authoritative usage event, but not the session
  // terminal boundary. OpenCode emits a canonical session.idle separately;
  // synthesizing another idle here caused duplicate run-finished side effects.
  return [{
    type: 'cost.updated',
    payload: {
      ...(sessionId ? { sessionId } : {}),
      id: [sessionId || 'session', readRecordString(properties, ['assistantMessageID']) || 'message', 'step-finish'].join(':'),
      cost: typeof properties.cost === 'number' ? properties.cost : 0,
      tokens: asRecord(properties.tokens),
    },
  }]
}

function eventsFromPermissionRequested(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const normalized = normalizePermissionEvent(properties)
  if (!normalized.id) return []
  return [{
    type: 'permission.requested',
    payload: {
      permissionId: normalized.id,
      id: normalized.id,
      ...(normalized.sessionId ? { sessionId: normalized.sessionId } : {}),
      ...(normalized.sessionId ? { sourceSessionId: normalized.sessionId } : {}),
      tool: normalized.title,
      input: sanitizeRuntimeEventRecord(normalized.input),
      description: normalized.title || `Permission requested for ${normalized.permissionType}`,
    },
  }]
}

function eventsFromPermissionResolved(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const normalized = normalizePermissionEvent(properties)
  if (!normalized.id) return []
  const reply = readRecordString(properties, ['reply', 'response'])
  return [{
    type: 'permission.resolved',
    payload: {
      permissionId: normalized.id,
      id: normalized.id,
      ...(normalized.sessionId ? { sessionId: normalized.sessionId } : {}),
      ...(reply ? { reply } : {}),
    },
  }]
}

function normalizeQuestionPrompt(value: unknown) {
  const record = asRecord(value)
  return {
    header: readString(record.header) || '',
    question: readString(record.question) || '',
    options: Array.isArray(record.options)
      ? boundedArray(record.options).map((option) => {
          const optionRecord = asRecord(option)
          return {
            label: readString(optionRecord.label) || '',
            description: readString(optionRecord.description) || '',
          }
        })
      : [],
    multiple: record.multiple === true,
    custom: record.custom !== false,
  }
}

function eventsFromQuestionAsked(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const requestId = readRecordString(properties, ['id', 'requestID', 'requestId'])
  if (!requestId) return []
  const tool = readRecordNestedRecord(properties, ['tool'])
  return [{
    type: 'question.asked',
    payload: {
      requestId,
      id: requestId,
      ...(readSessionId(properties) ? { sessionId: readSessionId(properties) } : {}),
      ...(readSessionId(properties) ? { sourceSessionId: readSessionId(properties) } : {}),
      questions: boundedArray(properties.questions).map(normalizeQuestionPrompt),
      ...(hasEnumerableOwnProperty(tool)
        ? {
            tool: {
              messageId: readRecordString(tool, ['messageID', 'messageId']) || '',
              callId: readRecordString(tool, ['callID', 'callId']) || '',
            },
          }
        : {}),
    },
  }]
}

function eventsFromQuestionResolved(eventType: string, properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const requestId = readRecordString(properties, ['requestID', 'requestId', 'id'])
  if (!requestId) return []
  const rejected = eventType === 'question.rejected' || eventType === 'question.v2.rejected'
  return [{
    type: 'question.resolved',
    payload: {
      requestId,
      id: requestId,
      ...(readSessionId(properties) ? { sessionId: readSessionId(properties) } : {}),
      ...(Array.isArray(properties.answers) ? { answers: sanitizeRuntimeEventValue(properties.answers) } : {}),
      ...(rejected ? { rejected: true } : {}),
    },
  }]
}

function normalizeTodo(value: unknown) {
  const record = asRecord(value)
  return {
    ...(readString(record.id) ? { id: readString(record.id) } : {}),
    content: readString(record.content) || '',
    status: readString(record.status) || 'pending',
    priority: readString(record.priority) || 'medium',
  }
}

function eventsFromTodosUpdated(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  return [{
    type: 'todos.updated',
    payload: {
      ...(readSessionId(properties) ? { sessionId: readSessionId(properties) } : {}),
      todos: boundedArray(properties.todos).map(normalizeTodo),
    },
  }]
}

function eventFromMessageUpdated(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const info = normalizeSessionInfo(properties.info)
  if (!info || info.role !== 'assistant') return []
  const parts = Array.isArray(properties.parts)
    ? boundedArray(properties.parts)
    : Array.isArray(asRecord(properties.message).parts)
      ? boundedArray(asRecord(properties.message).parts)
      : []
  let text = ''
  for (const candidate of parts) {
    const part = normalizeMessagePart(candidate)
    if (part?.type !== 'text' || !part.text) continue
    const remaining = RUNTIME_EVENT_MAX_STRING_BYTES - text.length
    if (remaining <= 0) break
    text += part.text.slice(0, remaining)
  }
  if (!text) return []
  return [{
    type: 'assistant.message',
    payload: {
      ...(info.sessionID ? { sessionId: info.sessionID } : {}),
      messageId: info.id,
      content: text,
    },
  }]
}

function eventFromSessionStatus(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const status = asRecord(properties.status)
  const sessionId = readSessionId(properties)
  return [{
    type: 'session.status',
    payload: {
      ...(sessionId ? { sessionId } : {}),
      statusType: readRecordString(status, ['type']) || readRecordString(properties, ['statusType', 'type']) || 'unknown',
    },
  }]
}

function knownOpencodeRuntimeEvents(eventType: string, properties: Record<string, unknown>): CloudRuntimeEvent[] | null {
  switch (eventType) {
    case 'message.part.delta':
      return eventFromMessagePartDelta(properties)
    case 'message.part.updated':
      return eventFromMessagePartUpdated(properties)
    case 'message.updated':
      return eventFromMessageUpdated(properties)
    case 'session.idle':
      return [{
        type: 'session.idle',
        payload: {
          ...(readSessionId(properties) ? { sessionId: readSessionId(properties) } : {}),
        },
      }]
    case 'session.status':
      return eventFromSessionStatus(properties)
    case 'session.next.step.started':
      return [{
        type: 'session.status',
        payload: {
          ...(readSessionId(properties) ? { sessionId: readSessionId(properties) } : {}),
          statusType: 'busy',
        },
      }]
    case 'session.next.step.ended':
      return eventsFromNativeStepEnded(properties)
    case 'session.next.step.failed':
      return [{
        type: 'runtime.error',
        payload: {
          ...(readSessionId(properties) ? { sessionId: readSessionId(properties) } : {}),
          message: readErrorMessage(properties),
        },
      }]
    case 'session.next.text.delta':
      return eventFromNativeText(properties, 'append')
    case 'session.next.text.ended':
      return eventFromNativeText(properties, 'replace')
    case 'session.next.reasoning.delta':
    case 'session.next.reasoning.ended':
      // Reasoning remains private in the cloud event contract. Recognize the
      // native family explicitly so diagnostics distinguish it from drift.
      return []
    case 'session.next.tool.called':
    case 'session.next.tool.progress':
    case 'session.next.tool.success':
    case 'session.next.tool.failed':
      return eventsFromNativeTool(eventType, properties)
    case 'session.error':
      return [{
        type: 'runtime.error',
        payload: {
          ...(readSessionId(properties) ? { sessionId: readSessionId(properties) } : {}),
          message: readErrorMessage(properties),
        },
      }]
    case 'permission.asked':
    case 'permission.updated':
    case 'permission.v2.asked':
      return eventsFromPermissionRequested(properties)
    case 'permission.replied':
    case 'permission.v2.replied':
      return eventsFromPermissionResolved(properties)
    case 'question.asked':
    case 'question.v2.asked':
      return eventsFromQuestionAsked(properties)
    case 'question.replied':
    case 'question.rejected':
    case 'question.v2.replied':
    case 'question.v2.rejected':
      return eventsFromQuestionResolved(eventType, properties)
    case 'todo.updated':
      return eventsFromTodosUpdated(properties)
    default:
      return null
  }
}

export function translateOpencodeRuntimeEventWithDiagnostics(raw: unknown): OpencodeRuntimeEventTranslation {
  // JOE-838: Canonical envelope + disposition come from shared translator.
  // Cloud only fans out into CloudRuntimeEvent payload shapes after that.
  const translation = translateOpencodeEvent(raw)
  if (!translation.envelope || translation.disposition.status === 'invalid') {
    return {
      events: [],
      dropped: {
        sdkEventType: null,
        reason: 'invalid-envelope',
      },
    }
  }
  const event = translation.envelope
  const disposition = translation.disposition
  if (disposition.status === 'benign' || disposition.status === 'private') {
    return {
      events: [],
      dropped: {
        sdkEventType: event.type,
        reason: 'no-projected-events',
      },
    }
  }
  const properties = event.properties || {}
  // Classification is authoritative for "is this a known SDK family?" —
  // unknown dispositions fail closed as dropped unknown types. live-only and
  // project dispositions still run through Cloud payload fan-out.
  if (disposition.status === 'unknown') {
    return {
      events: [],
      dropped: {
        sdkEventType: event.type,
        reason: 'unknown-event-type',
      },
    }
  }
  const translated = knownOpencodeRuntimeEvents(event.type, properties)
  if (!translated) {
    return {
      events: [],
      dropped: {
        sdkEventType: event.type,
        reason: 'unknown-event-type',
      },
    }
  }
  return {
    events: translated,
    dropped: translated.length === 0
      ? {
          sdkEventType: event.type,
          reason: 'no-projected-events',
        }
      : null,
  }
}

export function translateOpencodeRuntimeEvent(raw: unknown): CloudRuntimeEvent[] {
  return translateOpencodeRuntimeEventWithDiagnostics(raw).events
}

const OPENCODE_SESSION_ACTIVE_POLL_MS = 250
const OPENCODE_SESSION_HISTORY_PAGE_SIZE = 100

type NativeRuntimeEventIdentity = {
  id: string | null
  sessionId: string | null
  aggregateId: string | null
  sequence: number | null
  type: string | null
}

type DurableSessionSubscriptionState = {
  sessionId: string
  after: string | undefined
  lastSequence: number
  executionGeneration: number
  settledGeneration: number
  admissionKeys: Map<number, string>
  ingestTail: Promise<void>
  streamTask: Promise<void> | null
  monitorTask: Promise<void> | null
}

export type OpencodeCloudRuntimeEventSubscription = (() => void) & {
  trackSession(sessionId: string): void
  markSessionAdmitted(sessionId: string, admissionId?: string, admittedSequence?: number): void
}

function nativeRuntimeEventIdentity(raw: unknown): NativeRuntimeEventIdentity {
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
    sessionId: normalized ? readSessionId(normalized.properties || {}) : null,
    aggregateId: readString(durable.aggregateID),
    sequence,
    type: normalized?.type || null,
  }
}

function stableAdmissionEventKey(admissionId: string | null | undefined) {
  const value = admissionId?.trim() || `anonymous:${randomUUID()}`
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function isSessionWaitCapabilityUnavailable(error: unknown) {
  const record = asRecord(error)
  return readString(record._tag) === 'ServiceUnavailableError'
    && readString(record.service) === 'session.wait'
}

function stableProjectedRuntimeEventId(identity: NativeRuntimeEventIdentity, index: number) {
  if (identity.aggregateId && identity.sequence !== null) {
    return `opencode:${identity.aggregateId}:${identity.sequence}:${index}`
  }
  if (identity.id) return `opencode:${identity.id}:${index}`
  return undefined
}

function nativeRuntimeStatusType(raw: unknown) {
  const normalized = normalizeRuntimeEventEnvelope(raw)
  if (normalized?.type !== 'session.status') return null
  const properties = normalized.properties || {}
  const status = asRecord(properties.status)
  return readRecordString(status, ['type']) || readRecordString(properties, ['statusType'])
}

function reportRuntimeSubscriptionError(options: CloudRuntimeSubscribeOptions, error: unknown) {
  try {
    options.onError?.(error)
  } catch {
    // Observability hooks must not disable the durable runtime event stream.
  }
}

function waitForRuntimeEventReconnect(signal: AbortSignal, delayMs: number) {
  return waitForAbortableDelay(signal, delayMs)
}

function cloudReconnectDelayMs(consecutiveFailures: number) {
  return cloudDurableReconnectDelayMs(consecutiveFailures)
}

export function subscribeToOpencodeCloudRuntimeEvents(
  client: OpencodeClient,
  listener: CloudRuntimeEventListener,
  options: CloudRuntimeSubscribeOptions = {},
): OpencodeCloudRuntimeEventSubscription {
  const noop = Object.assign(() => undefined, {
    trackSession() {},
    markSessionAdmitted() {},
  })
  if (options.signal?.aborted) return noop
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const durableSessions = new Map<string, DurableSessionSubscriptionState>()
  const rootSessions = new Set<string>()
  let waitCapabilityUnavailable = false
  let waitFallbackReported = false
  let descendantDiscoveryTask: Promise<void> | null = null

  const deliverRawEvent = async (raw: unknown) => {
    const identity = nativeRuntimeEventIdentity(raw)
    const translation = translateOpencodeRuntimeEventWithDiagnostics(raw)
    if (translation.dropped) options.onDroppedEvent?.(translation.dropped)
    for (const [index, event] of translation.events.entries()) {
      const eventId = stableProjectedRuntimeEventId(identity, index)
      await listener(eventId ? { ...event, eventId } : event)
    }
    return identity
  }

  const ingestDurableEvent = (
    state: DurableSessionSubscriptionState,
    raw: unknown,
    fallbackAfter?: string,
  ) => {
    const next = state.ingestTail.then(async () => {
      const identity = nativeRuntimeEventIdentity(raw)
      if (identity.sequence !== null && identity.sequence <= state.lastSequence) return false
      await deliverRawEvent(raw)
      if (identity.sequence !== null) {
        state.lastSequence = Math.max(state.lastSequence, identity.sequence)
        state.after = String(state.lastSequence)
      } else if (fallbackAfter) {
        state.after = fallbackAfter
      }
      return true
    })
    // Keep the serialization chain usable after a listener failure while
    // returning the original rejection to the stream/reconciliation caller.
    state.ingestTail = next.then(() => undefined, () => undefined)
    return next
  }

  const durableStreamLoop = async (state: DurableSessionSubscriptionState) => {
    let consecutiveFailures = 0
    while (!controller.signal.aborted) {
      let receivedEvent = false
      let streamError: unknown = null
      let lastSseEventId: string | undefined
      try {
        const result = await client.v2.session.events({
          sessionID: state.sessionId,
          ...(state.after ? { after: state.after } : {}),
        }, {
          signal: controller.signal,
          // Own retries so every reconnect carries the last durably persisted
          // aggregate sequence instead of relying on a lossy live-stream retry.
          sseMaxRetryAttempts: OPENCODE_SSE_OWNED_MAX_RETRY_ATTEMPTS,
          onSseError(error) {
            streamError = error
          },
          onSseEvent(event) {
            if (event.id) lastSseEventId = event.id
          },
        })
        for await (const raw of result.stream as AsyncIterable<unknown>) {
          if (controller.signal.aborted) break
          receivedEvent = await ingestDurableEvent(state, raw, lastSseEventId) || receivedEvent
        }
        if (controller.signal.aborted) break
        throw streamError || new Error(`OpenCode durable event stream ended for session ${state.sessionId}.`)
      } catch (error) {
        if (controller.signal.aborted) break
        reportRuntimeSubscriptionError(options, error)
        consecutiveFailures = nextReconnectFailureCount(consecutiveFailures, receivedEvent)
        await waitForRuntimeEventReconnect(controller.signal, cloudReconnectDelayMs(consecutiveFailures))
      }
    }
  }

  const reconcileSessionHistory = async (state: DurableSessionSubscriptionState) => {
    // OpenCode exposes this finite durable counterpart even when session.wait
    // is unavailable. Querying it after active-set quiescence closes the
    // race where the live durable tail has not observed the final commit yet.
    if (typeof client.v2.session.history !== 'function') return
    while (!controller.signal.aborted) {
      const cursorBeforePage = state.lastSequence
      const result = await client.v2.session.history({
        sessionID: state.sessionId,
        limit: OPENCODE_SESSION_HISTORY_PAGE_SIZE,
        ...(state.lastSequence >= 0 ? { after: state.lastSequence } : {}),
      }, {
        throwOnError: true,
        signal: controller.signal,
      })
      for (const raw of result.data.data) {
        if (controller.signal.aborted) return
        await ingestDurableEvent(state, raw)
      }
      if (!result.data.hasMore) return
      if (state.lastSequence <= cursorBeforePage) {
        throw new Error(`OpenCode session history did not advance for ${state.sessionId}.`)
      }
    }
  }

  const deliverAuthoritativeIdle = async (state: DurableSessionSubscriptionState, generation: number) => {
    const admissionKey = state.admissionKeys.get(generation) || stableAdmissionEventKey(null)
    await listener({
      eventId: `opencode:${state.sessionId}:idle:${admissionKey}`,
      type: 'session.idle',
      payload: { sessionId: state.sessionId },
    })
    state.settledGeneration = Math.max(state.settledGeneration, generation)
    for (const completedGeneration of state.admissionKeys.keys()) {
      if (completedGeneration <= generation) state.admissionKeys.delete(completedGeneration)
    }
  }

  const monitorAdmittedSession = async (state: DurableSessionSubscriptionState) => {
    let consecutiveFailures = 0
    while (!controller.signal.aborted && state.settledGeneration < state.executionGeneration) {
      const generation = state.executionGeneration
      let idle: boolean
      if (!waitCapabilityUnavailable) {
        try {
          await client.v2.session.wait({ sessionID: state.sessionId }, {
            throwOnError: true,
            signal: controller.signal,
          })
          consecutiveFailures = 0
        } catch (error) {
          if (controller.signal.aborted) break
          if (isSessionWaitCapabilityUnavailable(error)) {
            // Some OpenCode v2 runtimes advertise wait in the SDK while the server method
            // is an OperationUnavailable stub. Detect only that typed 503 once;
            // auth and transport failures must keep retrying the preferred API.
            waitCapabilityUnavailable = true
            if (!waitFallbackReported) {
              waitFallbackReported = true
              reportRuntimeSubscriptionError(options, error)
            }
          } else {
            reportRuntimeSubscriptionError(options, error)
            consecutiveFailures = nextReconnectFailureCount(consecutiveFailures, false)
            await waitForRuntimeEventReconnect(controller.signal, cloudReconnectDelayMs(consecutiveFailures))
            continue
          }
        }
      }

      try {
        const active = await client.v2.session.active({
          throwOnError: true,
          signal: controller.signal,
        })
        const activeSessionIds = Object.keys(active.data.data)
        // session.wait is root-scoped, while delegated children belong to the
        // same worker process and may outlive their now-idle parent. Verify the
        // complete process-owned drain set even after a successful native wait.
        for (const activeSessionId of activeSessionIds) ensureSessionTracked(activeSessionId)
        idle = activeSessionIds.length === 0
        consecutiveFailures = 0
      } catch (error) {
        if (controller.signal.aborted) break
        reportRuntimeSubscriptionError(options, error)
        consecutiveFailures = nextReconnectFailureCount(consecutiveFailures, false)
        await waitForRuntimeEventReconnect(controller.signal, cloudReconnectDelayMs(consecutiveFailures))
        continue
      }

      if (!idle) {
        await waitForRuntimeEventReconnect(controller.signal, OPENCODE_SESSION_ACTIVE_POLL_MS)
        continue
      }

      try {
        await descendantDiscoveryTask
        await discoverSessionDescendants()
        for (const trackedState of durableSessions.values()) {
          await reconcileSessionHistory(trackedState)
        }
      } catch (error) {
        if (controller.signal.aborted) break
        reportRuntimeSubscriptionError(options, error)
        consecutiveFailures = nextReconnectFailureCount(consecutiveFailures, false)
        await waitForRuntimeEventReconnect(controller.signal, cloudReconnectDelayMs(consecutiveFailures))
        continue
      }

      if (state.executionGeneration === generation) await deliverAuthoritativeIdle(state, generation)
    }
  }

  const ensureSessionTracked = (sessionId: string) => {
    const normalized = sessionId.trim()
    if (!normalized) return null
    const existing = durableSessions.get(normalized)
    if (existing) return existing
    const state: DurableSessionSubscriptionState = {
      sessionId: normalized,
      after: undefined,
      lastSequence: -1,
      executionGeneration: 0,
      settledGeneration: 0,
      admissionKeys: new Map(),
      ingestTail: Promise.resolve(),
      streamTask: null,
      monitorTask: null,
    }
    durableSessions.set(normalized, state)
    state.streamTask = durableStreamLoop(state).finally(() => {
      state.streamTask = null
    })
    return state
  }

  async function discoverSessionDescendants() {
    if (rootSessions.size === 0 || typeof client.v2.session.list !== 'function') return
    const sessions: Array<{ id: string, parentID?: string }> = []
    const seenCursors = new Set<string>()
    let cursor: string | undefined
    while (!controller.signal.aborted) {
      const result = await client.v2.session.list({
        order: 'asc',
        limit: OPENCODE_SESSION_HISTORY_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }, {
        throwOnError: true,
        signal: controller.signal,
      })
      sessions.push(...result.data.data.map((session) => ({
        id: session.id,
        ...(session.parentID ? { parentID: session.parentID } : {}),
      })))
      const next = result.data.cursor.next
      if (!next) break
      if (seenCursors.has(next)) throw new Error('OpenCode session-list cursor repeated during descendant discovery.')
      seenCursors.add(next)
      cursor = next
    }

    const related = new Set(rootSessions)
    let discovered = true
    while (discovered) {
      discovered = false
      for (const session of sessions) {
        if (!session.parentID || !related.has(session.parentID) || related.has(session.id)) continue
        related.add(session.id)
        discovered = true
      }
    }
    for (const sessionId of related) ensureSessionTracked(sessionId)
  }

  function scheduleDescendantDiscovery(): Promise<void> {
    if (descendantDiscoveryTask) return descendantDiscoveryTask
    if (controller.signal.aborted) return Promise.resolve()
    descendantDiscoveryTask = discoverSessionDescendants()
      .catch((error) => {
        if (!controller.signal.aborted) reportRuntimeSubscriptionError(options, error)
      })
      .finally(() => {
        descendantDiscoveryTask = null
      })
    return descendantDiscoveryTask
  }

  const trackSession = (sessionId: string) => {
    const state = ensureSessionTracked(sessionId)
    if (!state) return
    rootSessions.add(state.sessionId)
    void scheduleDescendantDiscovery()
  }

  const ensureSessionMonitorTask = (state: DurableSessionSubscriptionState) => {
    if (state.monitorTask || controller.signal.aborted || state.settledGeneration >= state.executionGeneration) return
    state.monitorTask = monitorAdmittedSession(state)
      .catch((error) => {
        if (!controller.signal.aborted) reportRuntimeSubscriptionError(options, error)
      })
      .finally(() => {
        state.monitorTask = null
        if (!controller.signal.aborted && state.settledGeneration < state.executionGeneration) {
          ensureSessionMonitorTask(state)
        }
      })
  }

  const markSessionAdmitted = (sessionId: string, admissionId?: string, admittedSequence?: number) => {
    const state = ensureSessionTracked(sessionId)
    if (!state) return
    rootSessions.add(state.sessionId)
    void scheduleDescendantDiscovery()
    state.executionGeneration += 1
    const stableId = admissionId?.trim()
      || (Number.isSafeInteger(admittedSequence) ? `${state.sessionId}:sequence:${admittedSequence}` : null)
    state.admissionKeys.set(state.executionGeneration, stableAdmissionEventKey(stableId))
    ensureSessionMonitorTask(state)
  }

  void (async () => {
    let consecutiveFailures = 0
    while (!controller.signal.aborted) {
      let receivedEvent = false
      let streamError: unknown = null
      try {
        const result = await client.v2.event.subscribe({
          signal: controller.signal,
          sseMaxRetryAttempts: OPENCODE_SSE_OWNED_MAX_RETRY_ATTEMPTS,
          onSseError(error) {
            streamError = error
          },
        })
        for await (const raw of result.stream) {
          if (controller.signal.aborted) break
          receivedEvent = true
          const identity = nativeRuntimeEventIdentity(raw)
          let tracked = identity.sessionId ? durableSessions.has(identity.sessionId) : false
          if (identity.sessionId && !tracked && rootSessions.size > 0) {
            // Worker OpenCode processes are product-session scoped. An unknown
            // session ID in this stream is therefore a newly-created child;
            // claim its durable aggregate before classifying the first event so
            // neither that event nor a terminal leaks through the global path.
            tracked = Boolean(ensureSessionTracked(identity.sessionId))
            void scheduleDescendantDiscovery()
          }
          const isTrackedTerminal = tracked && (
            identity.type === 'session.idle'
            || (identity.type === 'session.status' && nativeRuntimeStatusType(raw) === 'idle')
          )
          const isTrackedTranscriptEvent = tracked && (
            identity.type?.startsWith('session.next.')
            || identity.type === 'message.updated'
            || identity.type === 'message.part.updated'
            || identity.type === 'message.part.delta'
          )
          // Per-session V2 streams own replayable transcript boundaries for
          // roots and discovered descendants. Suppress their parallel global
          // snapshots/deltas as well: two independent SSE connections cannot
          // guarantee a delta arrives before its durable replacement.
          if (isTrackedTranscriptEvent || isTrackedTerminal) continue
          await deliverRawEvent(raw)
        }
        if (controller.signal.aborted) break
        throw streamError || new Error('OpenCode runtime event stream ended unexpectedly.')
      } catch (error) {
        if (controller.signal.aborted) break
        reportRuntimeSubscriptionError(options, error)
        // If root tracking already started a scan, wait for it and run a fresh
        // post-gap scan so children created entirely during the outage cannot
        // be hidden by the earlier snapshot.
        await descendantDiscoveryTask
        await scheduleDescendantDiscovery()
        consecutiveFailures = nextReconnectFailureCount(consecutiveFailures, receivedEvent)
        await waitForRuntimeEventReconnect(controller.signal, cloudReconnectDelayMs(consecutiveFailures))
      }
    }
  })()

  const unsubscribe = () => {
    options.signal?.removeEventListener('abort', abort)
    controller.abort()
  }
  return Object.assign(unsubscribe, { trackSession, markSessionAdmitted })
}

export function buildNodeOpencodeCloudRuntimeClientConfig(
  baseUrl: string,
  auth: ManagedOpencodeServerAuth,
): OpencodeClientConfig {
  // JOE-943: shared kernel owns authenticated V2 client config shape.
  return buildAuthenticatedOpencodeV2ClientConfig(baseUrl, auth)
}

function ensureNodeRuntimeDirs(paths: PathProvider) {
  const roots = paths.getRuntimeXdgRoots()
  for (const path of [
    paths.getAppDataDir(),
    paths.getRuntimeHomeDir(),
    roots.home,
    roots.configHome,
    roots.dataHome,
    roots.stateHome,
    roots.cacheHome,
    paths.getWorkspaceRoot(),
    paths.getArtifactRoot(),
  ]) {
    mkdirSync(path, { recursive: true })
  }
}

function writeEphemeralOpencodeConfig(paths: PathProvider, config: OpencodeServerOptions['config']) {
  const configPath = join(paths.getRuntimeXdgRoots().configHome, 'opencode', 'opencode.json')
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(config ?? {}), { mode: 0o600 })
  chmodSync(configPath, 0o600)
  return () => {
    try {
      unlinkSync(configPath)
    } catch {
      // The runtime may already have removed or moved the file.
    }
  }
}

export async function createNodeOpencodeCloudRuntimeAdapter(
  options: NodeOpencodeCloudRuntimeOptions,
): Promise<NodeOpencodeCloudRuntimeAdapter> {
  ensureNodeRuntimeDirs(options.paths)
  const auth = createManagedOpencodeServerAuth()
  const runtimePaths = options.paths.getRuntimeXdgRoots()
  let cleanupEphemeralConfig: (() => void) | null = null
  const serverConfig = options.configDelivery === 'ephemeral-file'
    ? undefined
    : options.config
  if (options.configDelivery === 'ephemeral-file' && options.config !== undefined) {
    cleanupEphemeralConfig = writeEphemeralOpencodeConfig(options.paths, options.config)
  }
  const env = buildManagedRuntimeEnvironment({
    currentEnv: options.env || process.env,
    runtimePaths: {
      home: runtimePaths.home,
      configHome: runtimePaths.configHome,
      dataHome: runtimePaths.dataHome,
      stateHome: runtimePaths.stateHome,
      cacheHome: runtimePaths.cacheHome,
    },
    enableNativeWebSearch: options.enableNativeWebSearch,
    serverAuth: auth,
  })
  let server: Awaited<ReturnType<typeof createNodeManagedOpencodeServer>>
  try {
    server = await createNodeManagedOpencodeServer({
      hostname: options.hostname || '127.0.0.1',
      port: options.port ?? 0,
      timeout: options.timeout ?? 5000,
      config: serverConfig,
      env,
      cwd: options.cwd || options.paths.getRuntimeHomeDir(),
      logLevel: options.logLevel,
      opencodeBinPath: options.opencodeBinPath,
      onUnexpectedExit: options.onUnexpectedExit,
    })
  } finally {
    cleanupEphemeralConfig?.()
  }
  const client = createOpencodeV2Client(buildNodeOpencodeCloudRuntimeClientConfig(server.url, auth))
  const adapter = createSdkCloudRuntimeAdapter(client, {
    directory: options.cwd || options.paths.getRuntimeHomeDir(),
  })
  const knownRootSessions = new Set<string>()
  const eventSubscriptions = new Set<OpencodeCloudRuntimeEventSubscription>()

  const trackRootSession = (sessionId: string) => {
    knownRootSessions.add(sessionId)
    for (const subscription of eventSubscriptions) subscription.trackSession(sessionId)
  }

  const markRootSessionAdmitted = (
    sessionId: string,
    admissionId?: string,
    admittedSequence?: number,
  ) => {
    trackRootSession(sessionId)
    for (const subscription of eventSubscriptions) {
      subscription.markSessionAdmitted(sessionId, admissionId, admittedSequence)
    }
  }

  return {
    ...adapter,
    url: server.url,
    auth,
    async createSession(input) {
      const session = await adapter.createSession(input)
      trackRootSession(session.id)
      return session
    },
    async promptSession(input) {
      trackRootSession(input.sessionId)
      const result = await adapter.promptSession(input)
      // V2 prompt is admission-only. Keep the process/runtime lifecycle tied to
      // the authoritative native drain rather than treating HTTP admission as
      // execution completion.
      markRootSessionAdmitted(
        input.sessionId,
        input.messageId || result?.admissionId,
        result?.admittedSequence,
      )
      return result
    },
    subscribeEvents(listener, subscribeOptions) {
      const subscription = subscribeToOpencodeCloudRuntimeEvents(client, listener, subscribeOptions)
      eventSubscriptions.add(subscription)
      for (const sessionId of knownRootSessions) subscription.trackSession(sessionId)
      return () => {
        eventSubscriptions.delete(subscription)
        subscription()
      }
    },
    close() {
      for (const subscription of eventSubscriptions) subscription()
      eventSubscriptions.clear()
      server.close()
    },
  }
}
