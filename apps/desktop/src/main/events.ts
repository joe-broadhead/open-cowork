import { getEffectiveSettings, loadSettings } from '@open-cowork/runtime-host/settings'
import type { RuntimeSessionEvent } from '@open-cowork/runtime-host/session-event-dispatcher'
import { sdkErrorMessage } from '@open-cowork/runtime-host/sdk-error'
import { normalizeMcpStatusEntries, normalizeRuntimeEventEnvelope } from '@open-cowork/runtime-host'
import type { BrowserWindow } from 'electron'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import {
  classifyOpencodeSdkEvent,
  isMcpAuthRequiredStatus,
  OPENCODE_BENIGN_EVENT_TYPES,
} from '@open-cowork/shared'
import { log } from '@open-cowork/shared/node'
import { dispatchRuntimeSessionEvent } from '@open-cowork/runtime-host/session-event-dispatcher'
import {
  sweepStaleTaskState,
} from './event-task-state.ts'
import {
  createSessionScopedMessageState,
  handleMessagePartDeltaEvent,
  handleMessagePartUpdatedEvent,
  handleMessageUpdatedEvent,
  sweepSessionScopedMessageState,
  type SessionScopedMessageState,
} from './event-message-handlers.ts'
import {
  handleNativeStepEndedEvent,
  handleNativeTextDeltaEvent,
  handleNativeTextEndedEvent,
  handleNativeToolEvent,
} from './event-message-native-handlers.ts'
import { handleRuntimeSideEffectEvent } from './event-runtime-handlers.ts'
import {
  attachDirectoryDurableHub,
  shouldSuppressGlobalRuntimeEvent,
} from './durable-session-events.ts'
export { removeParentSession } from './event-runtime-handlers.ts'
export { markSessionPromptAdmitted } from './durable-session-events.ts'

const UNKNOWN_EVENT_LOG_INTERVAL_MS = 60_000
const unknownEventLastLoggedAt = new Map<string, number>()

function dispatchRuntimeEvent(win: BrowserWindow, event: RuntimeSessionEvent) {
  dispatchRuntimeSessionEvent(win, event)
}

function logUnknownRuntimeEvent(type: string, scopeLabel: string) {
  // JOE-838: Benign / private / known projectable types share the canonical
  // classifier — only true unknowns spam the log.
  if (OPENCODE_BENIGN_EVENT_TYPES.has(type)) return
  const disposition = classifyOpencodeSdkEvent(type)
  if (disposition.status !== 'unknown') return
  const now = Date.now()
  const lastLoggedAt = unknownEventLastLoggedAt.get(type) || 0
  if (now - lastLoggedAt < UNKNOWN_EVENT_LOG_INTERVAL_MS) return
  unknownEventLastLoggedAt.set(type, now)
  log('events', `Unknown OpenCode event type${scopeLabel}: ${type}`)
}

