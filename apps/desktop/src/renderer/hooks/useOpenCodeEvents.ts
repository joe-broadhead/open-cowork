import { useEffect } from 'react'
import { useSessionStore } from '../stores/session'

let notifyCtx: AudioContext | null = null

export function useOpenCodeEvents() {
  const setMcpConnections = useSessionStore((s) => s.setMcpConnections)

  useEffect(() => {
    const textBuffers = new Map<string, string>()
    const flushScheduled = new Set<string>()

    const scheduleFlush = (sessionId: string) => {
      if (flushScheduled.has(sessionId)) return
      flushScheduled.add(sessionId)

      requestAnimationFrame(() => {
        const content = textBuffers.get(sessionId)
        if (content) {
          useSessionStore.getState().appendToLastAssistant(sessionId, content)
          textBuffers.delete(sessionId)
        }
        flushScheduled.delete(sessionId)
      })
    }

    const unsubStream = window.cowork.on.streamEvent((event) => {
      const data = event.data as any
      const sessionId = event.sessionId
      const store = useSessionStore.getState()

      switch (data.type) {
        case 'text':
          if (!sessionId) break
          if (data.taskRunId) {
            store.appendTaskText(sessionId, data.taskRunId, data.content || '', data.messageId || data.partId)
            break
          }
          textBuffers.set(sessionId, (textBuffers.get(sessionId) || '') + data.content)
          scheduleFlush(sessionId)
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

        case 'compacted':
          if (!sessionId) break
          store.resetLastInputTokens(sessionId)
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
          if (!sessionId) break
          store.addBusy(sessionId)
          break

        case 'queued':
          if (!sessionId) break
          store.addBusy(sessionId)
          break

        case 'done':
          if (!sessionId) break
          store.removeBusy(sessionId)
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
          break

        case 'error':
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
    })

    const unsubPermission = window.cowork.on.permissionRequest((request) => {
      useSessionStore.getState().addApproval({
        id: request.id,
        sessionId: request.sessionId,
        taskRunId: request.taskRunId || null,
        tool: request.tool,
        input: request.input,
        description: request.description,
      })
    })

    const unsubMcp = window.cowork.on.mcpStatus((statuses) => {
      setMcpConnections(statuses)
    })

    const unsubSessionUpdate = window.cowork.on.sessionUpdated((data) => {
      useSessionStore.getState().renameSession(data.id, data.title)
    })

    const unsubAuth = window.cowork.on.authExpired(() => {
      window.dispatchEvent(new CustomEvent('cowork:auth-expired'))
    })

    return () => {
      unsubSessionUpdate?.()
      unsubStream()
      unsubPermission()
      unsubMcp()
      unsubAuth()
    }
  }, [setMcpConnections])
}
