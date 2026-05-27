import type { BrowserWindow } from 'electron'
import type { MessageAttachment, RuntimeNotification, SessionPatch, TodoItem } from '@open-cowork/shared'
import { log } from './logger.ts'
import { shortSessionId } from './log-sanitizer.ts'
import { incrementPerfCounter, measureAsyncPerf, measurePerf, observePerf } from './perf-metrics.ts'
import { sessionEngine } from './session-engine.ts'
import { getThreadIndexService } from './thread-index/thread-index-service.ts'
import { getSessionRecord } from './session-registry.ts'

export type RuntimeSessionEvent = {
  type?: string
  sessionId?: string | null
  workspaceId?: string | null
  data?: {
    type?: string
    content?: string
    role?: 'user' | 'assistant'
    attachments?: MessageAttachment[]
    messageId?: string | null
    partId?: string | null
    taskRunId?: string | null
    id?: string
    name?: string | null
    input?: Record<string, unknown>
    status?: string
    output?: unknown
    agent?: string | null
    sourceSessionId?: string | null
    title?: string
    cost?: number
    tokens?: {
      input?: number
      output?: number
      reasoning?: number
      cache?: { read?: number; write?: number }
    }
    todos?: TodoItem[]
    auto?: boolean
    overflow?: boolean
    completedAt?: string
    tool?: string | {
      messageId?: string
      callId?: string
    }
    description?: string
    message?: string
    mode?: 'append' | 'replace'
    questions?: Array<{
      header: string
      question: string
      options: Array<{ label: string; description: string }>
      multiple?: boolean
      custom?: boolean
    }>
    [key: string]: unknown
  }
}

type PendingViewFlush = {
  win: BrowserWindow
  sessions: Map<string, { sessionId: string; workspaceId?: string | null }>
  queuedAt: number
  timer: ReturnType<typeof setTimeout> | null
}

type PendingPatchFlush = {
  win: BrowserWindow
  patches: SessionPatch[]
  overflowSessionIds: Set<string>
  droppedPatches: number
  queuedAt: number
  timer: ReturnType<typeof setTimeout> | null
}

const SESSION_PATCH_FLUSH_INTERVAL_MS = 8
const MAX_PENDING_SESSION_PATCHES_PER_WINDOW = 512
const MAX_SESSION_PATCHES_PER_FLUSH = 128

const pendingViewFlushByWindowId = new Map<number, PendingViewFlush>()
const pendingPatchFlushByWindowId = new Map<number, PendingPatchFlush>()
const patchViewRecoverySessionIdsByWindowId = new Map<number, Set<string>>()
let sessionHistoryRefreshHandler: ((sessionId: string) => Promise<void>) | null = null
const historyRefreshQueue = new Map<string, {
  win: BrowserWindow
  queued: boolean
  promise: Promise<void>
}>()

function sessionFlushKey(sessionId: string, workspaceId?: string | null) {
  return `${workspaceId || 'local'}:${sessionId}`
}

function getEventType(event: RuntimeSessionEvent) {
  return String(event.data?.type || event.type || '')
}

function workspacePatch(workspaceId?: string | null) {
  return workspaceId ? { workspaceId } : {}
}

export function shouldPublishSessionView(event: RuntimeSessionEvent) {
  if (!event.sessionId) return false
  if (event.workspaceId && event.workspaceId !== 'local') return false
  const eventType = getEventType(event)
  return eventType !== 'text' && eventType !== 'reasoning' && eventType !== 'history_refresh'
}

