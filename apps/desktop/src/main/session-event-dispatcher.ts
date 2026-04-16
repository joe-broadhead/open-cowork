import type { BrowserWindow } from 'electron'
import type { MessageAttachment, RuntimeNotification, SessionPatch, TodoItem } from '@open-cowork/shared'
import { log } from './logger.ts'
import { shortSessionId } from './log-sanitizer.ts'
import { incrementPerfCounter, measureAsyncPerf, measurePerf, observePerf } from './perf-metrics.ts'
import { sessionEngine } from './session-engine.ts'

export type RuntimeSessionEvent = {
  type?: string
  sessionId?: string | null
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
  sessionIds: Set<string>
  queuedAt: number
  timer: ReturnType<typeof setTimeout> | null
}

const pendingViewFlushByWindowId = new Map<number, PendingViewFlush>()
let sessionHistoryRefreshHandler: ((sessionId: string) => Promise<void>) | null = null
const historyRefreshQueue = new Map<string, {
  win: BrowserWindow
  queued: boolean
  promise: Promise<void>
}>()

function getEventType(event: RuntimeSessionEvent) {
  return String(event.data?.type || event.type || '')
}

export function shouldPublishSessionView(event: RuntimeSessionEvent) {
  if (!event.sessionId) return false
  const eventType = getEventType(event)
  return eventType !== 'text' && eventType !== 'history_refresh'
}

export function getSessionPatch(event: RuntimeSessionEvent): SessionPatch | null {
  if (!event.sessionId) return null
  if (getEventType(event) !== 'text') return null

  const meta = sessionEngine.getSessionMeta(event.sessionId)
  const content = typeof event.data?.content === 'string' ? event.data.content : ''
  const mode = event.data?.mode === 'replace' ? 'replace' : 'append'

  if (event.data?.taskRunId && typeof event.data.taskRunId === 'string') {
    return {
      type: 'task_text',
      sessionId: event.sessionId,
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

  return {
    type: 'message_text',
    sessionId: event.sessionId,
    messageId,
    segmentId: typeof event.data?.partId === 'string' && event.data.partId
      ? event.data.partId
      : messageId,
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
      synthetic: Boolean(event.data?.synthetic),
    }
  }
  if (eventType === 'error' && !event.sessionId) {
    return {
      type: 'error',
      sessionId: null,
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

export function publishSessionView(win: BrowserWindow | null | undefined, sessionId: string | null | undefined) {
  if (!win || win.isDestroyed() || !sessionId) return
  incrementPerfCounter('session.view.published')
  win.webContents.send('session:view', {
    sessionId,
    view: sessionEngine.getSessionView(sessionId),
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

function flushPendingSessionViews(windowId: number) {
  const pending = pendingViewFlushByWindowId.get(windowId)
  if (!pending) return
  pendingViewFlushByWindowId.delete(windowId)
  if (pending.win.isDestroyed()) return
  incrementPerfCounter('session.view.flushes')
  observePerf('session.view.flush.wait', Date.now() - pending.queuedAt, {
    unit: 'ms',
  })
  observePerf('session.view.flush.batch_size', pending.sessionIds.size, {
    unit: 'count',
  })
  measurePerf('session.view.flush.duration', () => {
    for (const sessionId of pending.sessionIds) {
      publishSessionView(pending.win, sessionId)
    }
  }, {
    slowThresholdMs: 8,
    slowData: {
      windowId,
      sessionCount: pending.sessionIds.size,
    },
  })
}

function queueSessionViewPublish(win: BrowserWindow, sessionId: string) {
  const windowId = win.webContents.id
  const existing = pendingViewFlushByWindowId.get(windowId)
  if (existing) {
    existing.sessionIds.add(sessionId)
    return
  }

  const pending: PendingViewFlush = {
    win,
    sessionIds: new Set([sessionId]),
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
          publishSessionView(pending.win, sessionId)
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
  for (const [windowId, pending] of pendingViewFlushByWindowId.entries()) {
    if (!pending.sessionIds.delete(sessionId)) continue
    if (pending.sessionIds.size === 0) {
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
  if (!win || win.isDestroyed()) return
  publishNotification(win, getRuntimeNotification(event))
  if (event.sessionId && eventType === 'history_refresh') {
    queueSessionHistoryRefresh(win, event.sessionId)
    return
  }
  publishSessionPatch(win, getSessionPatch(event))
  if (event.sessionId && shouldPublishSessionView(event)) {
    queueSessionViewPublish(win, event.sessionId)
  }
}
