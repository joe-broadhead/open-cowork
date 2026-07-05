import { createNodeManagedOpencodeServer } from '@open-cowork/runtime-host/runtime-node-managed-server'
import { buildManagedRuntimeEnvironment } from '@open-cowork/runtime-host/runtime-environment'
import { normalizeMessagePart, normalizeRuntimeEventEnvelope, normalizeSessionInfo, createManagedOpencodeServerAuth, type ManagedOpencodeServerAuth, type ManagedOpencodeServerLogLevel, type ManagedOpencodeServerUnexpectedExit } from '@open-cowork/runtime-host'
import { asRecord, deriveToolStatus, normalizePermissionEvent, readRecordNestedRecord, readRecordString, readString } from '@open-cowork/shared'
import {
  createOpencodeClient,
  type OpencodeClientConfig,
} from '@opencode-ai/sdk/v2'
import type { ServerOptions as OpencodeServerOptions } from '@opencode-ai/sdk/v2/server'
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

type EventCapableClient = {
  event?: {
    subscribe(
      input?: Record<string, never>,
      options?: { signal?: AbortSignal },
    ): Promise<{ stream: AsyncIterable<unknown> }>
  }
}

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
  return readRecordString(properties, ['message', 'error'])
    || readRecordString(error, ['message', 'error'])
    || 'OpenCode runtime reported an error.'
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
    const input = Object.keys(state.input).length > 0 ? state.input : state.args
    const sessionId = readSessionId(properties)
    return [{
      type: 'tool.call',
      payload: {
        ...(sessionId ? { sessionId } : {}),
        id: part.callId || part.id || undefined,
        name: part.tool || part.name || part.title || 'tool',
        input,
        status,
        ...(state.output !== undefined ? { output: state.output } : state.result !== undefined ? { output: state.result } : {}),
        ...(state.attachments.length > 0 ? { attachments: state.attachments } : part.attachments.length > 0 ? { attachments: part.attachments } : {}),
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

function eventsFromPermissionRequested(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const normalized = normalizePermissionEvent(properties)
  if (!normalized.id) return []
  return [{
    type: 'permission.requested',
    payload: {
      permissionId: normalized.id,
      id: normalized.id,
      ...(normalized.sessionId ? { sessionId: normalized.sessionId } : {}),
      tool: normalized.title,
      input: normalized.input,
      description: normalized.title || `Permission requested for ${normalized.permissionType}`,
    },
  }]
}

function eventsFromPermissionResolved(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const normalized = normalizePermissionEvent(properties)
  if (!normalized.id) return []
  return [{
    type: 'permission.resolved',
    payload: {
      permissionId: normalized.id,
      id: normalized.id,
      ...(normalized.sessionId ? { sessionId: normalized.sessionId } : {}),
    },
  }]
}

function normalizeQuestionPrompt(value: unknown) {
  const record = asRecord(value)
  return {
    header: readString(record.header) || '',
    question: readString(record.question) || '',
    options: Array.isArray(record.options)
      ? record.options.map((option) => {
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
      questions: Array.isArray(properties.questions) ? properties.questions.map(normalizeQuestionPrompt) : [],
      ...(Object.keys(tool).length > 0
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

function eventsFromQuestionResolved(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const requestId = readRecordString(properties, ['requestID', 'requestId', 'id'])
  if (!requestId) return []
  return [{
    type: 'question.resolved',
    payload: {
      requestId,
      id: requestId,
      ...(readSessionId(properties) ? { sessionId: readSessionId(properties) } : {}),
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
      todos: Array.isArray(properties.todos) ? properties.todos.map(normalizeTodo) : [],
    },
  }]
}

function eventFromMessageUpdated(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const info = normalizeSessionInfo(properties.info)
  if (!info || info.role !== 'assistant') return []
  const parts = Array.isArray(properties.parts)
    ? properties.parts
    : Array.isArray(asRecord(properties.message).parts)
      ? asRecord(properties.message).parts as unknown[]
      : []
  const text = parts
    .map(normalizeMessagePart)
    .filter((part): part is NonNullable<ReturnType<typeof normalizeMessagePart>> => Boolean(part))
    .filter((part) => part.type === 'text' && Boolean(part.text))
    .map((part) => part.text)
    .join('')
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
      return eventsFromPermissionRequested(properties)
    case 'permission.replied':
      return eventsFromPermissionResolved(properties)
    case 'question.asked':
      return eventsFromQuestionAsked(properties)
    case 'question.replied':
    case 'question.rejected':
      return eventsFromQuestionResolved(properties)
    case 'todo.updated':
      return eventsFromTodosUpdated(properties)
    default:
      return null
  }
}

export function translateOpencodeRuntimeEventWithDiagnostics(raw: unknown): OpencodeRuntimeEventTranslation {
  const event = normalizeRuntimeEventEnvelope(raw)
  if (!event) {
    return {
      events: [],
      dropped: {
        sdkEventType: null,
        reason: 'invalid-envelope',
      },
    }
  }
  const properties = event.properties || {}
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

export function subscribeToOpencodeCloudRuntimeEvents(
  client: EventCapableClient,
  listener: CloudRuntimeEventListener,
  options: CloudRuntimeSubscribeOptions = {},
) {
  if (!client.event?.subscribe) return () => undefined
  if (options.signal?.aborted) return () => undefined
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })

  void (async () => {
    try {
      const result = await client.event!.subscribe({}, { signal: controller.signal })
      for await (const raw of result.stream) {
        if (controller.signal.aborted) break
        const translation = translateOpencodeRuntimeEventWithDiagnostics(raw)
        if (translation.dropped) options.onDroppedEvent?.(translation.dropped)
        for (const event of translation.events) {
          void listener(event)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) options.onError?.(error)
    }
  })()

  return () => {
    options.signal?.removeEventListener('abort', abort)
    controller.abort()
  }
}

export function buildNodeOpencodeCloudRuntimeClientConfig(
  baseUrl: string,
  auth: ManagedOpencodeServerAuth,
): OpencodeClientConfig {
  return {
    baseUrl,
    headers: {
      Authorization: auth.authorizationHeader,
    },
  }
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
  const client = createOpencodeClient(buildNodeOpencodeCloudRuntimeClientConfig(server.url, auth))
  const adapter = createSdkCloudRuntimeAdapter(client)
  return {
    ...adapter,
    url: server.url,
    auth,
    subscribeEvents(listener, subscribeOptions) {
      return subscribeToOpencodeCloudRuntimeEvents(client, listener, subscribeOptions)
    },
    close() {
      server.close()
    },
  }
}
