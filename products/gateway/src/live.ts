/**
 * Live event stream for the gateway dashboard.
 *
 * Forwards opencode server SSE events to connected dashboard clients.
 * Events: session.created, session.updated, message.updated, tool calls, etc.
 */

import type { DurableOpencodeClient as OpencodeClient } from './opencode-session-runtime.js'
import { queueEvent } from './wakeup.js'
import { getConfig, type LiveConfig } from './config.js'
import { isLocalOrigin, redactSensitiveText } from './security.js'
import { openCodeFetch } from './opencode-client.js'
import { createOpenCodeSessionRuntime } from './opencode-session-runtime.js'
import { recordLiveSseRejected, recordLiveSseReplayDropped, recordLiveSseSlowConsumer, recordLiveSseTimeout, recordLiveUpstreamFrameRejected, setLiveSseActive, setLiveSseReplayCache } from './runtime-metrics.js'
import { readUpstreamSseFrames, UpstreamSseParserError, type UpstreamSseParserLimits } from './upstream-sse-parser.js'

interface LiveClient {
  id: string
  principal: string
  res: any
  limits: LiveClientLimits
  connectedAt: number
  lastWriteAt: number
  nextHeartbeatAt: number
  nextAuthCheckAt: number
  backpressuredAt?: number
  backpressuredWriteBytes: number
  pendingWrites: Array<{ data: string; bytes: number }>
  pendingWriteBytes: number
  authorize?: () => boolean
  cleanup: Array<() => void>
}

type LiveClientLimits = Omit<LiveConfig, 'upstream'>

interface LiveLifecycle {
  once?: (event: string, listener: (...args: any[]) => void) => unknown
  removeListener?: (event: string, listener: (...args: any[]) => void) => unknown
}

export interface LiveClientAdmissionOptions {
  principal?: string
  limits?: Partial<LiveClientLimits>
  lifecycle?: LiveLifecycle
  authorize?: () => boolean
  now?: () => number
}

export interface LiveClientAdmission {
  accepted: boolean
  reason?: 'global_capacity' | 'principal_capacity'
}

const liveClients = new Map<string, LiveClient>()
const liveClientsByPrincipal = new Map<string, number>()
let liveMaintenanceTimer: NodeJS.Timeout | null = null
let subscribed = false
let liveSubscriptionAbort: AbortController | null = null
let liveSubscriptionTask: Promise<void> | null = null
let sessionPollTimer: NodeJS.Timeout | null = null
let sessionPollAbort: AbortController | null = null
let sessionPollTask: Promise<void> | null = null
const SESSION_POLL_INTERVAL_MS = 5_000
const SESSION_POLL_TIMEOUT_MS = 10_000
const UPSTREAM_RECONNECT_DELAY_MS = 3_000
// Per-session payload of the last broadcast poll event, so an unchanged
// session is not re-broadcast to every client on every 5s poll.
interface SessionReplaySnapshot {
  payload?: string
  bytes: number
}

const lastSessionUpdatePayloads = new Map<string, SessionReplaySnapshot>()
let lastSessionUpdatePayloadBytes = 0
export function subscribeToOpenCodeEvents(client: OpencodeClient, onEvent?: (event: any) => void) {
  if (subscribed) return
  subscribed = true
  const abort = new AbortController()
  liveSubscriptionAbort = abort
  liveSubscriptionTask = subscribeToNativeEvents(onEvent, abort.signal)
    .catch(err => {
      if (!abort.signal.aborted) queueEvent(`OpenCode event stream unavailable: ${err?.message || err}`)
    })
    .finally(() => {
      if (liveSubscriptionAbort === abort) liveSubscriptionAbort = null
    })

  // Safety net: polling keeps the dashboard fresh if SSE disconnects or misses events.
  sessionPollTimer = setInterval(() => { startSessionPoll(client) }, SESSION_POLL_INTERVAL_MS)
  sessionPollTimer.unref?.()
}

