/**
 * Desktop local durable session event tails.
 *
 * After a V2 prompt admission, track the session on `v2.session.events` from
 * `admittedSeq` so transcript survives the HTTP→SSE gap and reconnects with an
 * `after` cursor. The global `v2.event.subscribe` stream remains the control
 * plane (permissions, questions, untracked sessions) and suppresses transcript
 * for sessions owned by a durable tail.
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import {
  advanceDurableCursor,
  durableAfterCursor,
  type DurableSequenceCursor,
  desktopDurableReconnectDelayMs,
  nextReconnectFailureCount,
  OPENCODE_SSE_OWNED_MAX_RETRY_ATTEMPTS,
  readDurableSequenceFromEvent,
  readSessionStatusType,
  shouldSuppressGlobalEventForTrackedSession,
  waitForAbortableDelay,
} from '@open-cowork/runtime-host'
import { log } from '@open-cowork/shared/node'

// JOE-839: durable tails are long-lived SSE streams. Cap hubs (one per project
// directory client) and sessions per hub so a long-running desktop cannot pin
// unbounded OpenCode event streams.
export const MAX_DURABLE_DIRECTORY_HUBS = 64
export const MAX_DURABLE_SESSIONS_PER_DIRECTORY = 256

export type DurableRawEventHandler = (raw: unknown) => void | Promise<void>

type DurableSessionState = {
  sessionId: string
  cursor: DurableSequenceCursor
  admittedSeq: number | null
  streamTask: Promise<void> | null
  stopped: boolean
}

type DirectoryDurableHub = {
  client: OpencodeClient
  directory: string | null
  signal: AbortSignal
  onEvent: DurableRawEventHandler
  sessions: Map<string, DurableSessionState>
  stop: () => void
}

const hubsByDirectory = new Map<string, DirectoryDurableHub>()

function directoryKey(directory: string | null | undefined) {
  return directory || '__runtime_home__'
}

function stopDurableSession(hub: DirectoryDurableHub, sessionId: string) {
  const state = hub.sessions.get(sessionId)
  if (!state) return
  state.stopped = true
  hub.sessions.delete(sessionId)
}

function ensureSessionState(hub: DirectoryDurableHub, sessionId: string): DurableSessionState {
  const existing = hub.sessions.get(sessionId)
  if (existing) {
    // Touch as newest (approx LRU) so active streams survive eviction pressure.
    hub.sessions.delete(sessionId)
    hub.sessions.set(sessionId, existing)
    return existing
  }
  while (hub.sessions.size >= MAX_DURABLE_SESSIONS_PER_DIRECTORY) {
    const oldestId = hub.sessions.keys().next().value
    if (typeof oldestId !== 'string') break
    log('events', `Evicting durable session stream ${oldestId} under per-directory cap ${MAX_DURABLE_SESSIONS_PER_DIRECTORY}`)
    stopDurableSession(hub, oldestId)
  }
  const created: DurableSessionState = {
    sessionId,
    cursor: { lastSequence: -1 },
    admittedSeq: null,
    streamTask: null,
    stopped: false,
  }
  hub.sessions.set(sessionId, created)
  return created
}

async function durableStreamLoop(hub: DirectoryDurableHub, state: DurableSessionState) {
  let consecutiveFailures = 0
  while (!hub.signal.aborted && !state.stopped) {
    let receivedEvent = false
    let streamError: unknown = null
    let lastSseEventId: string | undefined
    try {
      const sessionEvents = hub.client.v2.session.events
      if (typeof sessionEvents !== 'function') {
        throw new Error('OpenCode SDK v2 client is missing durable session events.')
      }
      const after = durableAfterCursor({
        lastSequence: state.cursor.lastSequence >= 0 ? state.cursor.lastSequence : null,
        admittedSeq: state.admittedSeq,
      })
      const result = await sessionEvents.call(hub.client.v2.session, {
        sessionID: state.sessionId,
        ...(after ? { after } : {}),
      }, {
        signal: hub.signal,
        // Own reconnects so every retry carries the last durable sequence.
        sseMaxRetryAttempts: OPENCODE_SSE_OWNED_MAX_RETRY_ATTEMPTS,
        onSseError(error: unknown) {
          streamError = error
        },
        onSseEvent(event: { id?: string }) {
          if (event.id) lastSseEventId = event.id
        },
      })
      for await (const raw of result.stream as AsyncIterable<unknown>) {
        if (hub.signal.aborted || state.stopped) break
        const sequence = readDurableSequenceFromEvent(raw)
        if (sequence !== null && sequence <= state.cursor.lastSequence) continue
        state.cursor = advanceDurableCursor(state.cursor, raw, lastSseEventId)
        receivedEvent = true
        await hub.onEvent(raw)
      }
      if (hub.signal.aborted || state.stopped) break
      throw streamError || new Error(`OpenCode durable event stream ended for session ${state.sessionId}.`)
    } catch (error) {
      if (hub.signal.aborted || state.stopped) break
      const message = error instanceof Error ? error.message : String(error)
      log('events', `Durable session stream error [${state.sessionId}]: ${message}`)
      consecutiveFailures = nextReconnectFailureCount(consecutiveFailures, receivedEvent)
      const retryDelayMs = desktopDurableReconnectDelayMs(consecutiveFailures)
      await waitForAbortableDelay(hub.signal, retryDelayMs)
    }
  }
}

function startDurableStream(hub: DirectoryDurableHub, state: DurableSessionState) {
  if (state.streamTask || state.stopped) return
  state.streamTask = durableStreamLoop(hub, state).finally(() => {
    if (hub.sessions.get(state.sessionId) === state) {
      state.streamTask = null
    }
  })
}

/**
 * Register the durable hub for one directory-scoped global event subscription.
 * Call once per `subscribeToEvents` invocation; `signal` abort tears it down.
 */
