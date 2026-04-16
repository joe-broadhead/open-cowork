import type { BrowserWindow } from 'electron'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { log } from './logger.ts'
import {
  normalizeMcpStatusEntries,
  normalizeRuntimeEventEnvelope,
} from './opencode-adapter.ts'
import type { RuntimeSessionEvent } from './session-event-dispatcher.ts'
import { dispatchRuntimeSessionEvent } from './session-event-dispatcher.ts'
import { getEffectiveSettings, loadSettings } from './settings.ts'
import {
  sweepStaleTaskState,
} from './event-task-state.ts'
import {
  handleMessagePartDeltaEvent,
  handleMessagePartUpdatedEvent,
  handleMessageUpdatedEvent,
  type PendingTextEvent,
} from './event-message-handlers.ts'
import { handleRuntimeSideEffectEvent } from './event-runtime-handlers.ts'

export { removeParentSession } from './event-runtime-handlers.ts'

function dispatchRuntimeEvent(win: BrowserWindow, event: RuntimeSessionEvent) {
  dispatchRuntimeSessionEvent(win, event)
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
  const messageRoles = new Map<string, 'user' | 'assistant'>()
  const pendingTextEventsByMessageId = new Map<string, PendingTextEvent[]>()
  const sweepInterval = setInterval(() => {
    sweepStaleTaskState(messageRoles)
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
            handleMessageUpdatedEvent(win, dispatchRuntimeEvent, data.properties, messageRoles, pendingTextEventsByMessageId)
            break
          }

          case 'message.part.delta': {
            handleMessagePartDeltaEvent(win, dispatchRuntimeEvent, data.properties, messageRoles, pendingTextEventsByMessageId)
            break
          }

          case 'message.part.updated': {
            handleMessagePartUpdatedEvent(
              win,
              dispatchRuntimeEvent,
              data.properties,
              messageRoles,
              pendingTextEventsByMessageId,
              cachedModelId,
            )
            break
          }

          default:
            handleRuntimeSideEffectEvent({
              win,
              type: data.type,
              properties: data.properties,
              dispatchRuntimeEvent,
              getMainWindow,
            })
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
    const connected = entries.filter(e => e.connected).length
    log('mcp', `Status: ${connected}/${entries.length} connected (${entries.filter(e => !e.connected).map(e => `${e.name}=${e.rawStatus}`).join(', ')})`)
    return entries
  } catch (err) {
    log('error', `mcp.status() failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}