export async function stopLiveEvents(): Promise<void> {
  subscribed = false
  if (sessionPollTimer) clearInterval(sessionPollTimer)
  sessionPollTimer = null
  const subscriptionTask = liveSubscriptionTask
  const pollTask = sessionPollTask
  liveSubscriptionTask = null
  liveSubscriptionAbort?.abort(new Error('Gateway live-event subscription stopped'))
  liveSubscriptionAbort = null
  sessionPollAbort?.abort(new Error('Gateway live-event fallback poll stopped'))
  sessionPollAbort = null
  if (subscriptionTask || pollTask) {
    await Promise.allSettled([
      ...(subscriptionTask ? [subscriptionTask] : []),
      ...(pollTask ? [pollTask] : []),
    ])
  }
}

async function subscribeToNativeEvents(onEvent: ((event: any) => void) | undefined, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const res = await openCodeFetch(getConfig().opencodeUrl, 'global/event', {
        headers: { Accept: 'text/event-stream' },
        signal,
      })
      if (!res.ok || !res.body) {
        await cancelResponseBody(res.body)
        throw new Error(`HTTP ${res.status}`)
      }
      queueEvent('OpenCode event stream connected')
      await consumeOpenCodeEventStream(res.body, getConfig().live!.upstream, event => {
        broadcast(sanitizeOpenCodeEventForLive(event))
        if (event.type.includes('permission') || event.type.includes('question')) queueEvent(`OpenCode ${event.type}`)
        onEvent?.(event)
      })
      if (!signal.aborted) queueEvent('OpenCode event stream disconnected: upstream stream ended')
    } catch (err: any) {
      if (signal.aborted) return
      queueEvent(err instanceof UpstreamSseParserError
        ? `OpenCode event stream rejected: ${err.code}`
        : `OpenCode event stream disconnected: ${err?.message || err}`)
    }
    if (!signal.aborted) await sleep(UPSTREAM_RECONNECT_DELAY_MS, signal)
  }
}

function startSessionPoll(client: OpencodeClient): void {
  if (liveClients.size === 0 || sessionPollTask) return
  const abort = new AbortController()
  sessionPollAbort = abort
  const timeout = setTimeout(() => {
    abort.abort(new Error('Gateway live-event fallback poll timed out'))
  }, SESSION_POLL_TIMEOUT_MS)
  timeout.unref?.()
  const task = pollOpenCodeSessions(client, abort.signal)
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(timeout)
      if (sessionPollAbort === abort) sessionPollAbort = null
      if (sessionPollTask === task) sessionPollTask = null
    })
  sessionPollTask = task
}

async function pollOpenCodeSessions(client: OpencodeClient, signal: AbortSignal): Promise<void> {
  const sessions = await waitForAbort(
    createOpenCodeSessionRuntime(client).listSessions(undefined, { signal }),
    signal,
  ) as any[]
  if (!Array.isArray(sessions) || signal.aborted) return

  const config = getConfig()
  const replayLimits = config.live!.replay
  enforceReplayCacheLimits(replayLimits)
  const gw = sessions.filter((s: any) => (s.title || '').startsWith('GW:'))
  const seenIds = new Set<string>()
  for (const s of gw) {
    if (signal.aborted) return
    const event = {
      type: 'session_update',
      id: s.id,
      title: redactSensitiveText((s.title || '').replace('GW:', '').trim(), config),
      cost: s.cost || 0,
      tokens: s.tokens || {},
      updated: s.time?.updated || 0,
    }
    const payload = JSON.stringify(event)
    seenIds.add(String(s.id))
    if (rememberSessionUpdatePayload(String(s.id), payload, replayLimits)) broadcast(event, payload)
  }
  for (const id of lastSessionUpdatePayloads.keys()) {
    if (!seenIds.has(id)) forgetSessionUpdatePayload(id)
  }
}

async function cancelResponseBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return
  try { await body.cancel() } catch {}
}

function waitForAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Operation aborted'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason || new Error('Operation aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    task.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      err => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

export async function consumeOpenCodeEventStream(
  body: ReadableStream<Uint8Array>,
  limits: UpstreamSseParserLimits,
  onEvent: (event: { type: string; payload: any }) => void,
): Promise<void> {
  try {
    await readUpstreamSseFrames(body, limits, frame => {
      const event = parseSseFrame(frame)
      if (event) onEvent(event)
    })
  } catch (err) {
    if (err instanceof UpstreamSseParserError) {
      const reason = err.code === 'UPSTREAM_SSE_BUFFER_LIMIT'
        ? 'buffer_limit'
        : err.code === 'UPSTREAM_SSE_EVENT_LIMIT'
          ? 'event_limit'
          : 'invalid_encoding'
      recordLiveUpstreamFrameRejected(reason)
    }
    throw err
  }
}