export function getSessionPatch(event: RuntimeSessionEvent): SessionPatch | null {
  if (!event.sessionId) return null
  const eventType = getEventType(event)
  if (eventType !== 'text' && eventType !== 'reasoning') return null

  const meta = sessionEngine.getSessionMeta(event.sessionId)
  const content = typeof event.data?.content === 'string' ? event.data.content : ''
  const mode = event.data?.mode === 'replace' ? 'replace' : 'append'
  const isReasoning = eventType === 'reasoning'

  if (event.data?.taskRunId && typeof event.data.taskRunId === 'string') {
    return {
      type: isReasoning ? 'task_reasoning' : 'task_text',
      sessionId: event.sessionId,
      ...workspacePatch(event.workspaceId),
      taskRunId: event.data.taskRunId,
      segmentId: typeof event.data.partId === 'string' && event.data.partId
        ? event.data.partId
        : typeof event.data.messageId === 'string' && event.data.messageId
          ? event.data.messageId
          : `${event.data.taskRunId}:live`,
      content,
      mode,
      eventAt: meta.lastEventAt,
    }
  }

  const messageId = typeof event.data?.messageId === 'string' && event.data.messageId
    ? event.data.messageId
    : `${event.sessionId}:assistant:live`

  const segmentId = typeof event.data?.partId === 'string' && event.data.partId
    ? event.data.partId
    : messageId

  if (isReasoning) {
    return {
      type: 'message_reasoning',
      sessionId: event.sessionId,
      ...workspacePatch(event.workspaceId),
      messageId,
      segmentId,
      content,
      mode,
      eventAt: meta.lastEventAt,
    }
  }

  return {
    type: 'message_text',
    sessionId: event.sessionId,
    ...workspacePatch(event.workspaceId),
    messageId,
    segmentId,
    content,
    mode,
    role: event.data?.role === 'user' ? 'user' : 'assistant',
    attachments: Array.isArray(event.data?.attachments) ? event.data.attachments : undefined,
    eventAt: meta.lastEventAt,
  }
}

export function getRuntimeNotification(event: RuntimeSessionEvent): RuntimeNotification | null {
  const eventType = getEventType(event)
  if (eventType === 'done') {
    return {
      type: 'done',
      sessionId: event.sessionId || null,
      ...workspacePatch(event.workspaceId),
      synthetic: Boolean(event.data?.synthetic),
    }
  }
  if (eventType === 'error' && !event.sessionId) {
    return {
      type: 'error',
      sessionId: null,
      ...workspacePatch(event.workspaceId),
      message: typeof event.data?.message === 'string' ? event.data.message : 'An error occurred',
    }
  }
  return null
}

export function setSessionHistoryRefreshHandler(
  handler: ((sessionId: string) => Promise<void>) | null,
) {
  sessionHistoryRefreshHandler = handler
}

export function publishNotification(
  win: BrowserWindow | null | undefined,
  notification: RuntimeNotification | null | undefined,
) {
  if (!win || win.isDestroyed() || !notification) return
  incrementPerfCounter('runtime.notification.published')
  win.webContents.send('runtime:notification', notification)
}

export function publishSessionView(
  win: BrowserWindow | null | undefined,
  sessionId: string | null | undefined,
  workspaceId?: string | null,
) {
  if (!win || win.isDestroyed() || !sessionId) return
  if (workspaceId && workspaceId !== 'local') return
  incrementPerfCounter('session.view.published')
  win.webContents.send('session:view', {
    sessionId,
    workspaceId: workspaceId || undefined,
    view: sessionEngine.getSessionView(sessionId),
  })
}

export function publishSessionMetadata(win: BrowserWindow | null | undefined, sessionId: string | null | undefined) {
  if (!win || win.isDestroyed() || !sessionId) return
  const record = getSessionRecord(sessionId)
  if (!record) return
  win.webContents.send('session:updated', {
    id: record.id,
    title: record.title || null,
    parentSessionId: record.parentSessionId,
    changeSummary: record.changeSummary,
    revertedMessageId: record.revertedMessageId,
    composerModelId: record.composerModelId,
    composerReasoningVariant: record.composerReasoningVariant,
  })
}

export function publishSessionPatch(
  win: BrowserWindow | null | undefined,
  patch: SessionPatch | null | undefined,
) {
  if (!win || win.isDestroyed() || !patch) return
  incrementPerfCounter('session.patch.published')
  win.webContents.send('session:patch', patch)
}

