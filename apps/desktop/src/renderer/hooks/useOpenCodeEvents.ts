import { useEffect } from 'react'
import { useSessionStore } from '../stores/session'

let notifyCtx: AudioContext | null = null

export function useOpenCodeEvents() {
  const appendToLastAssistant = useSessionStore((s) => s.appendToLastAssistant)
  const addToolCall = useSessionStore((s) => s.addToolCall)
  const updateToolCall = useSessionStore((s) => s.updateToolCall)
  const addApproval = useSessionStore((s) => s.addApproval)
  const addCost = useSessionStore((s) => s.addCost)
  const addError = useSessionStore((s) => s.addError)
  const setIsGenerating = useSessionStore((s) => s.setIsGenerating)
  const setActiveAgent = useSessionStore((s) => s.setActiveAgent)
  const setMcpConnections = useSessionStore((s) => s.setMcpConnections)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)

  useEffect(() => {
    const unsubStream = window.cowork.on.streamEvent((event) => {
      const data = event.data as any
      // Accept done/error events from any session (question tool may fire in child sessions)
      const isControl = data.type === 'done' || data.type === 'error' || data.type === 'cost'
      if (!isControl && event.sessionId && event.sessionId !== currentSessionId) return
      switch (data.type) {
        case 'text':
          appendToLastAssistant(data.content)
          break

        case 'tool_call': {
          const existing = useSessionStore.getState().toolCalls.find((tc) => tc.id === data.id)
          if (existing) {
            updateToolCall(data.id, {
              status: data.status,
              output: data.output,
              ...(data.name && data.name !== 'task' ? { name: data.name } : {}),
              ...(data.input && Object.keys(data.input).length > 0 ? { input: data.input } : {}),
              ...(data.attachments ? { attachments: data.attachments } : {}),
            })
          } else {
            addToolCall({
              id: data.id,
              name: data.name,
              input: data.input,
              status: data.status,
              output: data.output,
              attachments: data.attachments,
            })
          }
          break
        }

        case 'cost':
          addCost(data.cost, data.tokens)
          break


        case 'agent':
          useSessionStore.getState().setActiveAgent(data.name)
          break

        case 'compacted':
          useSessionStore.setState({ lastInputTokens: 0 })
          break

        case 'todos':
          useSessionStore.getState().setTodos(data.todos || [])
          break

        case 'busy':
          useSessionStore.getState().addBusy(event.sessionId)
          break

        case 'done':
          useSessionStore.getState().removeBusy(event.sessionId)
          // Only stop generating indicator if this is the currently viewed session
          if (event.sessionId === useSessionStore.getState().currentSessionId) {
            setIsGenerating(false)
          }
          // Subtle notification sound — reuse single AudioContext
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
          setIsGenerating(false)
          if (data.message) addError(data.message)
          break
      }
    })

    const unsubPermission = window.cowork.on.permissionRequest((request) => {
      addApproval({
        id: request.id,
        tool: request.tool,
        input: request.input,
        description: request.description,
      })
    })

    const unsubMcp = window.cowork.on.mcpStatus((statuses) => {
      setMcpConnections(statuses)
    })

    // Auto-sync session titles from model (auto-titling)
    const unsubSessionUpdate = window.cowork.on.sessionUpdated((data) => {
      useSessionStore.getState().renameSession(data.id, data.title)
    })

    const unsubAuth = window.cowork.on.authExpired(() => {
      window.dispatchEvent(new CustomEvent('cowork:auth-expired'))
    })

    return () => {
      unsubSessionUpdate?.();
      unsubStream()
      unsubPermission()
      unsubMcp()
      unsubAuth()
    }
  }, [currentSessionId])
}
