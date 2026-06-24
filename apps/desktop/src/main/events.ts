import { getEffectiveSettings, loadSettings } from '@open-cowork/runtime-host/settings'
import type { RuntimeSessionEvent } from '@open-cowork/runtime-host/session-event-dispatcher'
import { sdkErrorMessage } from '@open-cowork/runtime-host/sdk-error'
import { normalizeMcpStatusEntries, normalizeRuntimeEventEnvelope } from '@open-cowork/runtime-host'
import type { BrowserWindow } from 'electron'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { isMcpAuthRequiredStatus } from '@open-cowork/shared'
import { log } from './logger.ts'
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
} from './event-message-handlers.ts'
import { handleRuntimeSideEffectEvent } from './event-runtime-handlers.ts'
export { removeParentSession } from './event-runtime-handlers.ts'

const UNKNOWN_EVENT_LOG_INTERVAL_MS = 60_000
const unknownEventLastLoggedAt = new Map<string, number>()

function dispatchRuntimeEvent(win: BrowserWindow, event: RuntimeSessionEvent) {
  dispatchRuntimeSessionEvent(win, event)
}

function logUnknownRuntimeEvent(type: string, scopeLabel: string) {
  const now = Date.now()
  const lastLoggedAt = unknownEventLastLoggedAt.get(type) || 0
  if (now - lastLoggedAt < UNKNOWN_EVENT_LOG_INTERVAL_MS) return
  unknownEventLastLoggedAt.set(type, now)
  log('events', `Unknown OpenCode event type${scopeLabel}: ${type}`)
}

export async function subscribeToEvents(
  client: OpencodeClient,
  getMainWindow: () => BrowserWindow | null,
  signal?: AbortSignal,
  directory?: string | null,
) {
  const scopeLabel = directory ? ` [${directory}]` : ''
  log('events', `Subscribing to SSE event stream${scopeLabel}`)
  const result = await client.event.subscribe({}, signal ? { signal } : undefined)
  const stream = result.stream
  log('events', `SSE stream connected${scopeLabel}`)

  const cachedModelId = getEffectiveSettings().effectiveModel || loadSettings().selectedModelId || ''
  const messageState = createSessionScopedMessageState()
  const sweepInterval = setInterval(() => {
    sweepStaleTaskState()
    sweepSessionScopedMessageState(messageState)
  }, 5 * 60 * 1000)

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

      const data = normalizeRuntimeEventEnvelope(event)
      if (!data) continue

      try {
        switch (data.type) {
          case 'message.updated': {
            handleMessageUpdatedEvent(win, dispatchRuntimeEvent, data.properties, messageState)
            break
          }

          case 'message.part.delta': {
            handleMessagePartDeltaEvent(win, dispatchRuntimeEvent, data.properties, messageState)
            break
          }

          case 'message.part.updated': {
            handleMessagePartUpdatedEvent(
              win,
              dispatchRuntimeEvent,
              data.properties,
              messageState,
              cachedModelId,
            )
            break
          }

          default:
            if (!handleRuntimeSideEffectEvent({
              win,
              type: data.type,
              properties: data.properties,
              dispatchRuntimeEvent,
              getMainWindow,
            })) {
              logUnknownRuntimeEvent(data.type, scopeLabel)
            }
            break
        }
      } catch (err) {
        log('error', `Failed to process SSE event ${data.type}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } finally {
    clearInterval(sweepInterval)
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
    const result = await client.mcp.status()
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