function markSessionPatchViewRecovery(windowId: number, sessionId: string, workspaceId?: string | null) {
  const existing = patchViewRecoverySessionIdsByWindowId.get(windowId)
  const key = sessionFlushKey(sessionId, workspaceId)
  if (existing) {
    existing.add(key)
    return
  }
  patchViewRecoverySessionIdsByWindowId.set(windowId, new Set([key]))
}

function clearSessionPatchViewRecovery(windowId: number, sessionId: string, workspaceId?: string | null) {
  const existing = patchViewRecoverySessionIdsByWindowId.get(windowId)
  if (!existing) return
  existing.delete(sessionFlushKey(sessionId, workspaceId))
  if (existing.size === 0) patchViewRecoverySessionIdsByWindowId.delete(windowId)
}

function sessionNeedsPatchViewRecovery(windowId: number, sessionId: string, workspaceId?: string | null) {
  return patchViewRecoverySessionIdsByWindowId.get(windowId)?.has(sessionFlushKey(sessionId, workspaceId)) === true
}

function dropQueuedSessionPatches(pending: PendingPatchFlush, sessionId: string, workspaceId?: string | null) {
  const key = sessionFlushKey(sessionId, workspaceId)
  const before = pending.patches.length
  pending.patches = pending.patches.filter((queuedPatch) => sessionFlushKey(queuedPatch.sessionId, queuedPatch.workspaceId) !== key)
  return before - pending.patches.length
}

function recoverSessionWithViewOnlyCatchUp(windowId: number, sessionId: string, workspaceId?: string | null, pending?: PendingPatchFlush) {
  markSessionPatchViewRecovery(windowId, sessionId, workspaceId)
  if (!pending) return
  const dropped = dropQueuedSessionPatches(pending, sessionId, workspaceId)
  if (dropped > 0) pending.droppedPatches += dropped
  pending.overflowSessionIds.add(sessionFlushKey(sessionId, workspaceId))
}

function sessionHasQueuedView(windowId: number, sessionId: string, workspaceId?: string | null) {
  return pendingViewFlushByWindowId.get(windowId)?.sessions.has(sessionFlushKey(sessionId, workspaceId)) === true
}

function flushQueuedSessionPatchesBeforeView(win: BrowserWindow, sessionId: string, workspaceId?: string | null) {
  const webContents = win.webContents as BrowserWindow['webContents'] & { isDestroyed?: () => boolean }
  if (win.isDestroyed() || webContents.isDestroyed?.()) return
  const windowId = webContents.id
  const pending = pendingPatchFlushByWindowId.get(windowId)
  if (!pending || pending.patches.length === 0) return

  const queuedForSession: SessionPatch[] = []
  const key = sessionFlushKey(sessionId, workspaceId)
  pending.patches = pending.patches.filter((patch) => {
    if (sessionFlushKey(patch.sessionId, patch.workspaceId) !== key) return true
    queuedForSession.push(patch)
    return false
  })
  for (const patch of queuedForSession) publishSessionPatch(win, patch)
}

function flushPendingSessionPatches(windowId: number) {
  const pending = pendingPatchFlushByWindowId.get(windowId)
  if (!pending) return
  pending.timer = null

  if (pending.win.isDestroyed() || pending.win.webContents.isDestroyed()) {
    pendingPatchFlushByWindowId.delete(windowId)
    return
  }

  const batch = pending.patches.splice(0, MAX_SESSION_PATCHES_PER_FLUSH)
  if (batch.length > 0) {
    observePerf('session.patch.flush.wait', Date.now() - pending.queuedAt, {
      unit: 'ms',
    })
    observePerf('session.patch.flush.batch_size', batch.length, {
      unit: 'count',
    })
    measurePerf('session.patch.flush.duration', () => {
      for (const patch of batch) publishSessionPatch(pending.win, patch)
    }, {
      slowThresholdMs: 8,
      slowData: {
        windowId,
        patchCount: batch.length,
      },
    })
  }

  if (pending.patches.length > 0) {
    pending.timer = setTimeout(() => {
      flushPendingSessionPatches(windowId)
    }, 0)
    return
  }

  pendingPatchFlushByWindowId.delete(windowId)
  if (pending.droppedPatches > 0) {
    incrementPerfCounter('session.patch.dropped')
    log(
      'events',
      `Dropped ${pending.droppedPatches} queued session patch${pending.droppedPatches === 1 ? '' : 'es'} for window=${windowId}; queued full view catch-up for ${pending.overflowSessionIds.size} session${pending.overflowSessionIds.size === 1 ? '' : 's'}`,
    )
  }
}