export function parseSseFrame(frame: string): { type: string; payload: any } | null {
  const lines = frame.split(/\r\n|\r|\n/)
  const eventType = lines.find(line => line.startsWith('event:'))?.slice('event:'.length).trim()
  const data = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') return null
  let payload: any = data
  try { payload = JSON.parse(data) } catch {}
  return { type: eventType || payload?.type || 'message', payload }
}

export function sanitizeOpenCodeEventForLive(event: { type: string; payload: any }): Record<string, unknown> {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {}
  const info = objectValue(payload['info'])
  const session = objectValue(payload['session']) || objectValue(info?.['session'])
  const message = objectValue(payload['message']) || info
  const sessionId = stringValue(payload['sessionID']) || stringValue(payload['sessionId']) || stringValue(payload['session_id']) || stringValue(session?.['id']) || stringValue(message?.['sessionID']) || stringValue(message?.['sessionId'])
  const messageId = stringValue(payload['messageID']) || stringValue(payload['messageId']) || stringValue(message?.['id'])
  const title = stringValue(session?.['title']) || stringValue(payload['title'])
  return {
    type: 'opencode_event',
    eventType: String(event?.type || 'message'),
    ...(sessionId ? { sessionId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(title ? { title: redactSensitiveText(title, getConfig()) } : {}),
    updated: Date.now(),
  }
}

export function addLiveClient(
  id: string,
  res: any,
  origin?: string,
  port?: number,
  options: LiveClientAdmissionOptions = {},
): LiveClientAdmission {
  const limits = { ...getConfig().live!, ...options.limits }
  enforceReplayCacheLimits(limits.replay)
  const principal = options.principal || 'authenticated'
  if (liveClients.has(id)) removeLiveClient(id)
  const principalClients = liveClientsByPrincipal.get(principal) || 0
  const rejection = liveClients.size >= limits.maxClients
    ? 'global_capacity'
    : principalClients >= limits.maxClientsPerPrincipal
      ? 'principal_capacity'
      : undefined
  if (rejection) {
    recordLiveSseRejected(rejection === 'global_capacity' ? 'global' : 'principal')
    res.writeHead(503, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Retry-After': String(limits.retryAfterSeconds),
    })
    res.end(JSON.stringify({
      error: 'live SSE capacity exceeded',
      code: 'LIVE_SSE_CAPACITY',
      retryable: true,
    }))
    return { accepted: false, reason: rejection }
  }
  const now = options.now?.() ?? Date.now()
  const client: LiveClient = {
    id,
    principal,
    res,
    limits,
    connectedAt: now,
    lastWriteAt: now,
    nextHeartbeatAt: now + limits.heartbeatMs,
    nextAuthCheckAt: now + limits.heartbeatMs,
    backpressuredWriteBytes: 0,
    pendingWrites: [],
    pendingWriteBytes: 0,
    authorize: options.authorize,
    cleanup: [],
  }
  liveClients.set(id, client)
  liveClientsByPrincipal.set(principal, principalClients + 1)
  setLiveSseActive(liveClients.size)
  const release = () => {
    const wasBackpressured = isTransportBackpressured(client)
    if (removeLiveClient(id) && wasBackpressured) destroyLiveTransport(client)
  }
  attachLifecycle(client, options.lifecycle, ['aborted', 'close', 'error'], release)
  attachLifecycle(client, res, ['close', 'error'], release)
  attachLifecycle(client, res.socket, ['error'], release)
  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      // The live stream carries session/work state; only a local origin (the
      // same-origin dashboard) may read it cross-origin. A non-local origin gets
      // the canonical loopback value, which no real remote origin can match —
      // NOT the literal 'null', which an opaque origin (sandboxed iframe,
      // file://, data:) would match and could use to EventSource-scrape the daemon.
      'Access-Control-Allow-Origin': origin && isLocalOrigin(origin) ? origin : `http://127.0.0.1:${port ?? 0}`,
      'Vary': 'Origin',
    })
  } catch (err) {
    removeLiveClient(id)
    destroyLiveTransport(client)
    throw err
  }
  safeWrite(client, 'data: ' + JSON.stringify({ type: 'connected' }) + '\n\n', now)
  // Replay the last-known session snapshots so a fresh or reconnecting client
  // sees connect-time state instead of waiting for the next change to broadcast.
  for (const snapshot of lastSessionUpdatePayloads.values()) {
    if (snapshot.payload === undefined) continue
    if (!safeWrite(client, 'data: ' + snapshot.payload + '\n\n', now)) break
  }
  if (liveClients.has(id)) ensureLiveMaintenanceTimer()
  return { accepted: true }
}

