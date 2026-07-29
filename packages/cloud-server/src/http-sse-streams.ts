import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  isCloudSessionEventType,
  type CloudSessionEventType,
} from '@open-cowork/shared'
import type {
  SessionEventRecord,
  WorkspaceEventRecord,
} from './control-plane-store.ts'
import type {
  CloudHttpRouteContext,
  CloudHttpServerOptions,
} from './http-contracts.ts'
import { parseAfterSequence } from './http-request-parsers.ts'
import { writeCorsHeaders } from './http-response-writers.ts'
import {
  writeSnapshotRequiredEvent,
  writeSseEvent,
} from './http-sse-helpers.ts'
import {
  DEFAULT_MAX_SSE_CONNECTIONS_PER_ORG,
  SSE_MAX_BUFFERED_BYTES,
  SSE_REPLAY_BATCH,
  SSE_TCP_KEEPALIVE_MS,
} from './http-routes/sse-limits.ts'
import {
  sessionSseWakeKey,
  workspaceSseWakeKey,
} from './sse-pg-notify.ts'

export function ssePollMs(options: CloudHttpServerOptions) {
  const value = options.ssePollMs ?? 1000
  return Number.isInteger(value) && value > 0 ? value : 1000
}

// Hard ceiling on a single SSE stream's lifetime. A wedged or half-open connection
// cannot pin a server slot indefinitely; EventSource clients reconnect transparently
// (with their Last-Event-ID), so the cap is invisible to healthy clients.
function sseMaxStreamLifetimeMs(): number {
  const raw = Number(process.env.OPEN_COWORK_CLOUD_SSE_MAX_LIFETIME_MS)
  return Number.isInteger(raw) && raw > 0 ? raw : 30 * 60_000
}

// Enable TCP keep-alive on the SSE socket and arm a max-lifetime timer that ends the
// response. Returns the timer so the caller clears it from its cleanup path.
export function armSseSocketLifetime(req: IncomingMessage, res: ServerResponse): ReturnType<typeof setTimeout> {
  req.socket?.setKeepAlive(true, SSE_TCP_KEEPALIVE_MS)
  const timer = setTimeout(() => {
    if (!res.destroyed) res.end()
  }, sseMaxStreamLifetimeMs())
  timer.unref?.()
  return timer
}
function sseMaxConnectionsPerOrg(options: CloudHttpServerOptions): number {
  const value = options.maxSseConnectionsPerOrg
  // Always enforce a positive cap (JOE-844). A missing/invalid option falls back to
  // the documented default so multi-tenant pods cannot run uncapped by accident.
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : DEFAULT_MAX_SSE_CONNECTIONS_PER_ORG
}

type CloudSseSourceEvent = SessionEventRecord | WorkspaceEventRecord

function createOrderedSseWriter(
  res: ServerResponse,
  afterSequence: number,
  inactive: () => boolean,
  subject: {
    sessionId?: string
    entityType?: string
    entityId?: string
  } = {},
) {
  let lastSequence = afterSequence
  const enforceBufferLimit = () => {
    if (res.writableLength > SSE_MAX_BUFFERED_BYTES) res.destroy()
  }
  const writeGapSnapshot = (earliestSequence: number, latestSequence = earliestSequence) => {
    if (inactive() || res.destroyed) return
    const snapshotAfterSequence = lastSequence
    const observedLatestSequence = Math.max(earliestSequence, latestSequence)
    writeSnapshotRequiredEvent(res, snapshotAfterSequence, {
      reason: 'event_retention_gap',
      afterSequence: snapshotAfterSequence,
      earliestSequence,
      latestSequence: observedLatestSequence,
    }, subject)
    lastSequence = Math.max(lastSequence, observedLatestSequence)
    enforceBufferLimit()
  }
  const writeIfNew = (event: CloudSseSourceEvent) => {
    if (inactive() || res.destroyed) return
    if (event.sequence <= lastSequence) return
    // A cursor snapshot and a replay read are not atomic with retention. Detect gaps
    // on every durable or live event and fail closed by dropping the exposing delta;
    // the snapshot refresh supersedes it. Cursor zero is initial hydration, not resume.
    if (lastSequence > 0 && event.sequence > lastSequence + 1) {
      writeGapSnapshot(event.sequence)
      return
    }
    if (!isCloudSessionEventType(event.type)) {
      lastSequence = event.sequence
      return
    }
    const type: CloudSessionEventType = event.type
    writeSseEvent(res, { ...event, type })
    lastSequence = event.sequence
    enforceBufferLimit()
  }

  return {
    get lastSequence() {
      return lastSequence
    },
    writeGapSnapshot,
    writeIfNew,
  }
}

