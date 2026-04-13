import { useEffect } from 'react'
import { unstable_batchedUpdates } from 'react-dom'
import { useSessionStore } from '../stores/session'
import { historyLooksRicher } from '../helpers/session-history'

let notifyCtx: AudioContext | null = null

type BufferedTextPart = {
  sessionId: string
  taskRunId: string | null
  messageId: string
  segmentId: string
  content: string
  mode: 'append' | 'replace'
}

export function useOpenCodeEvents() {
  const setMcpConnections = useSessionStore((s) => s.setMcpConnections)

  useEffect(() => {
    const textBuffers = new Map<string, BufferedTextPart>()
    const pendingStreamEvents: Array<{ sessionId: string | null; data: any }> = []
    const coalescedEventIndexes = new Map<string, number>()
    let frameHandle: number | null = null

    const bufferKey = (part: BufferedTextPart) =>
      part.taskRunId
        ? `${part.sessionId}:${part.taskRunId}:${part.segmentId}`
        : `${part.sessionId}:${part.messageId}:${part.segmentId}`

    const queueBufferedText = (part: BufferedTextPart) => {
      const key = bufferKey(part)
      const existing = textBuffers.get(key)

      if (!existing || part.mode === 'replace') {
        textBuffers.set(key, { ...part })
        return
      }

      if (existing.mode === 'replace') return
      existing.content += part.content
    }

    const coalesceKeyForEvent = (sessionId: string | null, data: any) => {
      if (!sessionId) return null
      switch (data.type) {
        case 'tool_call':
          return `tool:${sessionId}:${data.taskRunId || 'root'}:${data.id}`
        case 'task_run':
          return `task:${sessionId}:${data.id}`
        case 'agent':
          return `agent:${sessionId}`
        case 'todos':
          return `todos:${sessionId}:${data.taskRunId || 'root'}`
        case 'busy':
        case 'queued':
          return `status:${sessionId}`
        case 'compaction':
        case 'compacted':
          return `compaction:${sessionId}:${data.taskRunId || 'root'}:${data.id || data.sourceSessionId || data.type}`
        default:
          return null
      }
    }

    const queueNonTextEvent = (sessionId: string | null, data: any) => {
      const key = coalesceKeyForEvent(sessionId, data)
      if (!key) {
        pendingStreamEvents.push({ sessionId, data })
        return
      }
      const existingIndex = coalescedEventIndexes.get(key)
      if (existingIndex !== undefined) {
        pendingStreamEvents[existingIndex] = { sessionId, data }
        return
      }
      coalescedEventIndexes.set(key, pendingStreamEvents.length)
      pendingStreamEvents.push({ sessionId, data })
    }

    const clearTextBuffersForSession = (sessionId: string) => {
      for (const [key, value] of textBuffers.entries()) {
        if (value.sessionId === sessionId) {
          textBuffers.delete(key)
        }
      }
    }

    const commitTextPart = (
      store: ReturnType<typeof useSessionStore.getState>,
      part: BufferedTextPart,
    ) => {
      if (!part.content) return

      if (part.taskRunId) {
        store.appendTaskText(
          part.sessionId,
          part.taskRunId,
          part.content,
          part.segmentId,
          { replace: part.mode === 'replace' },
        )
        return
      }

      store.appendMessageText(
        part.sessionId,
        part.messageId,
        part.content,
        part.segmentId,
        'assistant',
        { replace: part.mode === 'replace' },
      )
    }

    const shouldCommitTextImmediately = (part: BufferedTextPart) => {
      const state = useSessionStore.getState()
      if (state.currentSessionId !== part.sessionId) return false

      const sessionState = state.sessionStateById[part.sessionId]
      if (!sessionState) return true

      if (part.taskRunId) {
        const taskRun = sessionState.taskRuns.find((task) => task.id === part.taskRunId)
        if (!taskRun) return true
        const segment = taskRun.transcript.find((entry) => entry.id === part.segmentId)
        return !segment || segment.content.length === 0
      }

      const message = sessionState.messages.find((entry) => entry.id === part.messageId)
      if (!message) return true
      const segment = message.segments?.find((entry) => entry.id === part.segmentId)
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
      } catch {}
    }

    const flushStreamEvents = () => {
      frameHandle = null
      if (pendingStreamEvents.length === 0 && textBuffers.size === 0) return

      const events = pendingStreamEvents.splice(0, pendingStreamEvents.length)
      coalescedEventIndexes.clear()

      unstable_batchedUpdates(() => {
        const store = useSessionStore.getState()

        for (const event of events) {
          const { sessionId, data } = event

          switch (data.type) {
            case 'text':
              if (!sessionId) break
              queueBufferedText({
                sessionId,
                taskRunId: data.taskRunId || null,
                messageId: data.messageId || `${sessionId}:assistant:live`,
                segmentId: data.partId || data.messageId || `${sessionId}:segment:live`,
                content: data.content || '',
                mode: data.mode === 'replace' ? 'replace' : 'append',
              })
              break

            case 'tool_call':
              if (!sessionId) break
              if (data.taskRunId) {
                store.updateTaskToolCall(sessionId, data.taskRunId, data.id, {
                  name: data.name,
                  input: data.input,
                  status: data.status,
                  output: data.output,
                  attachments: data.attachments,
                  agent: data.agent,
                  sourceSessionId: data.sourceSessionId,
                })
                break
              }
              store.updateToolCall(sessionId, data.id, {
                name: data.name,
                input: data.input,
                status: data.status,
                output: data.output,
                attachments: data.attachments,
                agent: data.agent,
                sourceSessionId: data.sourceSessionId,
              })
              break

            case 'cost':
              if (!sessionId) break
              if (data.taskRunId) {
                store.addTaskCost(sessionId, data.taskRunId, data.cost, data.tokens)
                break
              }
              store.addCost(sessionId, data.cost, data.tokens)
              break

            case 'agent':
              if (!sessionId) break
              store.setActiveAgent(sessionId, data.name)
              break

            case 'task_run':
              if (!sessionId) break
              store.upsertTaskRun(sessionId, {
                id: data.id,
                title: data.title,
                agent: data.agent,
                status: data.status,
                sourceSessionId: data.sourceSessionId || null,
              })
              break

            case 'compaction':
              if (!sessionId) break
              store.beginCompaction(sessionId, {
                id: data.id || undefined,
                taskRunId: data.taskRunId || null,
                sourceSessionId: data.sourceSessionId || null,
                auto: data.auto,
                overflow: data.overflow,
              })
              break

            case 'compacted':
              if (!sessionId) break
              store.finishCompaction(sessionId, {
                id: data.id || undefined,
                taskRunId: data.taskRunId || null,
                sourceSessionId: data.sourceSessionId || null,
                auto: data.auto,
                overflow: data.overflow,
                completedAt: data.completedAt || null,
              })
              break

            case 'todos':
              if (!sessionId) break
              if (data.taskRunId) {
                store.setTaskTodos(sessionId, data.taskRunId, data.todos || [])
                break
              }
              store.setTodos(sessionId, data.todos || [])
              break

            case 'busy':
            case 'queued':
              if (!sessionId) break
              store.addBusy(sessionId)
              break

            case 'history_refresh':
              if (!sessionId) break
              flushTextBuffers(store, sessionId)
              {
                const revisionAtRequest = store.getSessionRevision(sessionId)
                void window.openCowork.session.messages(sessionId)
                  .then((items) => {
                    if (Array.isArray(items) && items.length > 0) {
                      const latest = useSessionStore.getState()
                      const current = latest.sessionStateById[sessionId]
                      if (
                        latest.busySessions.has(sessionId)
                        && latest.getSessionRevision(sessionId) > revisionAtRequest
                        && !historyLooksRicher(current, items as any[])
                      ) {
                        return
                      }
                      clearTextBuffersForSession(sessionId)
                      latest.hydrateSessionFromItems(sessionId, items as any[], true)
                    }
                  })
                  .catch((err) => {
                    console.error('[history_refresh] Failed to reload session history:', err)
                  })
              }
              break

            case 'done':
              if (!sessionId) break
              flushTextBuffers(store, sessionId)
              clearTextBuffersForSession(sessionId)
              store.removeBusy(sessionId)
              if (!data.synthetic) playDoneSound()
              break

            case 'error':
              if (sessionId) {
                flushTextBuffers(store, sessionId)
                clearTextBuffersForSession(sessionId)
              }
              if (sessionId && data.taskRunId) {
                store.addTaskError(sessionId, data.taskRunId, data.message || 'An error occurred')
              } else {
                store.addError(sessionId || null, data.message || 'An error occurred')
              }
              if (sessionId) {
                store.removeBusy(sessionId)
              }
              break
          }
        }

        flushTextBuffers(store)
      })
    }

    const scheduleEventFlush = () => {
      if (frameHandle !== null) return
      frameHandle = requestAnimationFrame(flushStreamEvents)
    }

    const unsubStream = window.openCowork.on.streamEvent((event) => {
      const data = event.data as any
      if (data.type === 'text') {
        const part = {
          sessionId: event.sessionId,
          taskRunId: data.taskRunId || null,
          messageId: data.messageId || `${event.sessionId}:assistant:live`,
          segmentId: data.partId || data.messageId || `${event.sessionId}:segment:live`,
          content: data.content || '',
          mode: data.mode === 'replace' ? 'replace' : 'append',
        } satisfies BufferedTextPart

        if (shouldCommitTextImmediately(part)) {
          unstable_batchedUpdates(() => {
            commitTextPart(useSessionStore.getState(), part)
          })
        } else {
          queueBufferedText(part)
        }
      } else {
        queueNonTextEvent(event.sessionId, data)
      }
      if (pendingStreamEvents.length > 0 || textBuffers.size > 0) {
        scheduleEventFlush()
      }
    })

    const unsubPermission = window.openCowork.on.permissionRequest((request) => {
      useSessionStore.getState().addApproval({
        id: request.id,
        sessionId: request.sessionId,
        taskRunId: request.taskRunId || null,
        tool: request.tool,
        input: request.input,
        description: request.description,
      })
    })

    const unsubMcp = window.openCowork.on.mcpStatus((statuses) => {
      setMcpConnections(statuses)
    })

    const unsubSessionUpdate = window.openCowork.on.sessionUpdated((data) => {
      useSessionStore.getState().renameSession(data.id, data.title)
    })

    const unsubAuth = window.openCowork.on.authExpired(() => {
      window.dispatchEvent(new CustomEvent('cowork:auth-expired'))
    })

    return () => {
      if (frameHandle !== null) {
        cancelAnimationFrame(frameHandle)
      }
      unsubSessionUpdate?.()
      unsubStream()
      unsubPermission()
      unsubMcp()
      unsubAuth()
    }
  }, [setMcpConnections])
}