export function removeLiveClient(id: string) {
  const client = liveClients.get(id)
  if (!client) return false
  liveClients.delete(id)
  setLiveSseActive(liveClients.size)
  for (const cleanup of client.cleanup.splice(0)) cleanup()
  client.pendingWrites.length = 0
  client.pendingWriteBytes = 0
  client.backpressuredWriteBytes = 0
  const remaining = (liveClientsByPrincipal.get(client.principal) || 1) - 1
  if (remaining > 0) liveClientsByPrincipal.set(client.principal, remaining)
  else liveClientsByPrincipal.delete(client.principal)
  if (liveClients.size === 0) stopLiveMaintenanceTimer()
  return true
}

export function closeAllLiveClients(): void {
  const clients = [...liveClients.values()]
  for (const client of clients) {
    removeLiveClient(client.id)
    endLiveTransport(client, 'event: shutdown\ndata: {"type":"shutdown"}\n\n')
  }
}

export function broadcastLiveEventForTest(event: any): void {
  broadcast(event)
}

export function liveClientCountForTest(): number {
  return liveClients.size
}

export function livePrincipalCountForTest(): number {
  return liveClientsByPrincipal.size
}

export function clearLiveClientsForTest(): void {
  for (const id of [...liveClients.keys()]) removeLiveClient(id)
  stopLiveMaintenanceTimer()
  lastSessionUpdatePayloads.clear()
  lastSessionUpdatePayloadBytes = 0
  setLiveSseReplayCache(0, 0)
}

export function primeSessionUpdatePayloadForTest(id: string, event: any): void {
  rememberSessionUpdatePayload(id, JSON.stringify(event))
}

export function liveSessionSnapshotCountForTest(): number {
  return lastSessionUpdatePayloads.size
}

export function liveSubscriptionStateForTest(): { subscribed: boolean; polling: boolean } {
  return { subscribed, polling: sessionPollTimer !== null }
}

export function runLiveClientMaintenanceForTest(now: number): void {
  maintainLiveClients(now)
}

function broadcast(event: any, serialized?: string) {
  if (liveClients.size === 0) return
  const data = 'data: ' + (serialized ?? JSON.stringify(event)) + '\n\n'
  for (const client of [...liveClients.values()]) {
    safeWrite(client, data, Date.now())
  }
}

function safeWrite(client: LiveClient, data: string, now: number): boolean {
  if (!liveClients.has(client.id)) return false
  if (client.res.destroyed || client.res.writableEnded) {
    const wasBackpressured = isTransportBackpressured(client)
    if (removeLiveClient(client.id) && wasBackpressured) destroyLiveTransport(client)
    return false
  }
  const bytes = Buffer.byteLength(data)
  if (bufferedClientBytes(client) + bytes > client.limits.maxBufferedBytes) {
    closeSlowClient(client, 'buffer_limit')
    return false
  }
  if (client.backpressuredAt !== undefined) {
    client.pendingWrites.push({ data, bytes })
    client.pendingWriteBytes += bytes
    return true
  }
  try {
    const writable = client.res.write(data)
    if (writable === false) {
      client.backpressuredAt = now
      client.backpressuredWriteBytes = bytes
    }
    if (bufferedClientBytes(client) > client.limits.maxBufferedBytes) {
      closeSlowClient(client, 'buffer_limit')
      return false
    }
    if (writable === false) {
      attachDrainListener(client)
      return true
    }
    client.lastWriteAt = now
    return true
  } catch {
    removeLiveClient(client.id)
    destroyLiveTransport(client)
    return false
  }
}

