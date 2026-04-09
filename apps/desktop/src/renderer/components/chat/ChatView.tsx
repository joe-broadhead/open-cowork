import { useRef, useEffect } from 'react'
import { useSessionStore } from '../../stores/session'
import { MessageBubble } from './MessageBubble'
import { ToolCallCard } from './ToolCallCard'
import { ApprovalCard } from './ApprovalCard'
import { ChatInput } from './ChatInput'

export function ChatView() {
  const messages = useSessionStore((s) => s.messages)
  const toolCalls = useSessionStore((s) => s.toolCalls)
  const pendingApprovals = useSessionStore((s) => s.pendingApprovals)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, toolCalls, pendingApprovals])

  if (!currentSessionId) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="flex flex-col items-center gap-5">
          <div className="w-14 h-14 rounded-2xl bg-surface border border-border flex items-center justify-center text-text-muted">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <div className="text-center">
            <div className="text-[15px] font-medium text-text-secondary mb-1">Welcome to Cowork</div>
            <div className="text-[12px] text-text-muted">Start a new thread to begin</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-[720px] mx-auto px-6 py-6 flex flex-col gap-4">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}
          {toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} />
          ))}
          {pendingApprovals.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </div>
      </div>
      <ChatInput />
    </div>
  )
}
