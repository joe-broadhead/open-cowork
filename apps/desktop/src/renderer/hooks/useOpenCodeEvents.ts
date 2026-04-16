import { useEffect } from 'react'
import { unstable_batchedUpdates } from 'react-dom'
import type { SessionPatch } from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'

let notifyCtx: AudioContext | null = null

export function useOpenCodeEvents() {
  const setMcpConnections = useSessionStore((s) => s.setMcpConnections)

  useEffect(() => {
    const textBuffers = new Map<string, SessionPatch>()
    let frameHandle: number | null = null

    const bufferKey = (part: SessionPatch) =>
      part.type === 'task_text'
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
      const state = useSessionStore.getState()
      if (state.currentSessionId !== part.sessionId) return false

      const sessionState = state.sessionStateById[part.sessionId]
      if (!sessionState) return true

      if (part.type === 'task_text') {
        const taskRun = sessionState.taskRuns.find((task) => task.id === part.taskRunId)
        if (!taskRun) return true
        const segment = taskRun.transcript.find((entry) => entry.id === part.segmentId)
        return !segment || segment.content.length === 0
      }

      const message = sessionState.messageById[part.messageId]
      if (!message) return true
      const segment = sessionState.messagePartsById[part.segmentId]
      return !segment || segment.content.length === 0
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

      unstable_batchedUpdates(() => {
        const store = useSessionStore.getState()
        flushTextBuffers(store)
      })
    }

    const scheduleEventFlush = () => {
      if (frameHandle !== null) return
      frameHandle = requestAnimationFrame(flushStreamEvents)
    }

    const unsubSessionPatch = window.openCowork.on.sessionPatch((patch: SessionPatch) => {
      if (shouldCommitTextImmediately(patch)) {
        unstable_batchedUpdates(() => {
          commitTextPart(useSessionStore.getState(), patch)
        })
      } else {
        queueBufferedText(patch)
        scheduleEventFlush()
      }
    })

    const unsubNotification = window.openCowork.on.notification((event) => {
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

    const unsubSessionView = window.openCowork.on.sessionView(({ sessionId, view }) => {
      pruneCoveredTextBuffers(sessionId, view.lastEventAt || 0)
      useSessionStore.getState().setSessionView(sessionId, view)
    })

    const unsubMcp = window.openCowork.on.mcpStatus((statuses) => {
      setMcpConnections(statuses)
    })

    const unsubSessionUpdate = window.openCowork.on.sessionUpdated((data) => {
      useSessionStore.getState().applySessionMetadata(data)
    })

    // Externally-triggered session deletions (SDK cleanup, another client
    // sharing the same OpenCode server) arrive via this channel. Without
    // it the sidebar would keep a stale row until the user manually
    // refreshed. The main handler only broadcasts for top-level sessions,
    // so this is safe to dispatch directly into `removeSession`.
    const unsubSessionDelete = window.openCowork.on.sessionDeleted((data) => {
      useSessionStore.getState().removeSession(data.id)
    })

    const unsubAuth = window.openCowork.on.authExpired(() => {
      window.dispatchEvent(new CustomEvent('open-cowork:auth-expired'))
    })

    return () => {
      if (frameHandle !== null) {
        cancelAnimationFrame(frameHandle)
      }
      unsubSessionUpdate?.()
      unsubSessionDelete?.()
      unsubSessionView()
      unsubSessionPatch()
      unsubNotification()
      unsubMcp()
      unsubAuth()
    }
  }, [setMcpConnections])
}