function queueSessionPatchPublish(win: BrowserWindow, patch: SessionPatch | null | undefined) {
  if (!patch) return
  const windowId = win.webContents.id
  if (sessionNeedsPatchViewRecovery(windowId, patch.sessionId, patch.workspaceId)) {
    let pending = pendingPatchFlushByWindowId.get(windowId)
    if (!pending) {
      pending = {
        win,
        patches: [],
        overflowSessionIds: new Set(),
        droppedPatches: 0,
        queuedAt: Date.now(),
        timer: null,
      }
      pending.timer = setTimeout(() => {
        flushPendingSessionPatches(windowId)
      }, SESSION_PATCH_FLUSH_INTERVAL_MS)
      pendingPatchFlushByWindowId.set(windowId, pending)
    }
    pending.droppedPatches += 1
    pending.overflowSessionIds.add(sessionFlushKey(patch.sessionId, patch.workspaceId))
    return
  }

  if (sessionHasQueuedView(windowId, patch.sessionId, patch.workspaceId)) {
    publishSessionPatch(win, patch)
    return
  }

  let pending = pendingPatchFlushByWindowId.get(windowId)
  if (!pending) {
    pending = {
      win,
      patches: [],
      overflowSessionIds: new Set(),
      droppedPatches: 0,
      queuedAt: Date.now(),
      timer: null,
    }
    pending.timer = setTimeout(() => {
      flushPendingSessionPatches(windowId)
    }, SESSION_PATCH_FLUSH_INTERVAL_MS)
    pendingPatchFlushByWindowId.set(windowId, pending)
  }

  if (pending.patches.length >= MAX_PENDING_SESSION_PATCHES_PER_WINDOW) {
    recoverSessionWithViewOnlyCatchUp(windowId, patch.sessionId, patch.workspaceId, pending)
    pending.droppedPatches += 1
    queueSessionViewPublish(win, patch.sessionId, patch.workspaceId)
    return
  }

  pending.patches.push(patch)
}

function flushPendingSessionViews(windowId: number) {
  const pending = pendingViewFlushByWindowId.get(windowId)
  if (!pending) return
  pendingViewFlushByWindowId.delete(windowId)
  if (pending.win.isDestroyed()) {
    for (const entry of pending.sessions.values()) clearSessionPatchViewRecovery(windowId, entry.sessionId, entry.workspaceId)
    return
  }
  incrementPerfCounter('session.view.flushes')
  observePerf('session.view.flush.wait', Date.now() - pending.queuedAt, {
    unit: 'ms',
  })
  observePerf('session.view.flush.batch_size', pending.sessions.size, {
    unit: 'count',
  })
  measurePerf('session.view.flush.duration', () => {
    for (const entry of pending.sessions.values()) {
      publishSessionView(pending.win, entry.sessionId, entry.workspaceId)
      clearSessionPatchViewRecovery(windowId, entry.sessionId, entry.workspaceId)
    }
  }, {
    slowThresholdMs: 8,
    slowData: {
      windowId,
      sessionCount: pending.sessions.size,
    },
  })
}

function queueSessionViewPublish(win: BrowserWindow, sessionId: string, workspaceId?: string | null) {
  if (workspaceId && workspaceId !== 'local') return
  const windowId = win.webContents.id
  if (!sessionNeedsPatchViewRecovery(windowId, sessionId, workspaceId)) {
    flushQueuedSessionPatchesBeforeView(win, sessionId, workspaceId)
  }
  const key = sessionFlushKey(sessionId, workspaceId)
  const existing = pendingViewFlushByWindowId.get(windowId)
  if (existing) {
    existing.sessions.set(key, { sessionId, workspaceId })
    return
  }

  const pending: PendingViewFlush = {
    win,
    sessions: new Map([[key, { sessionId, workspaceId }]]),
    queuedAt: Date.now(),
    timer: null,
  }
  pending.timer = setTimeout(() => {
    flushPendingSessionViews(windowId)
  }, 16)
  pendingViewFlushByWindowId.set(windowId, pending)
}