export function attachDirectoryDurableHub(options: {
  client: OpencodeClient
  directory: string | null
  signal: AbortSignal
  onEvent: DurableRawEventHandler
}) {
  const key = directoryKey(options.directory)
  const previous = hubsByDirectory.get(key)
  previous?.stop()

  const hub: DirectoryDurableHub = {
    client: options.client,
    directory: options.directory,
    signal: options.signal,
    onEvent: options.onEvent,
    sessions: new Map(),
    stop() {
      for (const state of hub.sessions.values()) {
        state.stopped = true
      }
      hub.sessions.clear()
      if (hubsByDirectory.get(key) === hub) hubsByDirectory.delete(key)
    },
  }
  // Evict the oldest directory hub before inserting so live project directories
  // cannot accumulate unbounded global event subscriptions (JOE-839).
  while (hubsByDirectory.size >= MAX_DURABLE_DIRECTORY_HUBS) {
    const oldestKey = hubsByDirectory.keys().next().value
    if (typeof oldestKey !== 'string') break
    if (oldestKey === key) break
    log('events', `Evicting durable directory hub under cap ${MAX_DURABLE_DIRECTORY_HUBS}: ${oldestKey}`)
    hubsByDirectory.get(oldestKey)?.stop()
  }
  hubsByDirectory.set(key, hub)
  options.signal.addEventListener('abort', () => hub.stop(), { once: true })
  return hub
}

export function markSessionPromptAdmitted(options: {
  directory: string | null | undefined
  sessionId: string
  admittedSeq?: number | null
  admissionId?: string | null
}) {
  const sessionId = options.sessionId.trim()
  if (!sessionId) return false
  const hub = hubsByDirectory.get(directoryKey(options.directory))
  if (!hub) {
    log('events', `Durable admit skipped (no hub) session=${sessionId}`)
    return false
  }
  const state = ensureSessionState(hub, sessionId)
  if (typeof options.admittedSeq === 'number' && Number.isSafeInteger(options.admittedSeq)) {
    state.admittedSeq = options.admittedSeq
  }
  // First admission with no observed cursor: seed after from admittedSeq.
  if (state.cursor.lastSequence < 0 && state.admittedSeq !== null) {
    const after = durableAfterCursor({ admittedSeq: state.admittedSeq })
    if (after) state.cursor = { ...state.cursor, after }
  }
  startDurableStream(hub, state)
  log(
    'events',
    `Durable session tracked session=${sessionId} admittedSeq=${state.admittedSeq ?? 'none'} after=${state.cursor.after || 'start'}`,
  )
  return true
}

export function isSessionDurablyTracked(
  directory: string | null | undefined,
  sessionId: string | null | undefined,
) {
  if (!sessionId) return false
  const hub = hubsByDirectory.get(directoryKey(directory))
  return Boolean(hub?.sessions.has(sessionId))
}

export function shouldSuppressGlobalRuntimeEvent(
  directory: string | null | undefined,
  type: string | null | undefined,
  properties: Record<string, unknown> | null | undefined,
) {
  const sessionId = readSessionIdFromProperties(properties)
  if (!sessionId) return false
  if (!isSessionDurablyTracked(directory, sessionId)) return false
  const statusType = type === 'session.status' ? readSessionStatusType(properties) : null
  return shouldSuppressGlobalEventForTrackedSession(true, type, statusType)
}

function readSessionIdFromProperties(properties: Record<string, unknown> | null | undefined) {
  if (!properties) return null
  const direct = properties.sessionID ?? properties.sessionId
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const info = properties.info
  if (info && typeof info === 'object' && !Array.isArray(info)) {
    const sessionID = (info as { sessionID?: unknown }).sessionID
    if (typeof sessionID === 'string' && sessionID.trim()) return sessionID.trim()
  }
  const part = properties.part
  if (part && typeof part === 'object' && !Array.isArray(part)) {
    const sessionID = (part as { sessionID?: unknown }).sessionID
      ?? (part as { sessionId?: unknown }).sessionId
    if (typeof sessionID === 'string' && sessionID.trim()) return sessionID.trim()
  }
  return null
}

/** Test helper: clear all hubs between unit tests. */
export function resetDurableSessionHubsForTests() {
  for (const hub of hubsByDirectory.values()) hub.stop()
  hubsByDirectory.clear()
}

/** Test helper: mark a session tracked without starting a live stream. */
export function __testTrackSession(directory: string | null, sessionId: string, admittedSeq = 1) {
  const key = directoryKey(directory)
  let hub = hubsByDirectory.get(key)
  if (!hub) {
    hub = {
      client: {} as OpencodeClient,
      directory,
      signal: new AbortController().signal,
      onEvent: () => undefined,
      sessions: new Map(),
      stop() {
        for (const state of hub!.sessions.values()) state.stopped = true
        hub!.sessions.clear()
        hubsByDirectory.delete(key)
      },
    }
    hubsByDirectory.set(key, hub)
  }
  const state = ensureSessionState(hub, sessionId)
  state.admittedSeq = admittedSeq
  state.streamTask = Promise.resolve()
}

export function __testShouldSuppress(
  directory: string | null,
  sessionId: string,
  type: string,
  statusType?: string | null,
) {
  if (!isSessionDurablyTracked(directory, sessionId)) return false
  return shouldSuppressGlobalEventForTrackedSession(true, type, statusType)
}
