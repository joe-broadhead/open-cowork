import { useEffect } from 'react'
import { unstable_batchedUpdates } from 'react-dom'
import { useSessionStore } from '../stores/session'
import { historyLooksRicher } from '../helpers/session-history'

let notifyCtx: AudioContext | null = null

export function useOpenCodeEvents() {
  const setMcpConnections = useSessionStore((s) => s.setMcpConnections)

  useEffect(() => {
    const rootTextBuffers = new Map<string, string>()
    const taskTextBuffers = new Map<string, {
      sessionId: string
      taskRunId: string
      segmentId: string
      content: string
    }>()
    const pendingStreamEvents: Array<{ sessionId: string | null; data: any }> = []
    let frameHandle: number | null = null

    const clearTextBuffersForSession = (sessionId: string) => {
      rootTextBuffers.delete(sessionId)
      for (const [key, value] of taskTextBuffers.entries()) {
        if (value.sessionId === sessionId) {
          taskTextBuffers.delete(key)
        }
      }
    }

    const flushBufferedTextForSession = (store: ReturnType<typeof useSessionStore.getState>, sessionId: string) => {
      const rootContent = rootTextBuffers.get(sessionId)
      if (rootContent) {
        store.appendToLastAssistant(sessionId, rootContent)
        rootTextBuffers.delete(sessionId)
      }

      for (const [key, value] of taskTextBuffers.entries()) {
        if (value.sessionId !== sessionId || !value.content) continue
        store.appendTaskText(value.sessionId, value.taskRunId, value.content, value.segmentId)
        taskTextBuffers.delete(key)
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
      if (pendingStreamEvents.length === 0) return

      const events = pendingStreamEvents.splice(0, pendingStreamEvents.length)

      unstable_batchedUpdates(() => {
        const store = useSessionStore.getState()

        for (const event of events) {
          const { sessionId, data } = event

          switch (data.type) {
            case 'text':
              if (!sessionId) break
              if (data.taskRunId) {
                const segmentId = data.messageId || data.partId || `${data.taskRunId}:live`
                const key = `${sessionId}:${data.taskRunId}:${segmentId}`
                const existing = taskTextBuffers.get(key)
                if (existing) {
                  existing.content += data.content || ''
                } else {
                  taskTextBuffers.set(key, {
                    sessionId,
                    taskRunId: data.taskRunId,
                    segmentId,
                    content: data.content || '',
                  })
                }
                break
              }
              rootTextBuffers.set(sessionId, (rootTextBuffers.get(sessionId) || '') + (data.content || ''))
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
                    latest.hydrateSessionFromItems(sessionId, items as any[], true)
                  }
                })
                .catch((err) => {
                  console.error('[history_refresh] Failed to reload session history:', err)
                })
              break

            case 'done':
              if (!sessionId) break
              flushBufferedTextForSession(store, sessionId)
              clearTextBuffersForSession(sessionId)
              store.removeBusy(sessionId)
              if (!data.synthetic) playDoneSound()
              break

            case 'error':
              if (sessionId) {
                flushBufferedTextForSession(store, sessionId)
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

        for (const [sessionId, content] of rootTextBuffers.entries()) {
          if (content) {
            store.appendToLastAssistant(sessionId, content)
          }
        }
        rootTextBuffers.clear()

        for (const buffer of taskTextBuffers.values()) {
          if (buffer.content) {
            store.appendTaskText(buffer.sessionId, buffer.taskRunId, buffer.content, buffer.segmentId)
          }
        }
        taskTextBuffers.clear()
      })
    }

    const scheduleEventFlush = () => {
      if (frameHandle !== null) return
      frameHandle = requestAnimationFrame(flushStreamEvents)
    }

    const unsubStream = window.openCowork.on.streamEvent((event) => {
      pendingStreamEvents.push({
        sessionId: event.sessionId,
        data: event.data as any,
      })
      scheduleEventFlush()
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
