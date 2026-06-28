import { useEffect, useRef } from 'react'
import type { SessionPatch } from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'
import { normalizeWorkspaceId, sessionWorkspaceKey } from '../stores/session-workspace-keys'
import { shouldCommitStreamingTextImmediately } from '../lib/session-streaming-flush.ts'

const STREAM_FLUSH_INTERVAL_MS = 32

let notifyCtx: AudioContext | null = null
let activeHookMounts = 0

function closeNotifyContext() {
  const context = notifyCtx
  notifyCtx = null
  if (!context) return

  try {
    void context.close().catch(() => {
      // Audio notifications are best-effort; cleanup failures should not
      // interrupt renderer teardown.
    })
  } catch {
    // Some browser runtimes can throw synchronously if close is unsupported.
  }
}

function combineSubscriptions(...subscriptions: Array<(() => void) | undefined>) {
  return () => {
    for (let index = subscriptions.length - 1; index >= 0; index -= 1) {
      subscriptions[index]?.()
    }
  }
}

export function useOpenCodeEvents() {
  const setMcpConnections = useSessionStore((s) => s.setMcpConnections)
  // Highest workspace-event sequence whose session snapshot we've already applied, per workspace
  // (audit P1-X2). Out-of-order delivery would otherwise let a stale snapshot overwrite a newer one.
  const lastAppliedWorkspaceSequence = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    activeHookMounts += 1
    let textBuffers: SessionPatch[] = []
    let frameHandle: number | null = null
    let flushTimer: number | null = null
    let lastFlushAt = 0

    const queueBufferedText = (part: SessionPatch) => {
      textBuffers.push({ ...part })
    }

    const isActiveWorkspaceEvent = (workspaceId?: string | null) => {
      return normalizeWorkspaceId(workspaceId) === normalizeWorkspaceId(useSessionStore.getState().activeWorkspaceId)
    }

    const pruneCoveredTextBuffers = (sessionId: string, lastEventAt: number, workspaceId?: string | null) => {
      textBuffers = textBuffers.filter((buffer) => (
        buffer.sessionId !== sessionId
          || normalizeWorkspaceId(buffer.workspaceId) !== normalizeWorkspaceId(workspaceId)
          || buffer.eventAt > lastEventAt
      ))
    }

    const commitTextParts = (
      store: ReturnType<typeof useSessionStore.getState>,
      parts: SessionPatch[],
    ) => {
      const visibleParts = parts.filter((part) => part.content)
      if (visibleParts.length === 0) return
      store.applySessionPatches(visibleParts)
    }

    const shouldCommitTextImmediately = (part: SessionPatch) => {
      const { activeWorkspaceId, currentSessionId, sessionStateById } = useSessionStore.getState()
      return shouldCommitStreamingTextImmediately(part, {
        currentSessionId,
        currentSessionKey: sessionWorkspaceKey(part.workspaceId || activeWorkspaceId, part.sessionId),
        sessionStateById,
      })
    }

    const flushTextBuffers = (
      store: ReturnType<typeof useSessionStore.getState>,
      sessionId?: string,
      workspaceId?: string | null,
    ) => {
      const parts: SessionPatch[] = []
      const retained: SessionPatch[] = []
      for (const buffer of textBuffers) {
        if (
          sessionId
          && (
            buffer.sessionId !== sessionId
            || normalizeWorkspaceId(buffer.workspaceId) !== normalizeWorkspaceId(workspaceId)
          )
        ) {
          retained.push(buffer)
          continue
        }
        if (!buffer.content) {
          continue
        }
        parts.push({ ...buffer })
      }
      textBuffers = retained
      commitTextParts(store, parts)
    }

    const playDoneSound = () => {
      try {
        if (!notifyCtx) notifyCtx = new AudioContext()
        const osc = notifyCtx.createOscillator()
        const gain = notifyCtx.createGain()
        osc.connect(gain)
        gain.connect(notifyCtx.destination)
        osc.frequency.value = 880
        osc.type = 'sine'
        gain.gain.value = 0.03
        gain.gain.exponentialRampToValueAtTime(0.001, notifyCtx.currentTime + 0.15)
        osc.start()
        osc.stop(notifyCtx.currentTime + 0.15)
      } catch {
        // Audio notifications are optional and may be blocked by the browser runtime.
      }
    }

    const flushStreamEvents = (timestamp: number) => {
      frameHandle = null
      if (textBuffers.length === 0) return

      lastFlushAt = timestamp || performance.now()
      const store = useSessionStore.getState()
      flushTextBuffers(store)
    }

    const requestFlushFrame = () => {
      if (frameHandle !== null) return
      frameHandle = requestAnimationFrame(flushStreamEvents)
    }

    const scheduleEventFlush = () => {
      if (frameHandle !== null || flushTimer !== null) return

      const now = performance.now()
      const waitMs = Math.max(0, STREAM_FLUSH_INTERVAL_MS - (now - lastFlushAt))
      if (waitMs <= 0) {
        requestFlushFrame()
        return
      }

      flushTimer = window.setTimeout(() => {
        flushTimer = null
        requestFlushFrame()
      }, waitMs)
    }

    const unsubSessionPatch = window.coworkApi.on.sessionPatch((patch: SessionPatch) => {
      if (!isActiveWorkspaceEvent(patch.workspaceId)) return
      if (shouldCommitTextImmediately(patch)) {
        const store = useSessionStore.getState()
        flushTextBuffers(store, patch.sessionId, patch.workspaceId)
        commitTextParts(useSessionStore.getState(), [patch])
        lastFlushAt = performance.now()
      } else {
        queueBufferedText(patch)
        scheduleEventFlush()
      }
    })

    const unsubNotification = window.coworkApi.on.notification((event) => {
      if (!isActiveWorkspaceEvent(event.workspaceId)) return
      switch (event.type) {
        case 'done':
          if (!event.synthetic) playDoneSound()
          break
        case 'error':
          useSessionStore.getState().addGlobalError(event.message || 'An error occurred')
          break
        default:
          break
      }
    })

    const unsubSessionView = window.coworkApi.on.sessionView(({ sessionId, workspaceId, view }) => {
      if (!isActiveWorkspaceEvent(workspaceId)) return
      pruneCoveredTextBuffers(sessionId, view.lastEventAt || 0, workspaceId)
      useSessionStore.getState().setSessionView(sessionId, view, workspaceId)
    })

    const unsubPermissionRequest = window.coworkApi.on.permissionRequest((request) => {
      if (!isActiveWorkspaceEvent(request.workspaceId)) return
      useSessionStore.getState().addPendingApproval(request)
    })

    const unsubMcp = window.coworkApi.on.mcpStatus((statuses) => {
      setMcpConnections(statuses)
    })

    const unsubSessionUpdate = window.coworkApi.on.sessionUpdated((data) => {
      useSessionStore.getState().applySessionMetadata(data, data.workspaceId)
    })

    // Externally-triggered session deletions (SDK cleanup, another client
    // sharing the same OpenCode server) arrive via this channel. Without
    // it the sidebar would keep a stale row until the user manually
    // refreshed. The main handler only broadcasts for top-level sessions,
    // so this is safe to dispatch directly into `removeSession`.
    const unsubSessionDelete = window.coworkApi.on.sessionDeleted((data) => {
      useSessionStore.getState().removeSession(data.id, data.workspaceId)
    })

    const unsubWorkspaceSessions = window.coworkApi.on.workspaceSessionsUpdated((data) => {
      const store = useSessionStore.getState()
      const workspaceId = normalizeWorkspaceId(data.workspaceId)
      if (workspaceId !== normalizeWorkspaceId(store.activeWorkspaceId)) return
      // Drop a snapshot that isn't newer than the last we applied (audit P1-X2) — out-of-order
      // delivery must not regress the session list. Payloads without a sequence (e.g. resyncs) apply.
      const sequence = typeof data.lastEventSequence === 'number' && Number.isFinite(data.lastEventSequence)
        ? data.lastEventSequence
        : null
      if (sequence !== null) {
        const applied = lastAppliedWorkspaceSequence.current.get(workspaceId)
        if (applied !== undefined && sequence <= applied) return
        lastAppliedWorkspaceSequence.current.set(workspaceId, sequence)
      }
      store.setSessions(data.sessions)
    })

    const unsubAuth = window.coworkApi.on.authExpired(() => {
      window.dispatchEvent(new CustomEvent('open-cowork:auth-expired'))
    })

    // Sibling signal for explicit logout — emitted by the main process
    // after `auth:logout` tears down the token, ADC, and runtime. All
    // renderer windows (not just the one that invoked logout) need to
    // drop cached auth-derived state. Consumers listen on the same
    // custom-event channel as `auth-expired` so the UX is uniform:
    // session-specific chrome clears, sign-in prompts surface, etc.
    const unsubLogout = window.coworkApi.on.authLogout(() => {
      window.dispatchEvent(new CustomEvent('open-cowork:auth-logout'))
    })
    const unsubscribeAll = combineSubscriptions(
      unsubSessionUpdate,
      unsubSessionDelete,
      unsubWorkspaceSessions,
      unsubPermissionRequest,
      unsubSessionView,
      unsubSessionPatch,
      unsubNotification,
      unsubMcp,
      unsubAuth,
      unsubLogout,
    )

    return () => {
      if (frameHandle !== null) {
        cancelAnimationFrame(frameHandle)
      }
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer)
      }
      unsubscribeAll()
      activeHookMounts = Math.max(0, activeHookMounts - 1)
      if (activeHookMounts === 0) {
        closeNotifyContext()
      }
    }
  }, [setMcpConnections])
}