function attachDrainListener(client: LiveClient): void {
  const source = client.res as LiveLifecycle
  if (!source.once || !source.removeListener) return
  let detach = () => {}
  const onDrain = () => {
    detach()
    const current = liveClients.get(client.id)
    if (!current) return
    current.backpressuredAt = undefined
    current.backpressuredWriteBytes = 0
    current.lastWriteAt = Date.now()
    flushPendingWrites(current)
  }
  detach = () => {
    source.removeListener?.('drain', onDrain)
    const index = client.cleanup.indexOf(detach)
    if (index >= 0) client.cleanup.splice(index, 1)
  }
  source.once('drain', onDrain)
  client.cleanup.push(detach)
}

function flushPendingWrites(client: LiveClient): void {
  while (liveClients.has(client.id) && client.backpressuredAt === undefined && client.pendingWrites.length > 0) {
    const next = client.pendingWrites.shift()!
    client.pendingWriteBytes = Math.max(0, client.pendingWriteBytes - next.bytes)
    if (!safeWrite(client, next.data, Date.now())) return
  }
}

function bufferedClientBytes(client: LiveClient): number {
  const transportBytes = Math.max(
    Number(client.res.writableLength || 0),
    client.backpressuredWriteBytes,
  )
  return transportBytes + client.pendingWriteBytes
}

function maintainLiveClients(now: number): void {
  for (const client of [...liveClients.values()]) {
    if (client.authorize && now >= client.nextAuthCheckAt) {
      client.nextAuthCheckAt = now + client.limits.heartbeatMs
      if (!safeAuthorize(client.authorize)) {
        closeLiveClient(client, 'authentication_expired')
        continue
      }
    }
    if (now - client.connectedAt >= client.limits.maxConnectionMs) {
      closeLiveClient(client, 'maximum_lifetime')
      continue
    }
    if (client.backpressuredAt !== undefined && now - client.backpressuredAt >= client.limits.writeTimeoutMs) {
      closeSlowClient(client, 'write_timeout')
      continue
    }
    if (now - client.lastWriteAt >= client.limits.idleTimeoutMs) {
      closeLiveClient(client, 'idle_timeout')
      continue
    }
    if (now >= client.nextHeartbeatAt) {
      client.nextHeartbeatAt = now + client.limits.heartbeatMs
      safeWrite(client, ': heartbeat\n\n', now)
    }
  }
}

function safeAuthorize(authorize: () => boolean): boolean {
  try { return authorize() } catch { return false }
}

function closeLiveClient(client: LiveClient, reason: 'authentication_expired' | 'maximum_lifetime' | 'idle_timeout'): void {
  if (!removeLiveClient(client.id)) return
  recordLiveSseTimeout(reason === 'idle_timeout' ? 'idle' : reason === 'maximum_lifetime' ? 'lifetime' : 'authentication')
  endLiveTransport(client, `event: close\ndata: ${JSON.stringify({ type: 'close', reason })}\n\n`)
}

function closeSlowClient(client: LiveClient, reason: 'buffer_limit' | 'write_timeout'): void {
  if (!removeLiveClient(client.id)) return
  recordLiveSseSlowConsumer(reason)
  destroyLiveTransport(client)
}

function endLiveTransport(client: LiveClient, finalEvent: string): void {
  // end() queues behind already-backpressured output. Once the client is
  // removed no maintenance deadline remains to break that stall, so abort the
  // transport instead of leaving a detached response flushing indefinitely.
  if (isTransportBackpressured(client)) {
    destroyLiveTransport(client)
    return
  }
  try {
    client.res.end?.(finalEvent)
  } catch {
    destroyLiveTransport(client)
  }
}

function isTransportBackpressured(client: LiveClient): boolean {
  return client.backpressuredAt !== undefined || client.res.writableNeedDrain === true
}

function destroyLiveTransport(client: LiveClient): void {
  try { client.res.destroy?.() } catch {}
}

function ensureLiveMaintenanceTimer(): void {
  if (liveMaintenanceTimer) return
  liveMaintenanceTimer = setInterval(() => maintainLiveClients(Date.now()), 1000)
  liveMaintenanceTimer.unref?.()
}

