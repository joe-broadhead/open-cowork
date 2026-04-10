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
            })
          } else {
            addToolCall({
              id: data.id,
              name: data.name,
              input: data.input,
              status: data.status,
              output: data.output,
            })
          }
          break
        }

        case 'cost':
          addCost(data.cost, data.tokens)
          break

        case 'done':
          setIsGenerating(false)
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

    const unsubAuth = window.cowork.on.authExpired(() => {
      // Dispatch custom event — App.tsx listens and shows login screen
      window.dispatchEvent(new CustomEvent('cowork:auth-expired'))
    })

    return () => {
      unsubStream()
      unsubPermission()
      unsubMcp()
      unsubAuth()
    }
  }, [currentSessionId])
}
