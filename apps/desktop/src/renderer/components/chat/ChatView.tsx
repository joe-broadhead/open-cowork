import { useRef, useEffect } from 'react'
import { useSessionStore } from '../../stores/session'
import { MessageBubble } from './MessageBubble'
import { ToolCallCard } from './ToolCallCard'
import { ApprovalCard } from './ApprovalCard'
import { ChatInput } from './ChatInput'

type TimelineItem =
  | { kind: 'message'; data: ReturnType<typeof useSessionStore.getState>['messages'][0] }
  | { kind: 'tool'; data: ReturnType<typeof useSessionStore.getState>['toolCalls'][0] }
  | { kind: 'approval'; data: ReturnType<typeof useSessionStore.getState>['pendingApprovals'][0] }

export function ChatView() {
  const messages = useSessionStore((s) => s.messages)
  const toolCalls = useSessionStore((s) => s.toolCalls)
  const pendingApprovals = useSessionStore((s) => s.pendingApprovals)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Build a single timeline sorted by arrival order
  const timeline: TimelineItem[] = [
    ...messages.map((m) => ({ kind: 'message' as const, data: m, order: m.order })),
    ...toolCalls.map((t) => ({ kind: 'tool' as const, data: t, order: t.order })),
    ...pendingApprovals.map((a) => ({ kind: 'approval' as const, data: a, order: a.order })),
  ].sort((a, b) => a.order - b.order)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [timeline.length])

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
          {timeline.map((item) => {
            switch (item.kind) {
              case 'message':
                return <MessageBubble key={item.data.id} message={item.data} />
              case 'tool':
                return <ToolCallCard key={item.data.id} toolCall={item.data} />
              case 'approval':
                return <ApprovalCard key={item.data.id} approval={item.data} />
            }
          })}
        </div>
      </div>
      <ChatInput />
    </div>
  )
}