export function trackSseStream(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  cleanup: () => void,
  orgKey?: string | null,
) {
  if (options.sseStreamRegistry) {
    return options.sseStreamRegistry.track(req, res, cleanup, { orgKey: orgKey || undefined, maxPerOrg: sseMaxConnectionsPerOrg(options) })
  }

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    req.off('close', close)
    res.off('close', close)
    res.off('finish', close)
    cleanup()
  }
  req.once('close', close)
  res.once('close', close)
  res.once('finish', close)
  return true
}

export async function handleSessionSse(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  context: CloudHttpRouteContext,
  sessionId: string,
) {
  const afterSequence = parseAfterSequence(req, context.url)
  let cleaned = false
  let unsubscribe: (() => void) | null = null
  let replayUnsubscribe: (() => void) | null = null
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    if (lifetimeTimer) clearTimeout(lifetimeTimer)
    replayUnsubscribe?.()
    unsubscribe?.()
  }
  const unavailable = () => (
    cleaned
    || req.destroyed
    || req.aborted
    || res.destroyed
    || res.writableEnded
  )
  const disarmPreflightClose = () => {
    req.off('close', cleanup)
    res.off('close', cleanup)
  }
  // Session authorization must finish before a 200 response, but a disconnect can
  // happen while that lookup is pending. Guard the await, then hand off atomically to
  // the normal stream tracker so a one-shot close event is never missed.
  req.once('close', cleanup)
  res.once('close', cleanup)
  if (unavailable()) {
    disarmPreflightClose()
    cleanup()
    return
  }
  let cursor: Awaited<ReturnType<typeof options.service.getSessionEventCursor>>
  try {
    cursor = await options.service.getSessionEventCursor(context.principal, sessionId)
  } catch (error) {
    const disconnected = unavailable()
    disarmPreflightClose()
    if (disconnected) {
      cleanup()
      return
    }
    throw error
  }
  if (unavailable()) {
    disarmPreflightClose()
    cleanup()
    return
  }
  disarmPreflightClose()
  writeCorsHeaders(res, options.corsOrigin)
  if (!trackSseStream(req, res, options, cleanup, context.principal.orgId || context.principal.tenantId)) return
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  lifetimeTimer = armSseSocketLifetime(req, res)
  const stream = createOrderedSseWriter(
    res,
    afterSequence,
    () => cleaned,
    {
      sessionId,
      entityType: 'session',
      entityId: sessionId,
    },
  )
  const earliestSequence = cursor.earliestSequence
  const hasReplayGap = afterSequence > 0
    && earliestSequence !== null
    && earliestSequence > afterSequence + 1
  if (hasReplayGap) {
    const latestSequence = cursor.latestSequence || afterSequence
    stream.writeGapSnapshot(earliestSequence, latestSequence)
  } else {
    // Drain the catch-up backlog in bounded keyset pages. Authorization ran once in
    // getSessionEventCursor; use the guard-free steady-state read for every page.
    let drainAfter = afterSequence
    for (;;) {
      const batch = await options.service.listSessionEventsForStream(context.principal.tenantId, sessionId, drainAfter, SSE_REPLAY_BATCH)
      for (const event of batch) stream.writeIfNew(event)
      if (cleaned || batch.length < SSE_REPLAY_BATCH) break
      drainAfter = batch[batch.length - 1]!.sequence
    }
  }
  if (cleaned) return
  const replayWakeKey = sessionSseWakeKey(context.principal.tenantId, sessionId)
  unsubscribe = options.service.eventBus.subscribe({
    tenantId: context.principal.tenantId,
    sessionId,
    afterSequence: stream.lastSequence,
  }, (event) => {
    if (event.sequence <= stream.lastSequence) return
    // Keep the zero-query live fast path only while it is contiguous. A gap means an
    // in-flight durable replay may own an earlier event, so wake that serialized reader.
    if (!options.sseReplayHub || event.sequence === stream.lastSequence + 1) {
      stream.writeIfNew(event)
      return
    }
    options.sseReplayHub.wake(replayWakeKey)
  })
  replayUnsubscribe = options.sseReplayHub?.subscribe({
    key: `session:${context.principal.tenantId}:${context.principal.userId}:${sessionId}`,
    // Coarse wake key drops the per-subscriber userId so one session NOTIFY wakes every
    // user watching the session. Inert when the LISTEN/NOTIFY accelerator is off.
    wakeKey: replayWakeKey,
    afterSequence: stream.lastSequence,
    pollMs: ssePollMs(options),
    loadEvents: (sequence) => options.service.listSessionEventsForStream(context.principal.tenantId, sessionId, sequence, SSE_REPLAY_BATCH),
    listener: (event) => stream.writeIfNew(event as SessionEventRecord),
    batchSize: SSE_REPLAY_BATCH,
  }) ?? null
  keepAliveTimer = setInterval(() => {
    if (cleaned || res.destroyed) return
    res.write(': keep-alive\n\n')
  }, ssePollMs(options))
}

