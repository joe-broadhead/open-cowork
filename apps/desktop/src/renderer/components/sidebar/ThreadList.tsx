import { useSessionStore } from '../../stores/session'

export function ThreadList() {
  const sessions = useSessionStore((s) => s.sessions)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const clearMessages = useSessionStore((s) => s.clearMessages)
  const addMessage = useSessionStore((s) => s.addMessage)

  if (sessions.length === 0) {
    return (
      <div className="px-2 py-3 text-[11px] text-text-muted text-center">
        No threads yet
      </div>
    )
  }

  const handleSelect = async (sessionId: string) => {
    if (sessionId === currentSessionId) return
    setCurrentSession(sessionId)
    clearMessages()

    // Load message history for this session
    try {
      const messages = await window.cowork.session.messages(sessionId)
      for (const msg of messages) {
        addMessage({
          id: msg.id,
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        })
      }
    } catch (err) {
      console.error('Failed to load messages:', err)
    }
  }

  return (
    <div className="flex flex-col gap-px">
      {sessions.map((session) => {
        const isActive = session.id === currentSessionId
        return (
          <button
            key={session.id}
            onClick={() => handleSelect(session.id)}
            className={`w-full text-left px-3 py-[7px] rounded-md text-[13px] truncate transition-colors cursor-pointer ${
              isActive
                ? 'bg-surface-active text-text'
                : 'text-text-secondary hover:bg-surface-hover hover:text-text'
            }`}
          >
            {session.title || `Thread ${session.id.slice(0, 6)}`}
          </button>
        )
      })}
    </div>
  )
}