function queueSessionHistoryRefresh(win: BrowserWindow, sessionId: string) {
  const existing = historyRefreshQueue.get(sessionId)
  if (existing) {
    existing.win = win
    existing.queued = true
    incrementPerfCounter('session.history.refresh.coalesced')
    return
  }

  const pending = {
    win,
    queued: false,
    promise: Promise.resolve(),
  }

  const runRefresh = async () => {
    try {
      while (true) {
        pending.queued = false
        try {
          const refreshHandler = sessionHistoryRefreshHandler
          if (!refreshHandler) break
          await measureAsyncPerf('session.history.refresh', async () => {
            await refreshHandler(sessionId)
          }, {
            slowThresholdMs: 300,
            slowData: { sessionId: shortSessionId(sessionId) },
          })
          flushQueuedSessionPatchesBeforeView(pending.win, sessionId)
          publishSessionView(pending.win, sessionId)
          publishSessionMetadata(pending.win, sessionId)
        } catch (err) {
          const message = err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : JSON.stringify(err)
          log('error', `history_refresh ${shortSessionId(sessionId)} failed: ${message}`)
        }
        if (!pending.queued) break
      }
    } finally {
      historyRefreshQueue.delete(sessionId)
    }
  }

  pending.promise = runRefresh()
  historyRefreshQueue.set(sessionId, pending)
}

// Called from the session.deleted SSE handler so pending view-flush + history
// refresh queues don't keep stale references to the removed session. Any
// in-flight history refresh that was already mid-loop will no-op its final
// publishSessionView (the session is gone by then) but is otherwise benign.
export function dropSessionFromDispatcherQueues(sessionId: string) {
  historyRefreshQueue.delete(sessionId)
  for (const [windowId, recoverySessionIds] of patchViewRecoverySessionIdsByWindowId.entries()) {
    recoverySessionIds.delete(sessionFlushKey(sessionId))
    if (recoverySessionIds.size === 0) patchViewRecoverySessionIdsByWindowId.delete(windowId)
  }
  for (const [windowId, pending] of pendingPatchFlushByWindowId.entries()) {
    dropQueuedSessionPatches(pending, sessionId)
    pending.overflowSessionIds.delete(sessionFlushKey(sessionId))
    if (pending.patches.length === 0 && pending.overflowSessionIds.size === 0) {
      if (pending.timer) clearTimeout(pending.timer)
      pendingPatchFlushByWindowId.delete(windowId)
    }
  }
  for (const [windowId, pending] of pendingViewFlushByWindowId.entries()) {
    if (!pending.sessions.delete(sessionFlushKey(sessionId))) continue
    if (pending.sessions.size === 0) {
      if (pending.timer) clearTimeout(pending.timer)
      pendingViewFlushByWindowId.delete(windowId)
    }
  }
}

export function dispatchRuntimeSessionEvent(
  win: BrowserWindow | null | undefined,
  event: RuntimeSessionEvent,
) {
  const eventType = getEventType(event)
  sessionEngine.applyStreamEvent(event)
  if (event.sessionId) {
    try {
      getThreadIndexService().scheduleThreadMetadataRefresh(event.sessionId)
    } catch (err) {
      log('thread-index', `Metadata refresh scheduling failed session=${shortSessionId(event.sessionId)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (!win || win.isDestroyed()) return
  publishNotification(win, getRuntimeNotification(event))
  if (event.sessionId && eventType === 'history_refresh') {
    queueSessionHistoryRefresh(win, event.sessionId)
    return
  }
  queueSessionPatchPublish(win, getSessionPatch(event))
  if (event.sessionId && shouldPublishSessionView(event)) {
    queueSessionViewPublish(win, event.sessionId, event.workspaceId)
  }
}