function processOpenCodeRuntimeEvent(options: {
  win: BrowserWindow
  raw: unknown
  messageState: SessionScopedMessageState
  cachedModelId: string
  getMainWindow: () => BrowserWindow | null
  scopeLabel: string
  directory: string | null | undefined
  /** When true, skip durable-ownership suppress (event already on durable tail). */
  fromDurableStream?: boolean
}) {
  const data = normalizeRuntimeEventEnvelope(options.raw)
  if (!data) return

  if (
    !options.fromDurableStream
    && shouldSuppressGlobalRuntimeEvent(options.directory, data.type, data.properties)
  ) {
    return
  }

  try {
    switch (data.type) {
      case 'message.updated': {
        handleMessageUpdatedEvent(options.win, dispatchRuntimeEvent, data.properties, options.messageState)
        break
      }

      case 'message.part.delta': {
        handleMessagePartDeltaEvent(options.win, dispatchRuntimeEvent, data.properties, options.messageState)
        break
      }

      case 'message.part.updated': {
        handleMessagePartUpdatedEvent(
          options.win,
          dispatchRuntimeEvent,
          data.properties,
          options.messageState,
          options.cachedModelId,
        )
        break
      }

      case 'session.next.text.delta':
      case 'session.next.reasoning.delta': {
        handleNativeTextDeltaEvent(
          options.win,
          dispatchRuntimeEvent,
          data.properties,
          options.messageState,
          data.type === 'session.next.text.delta' ? 'text' : 'reasoning',
        )
        break
      }

      case 'session.next.text.ended':
      case 'session.next.reasoning.ended': {
        handleNativeTextEndedEvent(
          options.win,
          dispatchRuntimeEvent,
          data.properties,
          options.messageState,
          options.cachedModelId,
          data.type === 'session.next.text.ended' ? 'text' : 'reasoning',
        )
        break
      }

      case 'session.next.tool.called':
      case 'session.next.tool.progress':
      case 'session.next.tool.success':
      case 'session.next.tool.failed': {
        handleNativeToolEvent(
          options.win,
          dispatchRuntimeEvent,
          data.type,
          data.properties,
          options.messageState,
          options.cachedModelId,
        )
        break
      }

      case 'session.next.step.ended': {
        handleNativeStepEndedEvent(
          options.win,
          dispatchRuntimeEvent,
          data.properties,
          options.messageState,
          options.cachedModelId,
        )
        handleRuntimeSideEffectEvent({
          win: options.win,
          type: data.type,
          properties: data.properties,
          dispatchRuntimeEvent,
          getMainWindow: options.getMainWindow,
        })
        break
      }

      default:
        if (!handleRuntimeSideEffectEvent({
          win: options.win,
          type: data.type,
          properties: data.properties,
          dispatchRuntimeEvent,
          getMainWindow: options.getMainWindow,
        })) {
          logUnknownRuntimeEvent(data.type, options.scopeLabel)
        }
        break
    }
  } catch (err) {
    log('error', `Failed to process SSE event ${data.type}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function subscribeToEvents(
  client: OpencodeClient,
  getMainWindow: () => BrowserWindow | null,
  signal?: AbortSignal,
  directory?: string | null,
) {
  const scopeLabel = directory ? ` [${directory}]` : ''
  log('events', `Subscribing to SSE event stream${scopeLabel}`)
  // Durable hub needs an abort signal to tear down per-session tails when the
  // directory subscription ends. Prefer the caller signal; otherwise create a
  // local controller aborted only in finally after the global stream exits.
  const localController = signal ? null : new AbortController()
  const durableSignal = signal || localController!.signal
  const result = await client.v2.event.subscribe(signal ? { signal } : undefined)
  const stream = result.stream
  log('events', `SSE stream connected${scopeLabel}`)

  const cachedModelId = getEffectiveSettings().effectiveModel || loadSettings().selectedModelId || ''
  const messageState = createSessionScopedMessageState()
  const sweepInterval = setInterval(() => {
    sweepStaleTaskState()
    sweepSessionScopedMessageState(messageState)
  }, 5 * 60 * 1000)

  // Durable per-session tails share this message-state + handler pipeline so
  // classic/native projection and task binding stay consistent across streams.
  attachDirectoryDurableHub({
    client,
    directory: directory ?? null,
    signal: durableSignal,
    onEvent: async (raw) => {
      const win = getMainWindow()
      if (!win) return
      processOpenCodeRuntimeEvent({
        win,
        raw,
        messageState,
        cachedModelId,
        getMainWindow,
        scopeLabel,
        directory,
        fromDurableStream: true,
      })
    },
  })

  // One-shot trace: log the first event per subscription so a silent stream
  // is obvious in the log (as opposed to a stream that just isn't being
  // written to by the server). Directory context makes orphaned-session
  // diagnosis faster.
  let firstEventLogged = false

  try {
    for await (const event of stream) {
      if (!firstEventLogged) {
        firstEventLogged = true
        const eventType = typeof (event as { type?: unknown })?.type === 'string'
          ? (event as { type: string }).type
          : 'unknown'
        log('events', `First event received${scopeLabel}: ${eventType}`)
      }
      const win = getMainWindow()
      if (!win) continue

      processOpenCodeRuntimeEvent({
        win,
        raw: event,
        messageState,
        cachedModelId,
        getMainWindow,
        scopeLabel,
        directory,
      })
    }
  } finally {
    clearInterval(sweepInterval)
    localController?.abort()
  }

  if (signal?.aborted) {
    log('events', 'SSE stream closed')
    return
  }

  log('events', 'SSE stream ended — triggering reconnect')
  throw new Error('SSE stream ended unexpectedly')
}

export async function getMcpStatus(client: OpencodeClient) {
  try {
    const result = await client.mcp.status(undefined, { throwOnError: true })
    const entries = normalizeMcpStatusEntries(result.data)
    if (entries.length === 0) {
      log('mcp', 'mcp.status() returned no data')
      return []
    }
    // Split non-connected entries into "needs user action" (pending
    // OAuth) vs real problems (failed). The previous log format tagged
    // everything non-connected as if it were an error, which muddied
    // the boot log for perfectly healthy configurations where an OAuth
    // integration just hadn't been signed in yet.
    const connected: string[] = []
    const needsAuth: string[] = []
    const failed: string[] = []
    for (const entry of entries) {
      if (entry.connected) connected.push(entry.name)
      else if (isMcpAuthRequiredStatus(entry.rawStatus)) needsAuth.push(entry.name)
      else failed.push(`${entry.name}=${entry.rawStatus || 'unknown'}`)
    }
    const parts = [`${connected.length}/${entries.length} connected`]
    if (needsAuth.length > 0) parts.push(`needs-auth=[${needsAuth.join(', ')}]`)
    if (failed.length > 0) parts.push(`failed=[${failed.join(', ')}]`)
    log('mcp', `Status: ${parts.join(' ')}`)
    return entries
  } catch (err) {
    log('error', `mcp.status() failed: ${sdkErrorMessage(err)}`)
    return []
  }
}
