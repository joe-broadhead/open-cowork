import { useEffect } from 'react'
import { flushSync } from 'react-dom'
import type { SessionPatch } from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'
import { shouldCommitStreamingTextImmediately } from '../../lib/session-streaming-flush.ts'

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

  useEffect(() => {
    activeHookMounts += 1
    const textBuffers = new Map<string, SessionPatch>()
    let frameHandle: number | null = null

    const bufferKey = (part: SessionPatch) =>
      part.type === 'task_text' || part.type === 'task_reasoning'
        ? `${part.sessionId}:${part.taskRunId}:${part.segmentId}`
        : `${part.sessionId}:${part.messageId}:${part.segmentId}`

    const queueBufferedText = (part: SessionPatch) => {
      const key = bufferKey(part)
      const existing = textBuffers.get(key)

      if (!existing || part.mode === 'replace') {
        textBuffers.set(key, { ...part })
        return
      }

      if (existing.mode === 'replace') return
      existing.content += part.content
      existing.eventAt = part.eventAt
    }

    const pruneCoveredTextBuffers = (sessionId: string, lastEventAt: number) => {
      for (const [key, value] of textBuffers.entries()) {
        if (value.sessionId !== sessionId) continue
        if (value.eventAt <= lastEventAt) {
          textBuffers.delete(key)
        }
      }
    }

    const commitTextPart = (
      store: ReturnType<typeof useSessionStore.getState>,
      part: SessionPatch,
    ) => {
      if (!part.content) return
      store.applySessionPatch(part)
    }

    const shouldCommitTextImmediately = (part: SessionPatch) => {
      const { currentSessionId, sessionStateById } = useSessionStore.getState()
      return shouldCommitStreamingTextImmediately(part, { currentSessionId, sessionStateById })
    }

    const flushTextBuffers = (store: ReturnType<typeof useSessionStore.getState>, sessionId?: string) => {
      for (const [key, buffer] of textBuffers.entries()) {
        if (sessionId && buffer.sessionId !== sessionId) continue
        if (!buffer.content) {
          textBuffers.delete(key)
          continue
        }
        commitTextPart(store, buffer)
        textBuffers.delete(key)
      }
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

    const flushStreamEvents = () => {
      frameHandle = null
      if (textBuffers.size === 0) return

      flushSync(() => {
        const store = useSessionStore.getState()
        flushTextBuffers(store)
      })
    }

    const scheduleEventFlush = () => {
      if (frameHandle !== null) return
      frameHandle = requestAnimationFrame(flushStreamEvents)
    }

    const unsubSessionPatch = window.coworkApi.on.sessionPatch((patch: SessionPatch) => {
      if (shouldCommitTextImmediately(patch)) {
        flushSync(() => {
          commitTextPart(useSessionStore.getState(), patch)
        })
      } else {
        queueBufferedText(patch)
        scheduleEventFlush()
      }
    })

    const unsubNotification = window.coworkApi.on.notification((event) => {
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

    const unsubSessionView = window.coworkApi.on.sessionView(({ sessionId, view }) => {
      pruneCoveredTextBuffers(sessionId, view.lastEventAt || 0)
      useSessionStore.getState().setSessionView(sessionId, view)
    })

    const unsubPermissionRequest = window.coworkApi.on.permissionRequest((request) => {
      useSessionStore.getState().addPendingApproval(request)
    })

    const unsubMcp = window.coworkApi.on.mcpStatus((statuses) => {
      setMcpConnections(statuses)
    })

    const unsubSessionUpdate = window.coworkApi.on.sessionUpdated((data) => {
      useSessionStore.getState().applySessionMetadata(data)
    })

    // Externally-triggered session deletions (SDK cleanup, another client
    // sharing the same OpenCode server) arrive via this channel. Without
    // it the sidebar would keep a stale row until the user manually
    // refreshed. The main handler only broadcasts for top-level sessions,
    // so this is safe to dispatch directly into `removeSession`.
    const unsubSessionDelete = window.coworkApi.on.sessionDeleted((data) => {
      useSessionStore.getState().removeSession(data.id)
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
      unsubscribeAll()
      activeHookMounts = Math.max(0, activeHookMounts - 1)
      if (activeHookMounts === 0) {
        closeNotifyContext()
      }
    }
  }, [setMcpConnections])
}