function stopLiveMaintenanceTimer(): void {
  if (liveMaintenanceTimer) clearInterval(liveMaintenanceTimer)
  liveMaintenanceTimer = null
}

function rememberSessionUpdatePayload(
  id: string,
  payload: string,
  limits: LiveConfig['replay'] = getConfig().live!.replay,
): boolean {
  const existing = lastSessionUpdatePayloads.get(id)
  if (!existing && lastSessionUpdatePayloads.size >= limits.maxSnapshots) {
    recordLiveSseReplayDropped('snapshot_limit')
    return false
  }
  const bytes = Buffer.byteLength(payload)
  if (existing?.payload === payload && existing.bytes === bytes) return false
  const retainedWithoutExisting = lastSessionUpdatePayloadBytes - (existing?.bytes || 0)
  if (bytes > limits.maxPayloadBytes) {
    retainSessionIdentityWithoutPayload(id, retainedWithoutExisting)
    recordLiveSseReplayDropped('payload_limit')
    return false
  }
  if (retainedWithoutExisting + bytes > limits.maxTotalBytes) {
    retainSessionIdentityWithoutPayload(id, retainedWithoutExisting)
    recordLiveSseReplayDropped('total_bytes_limit')
    return false
  }
  // Updating an existing Map key preserves insertion order. Keeping a stable
  // admitted set prevents an over-capacity poll from evicting and then
  // re-admitting every session on the next pass.
  lastSessionUpdatePayloads.set(id, { payload, bytes })
  lastSessionUpdatePayloadBytes = retainedWithoutExisting + bytes
  setLiveSseReplayCache(lastSessionUpdatePayloads.size, lastSessionUpdatePayloadBytes)
  return true
}

function enforceReplayCacheLimits(limits: LiveConfig['replay']): void {
  let retainedBytes = 0
  let retainedSnapshots = 0
  for (const [id, snapshot] of lastSessionUpdatePayloads) {
    if (retainedSnapshots >= limits.maxSnapshots) {
      lastSessionUpdatePayloads.delete(id)
      recordLiveSseReplayDropped('snapshot_limit')
      continue
    }
    retainedSnapshots++
    if (snapshot.payload === undefined) continue
    if (snapshot.bytes > limits.maxPayloadBytes) {
      lastSessionUpdatePayloads.set(id, { bytes: 0 })
      recordLiveSseReplayDropped('payload_limit')
      continue
    }
    if (retainedBytes + snapshot.bytes > limits.maxTotalBytes) {
      lastSessionUpdatePayloads.set(id, { bytes: 0 })
      recordLiveSseReplayDropped('total_bytes_limit')
      continue
    }
    retainedBytes += snapshot.bytes
  }
  lastSessionUpdatePayloadBytes = retainedBytes
  setLiveSseReplayCache(lastSessionUpdatePayloads.size, retainedBytes)
}

function retainSessionIdentityWithoutPayload(
  id: string,
  retainedBytes: number,
): void {
  lastSessionUpdatePayloads.set(id, { bytes: 0 })
  lastSessionUpdatePayloadBytes = retainedBytes
  setLiveSseReplayCache(lastSessionUpdatePayloads.size, lastSessionUpdatePayloadBytes)
}

function forgetSessionUpdatePayload(id: string): void {
  const snapshot = lastSessionUpdatePayloads.get(id)
  if (!snapshot) return
  lastSessionUpdatePayloads.delete(id)
  lastSessionUpdatePayloadBytes = Math.max(0, lastSessionUpdatePayloadBytes - snapshot.bytes)
  setLiveSseReplayCache(lastSessionUpdatePayloads.size, lastSessionUpdatePayloadBytes)
}

function attachLifecycle(client: LiveClient, source: LiveLifecycle | undefined, events: string[], listener: () => void): void {
  if (!source?.once || !source.removeListener) return
  for (const event of events) {
    source.once(event, listener)
    client.cleanup.push(() => { source.removeListener?.(event, listener) })
  }
}

function objectValue(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(finish, ms)
    timer.unref?.()
    signal?.addEventListener('abort', finish, { once: true })
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
  })
}