export async function handleWorkspaceSse(
  req: IncomingMessage,
  res: ServerResponse,
  options: CloudHttpServerOptions,
  context: CloudHttpRouteContext,
) {
  const afterSequence = parseAfterSequence(req, context.url)
  let cleaned = false
  let unsubscribe: (() => void) | null = null
  let replayUnsubscribe: (() => void) | null = null
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null
  let lifetimeTimer: ReturnType<typeof setTimeout> | null = null
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (keepAliveTimer) clearInterval(keepAliveTimer)
    if (lifetimeTimer) clearTimeout(lifetimeTimer)
    replayUnsubscribe?.()
    unsubscribe?.()
  }
  writeCorsHeaders(res, options.corsOrigin)
  if (!trackSseStream(req, res, options, cleanup, context.principal.orgId || context.principal.tenantId)) return
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  lifetimeTimer = armSseSocketLifetime(req, res)
  const stream = createOrderedSseWriter(res, afterSequence, () => cleaned)

  const cursor = await options.service.getWorkspaceEventCursor(context.principal)
  if (cleaned || res.destroyed) return
  const earliestSequence = cursor.earliestSequence
  const hasReplayGap = afterSequence > 0
    && earliestSequence !== null
    && earliestSequence > afterSequence + 1

  if (hasReplayGap) {
    const latestSequence = cursor.latestSequence || afterSequence
    stream.writeGapSnapshot(earliestSequence, latestSequence)
  } else {
    // Bounded keyset drain of the workspace backlog (see the session handler).
    let drainAfter = afterSequence
    for (;;) {
      const batch = await options.service.listWorkspaceEvents(context.principal, drainAfter, SSE_REPLAY_BATCH)
      for (const event of batch) stream.writeIfNew(event)
      if (cleaned || batch.length < SSE_REPLAY_BATCH) break
      drainAfter = batch[batch.length - 1]!.sequence
    }
  }

  if (cleaned) return
  const replayWakeKey = workspaceSseWakeKey(context.principal.tenantId, context.principal.userId)
  unsubscribe = options.service.workspaceEventBus.subscribe({
    tenantId: context.principal.tenantId,
    userId: context.principal.userId,
    afterSequence: stream.lastSequence,
  }, (event) => {
    if (event.sequence <= stream.lastSequence) return
    // See the session stream: never advance the live cursor across a durable gap.
    if (!options.sseReplayHub || event.sequence === stream.lastSequence + 1) {
      stream.writeIfNew(event)
      return
    }
    options.sseReplayHub.wake(replayWakeKey)
  })
  replayUnsubscribe = options.sseReplayHub?.subscribe({
    key: `workspace:${context.principal.tenantId}:${context.principal.userId}`,
    // Workspace topics are already per-user, so the wake key equals the topic key.
    // Inert when the LISTEN/NOTIFY accelerator is off.
    wakeKey: replayWakeKey,
    afterSequence: stream.lastSequence,
    pollMs: ssePollMs(options),
    loadEvents: (sequence) => options.service.listWorkspaceEventsForStream(context.principal.tenantId, context.principal.userId, sequence, SSE_REPLAY_BATCH),
    listener: (event) => stream.writeIfNew(event as WorkspaceEventRecord),
    batchSize: SSE_REPLAY_BATCH,
  }) ?? null
  keepAliveTimer = setInterval(() => {
    if (cleaned || res.destroyed) return
    res.write(': keep-alive\n\n')
  }, ssePollMs(options))
}
