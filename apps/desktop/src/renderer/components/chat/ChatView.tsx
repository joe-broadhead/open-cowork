import { useRef, useEffect } from 'react'
import { useSessionStore, type Message, type ToolCall, type PendingApproval } from '../../stores/session'
import { MessageBubble } from './MessageBubble'
import { ToolTrace } from './ToolTrace'
import { ApprovalCard } from './ApprovalCard'
import { ThinkingIndicator } from './ThinkingIndicator'
import { ChatInput } from './ChatInput'

type TimelineItem =
  | { kind: 'message'; data: Message }
  | { kind: 'tools'; data: ToolCall[] }
  | { kind: 'approval'; data: PendingApproval }
  | { kind: 'error'; data: { id: string; message: string; order: number } }

export function ChatView() {
  const messages = useSessionStore((s) => s.messages)
  const toolCalls = useSessionStore((s) => s.toolCalls)
  const pendingApprovals = useSessionStore((s) => s.pendingApprovals)
  const errors = useSessionStore((s) => s.errors)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const isGenerating = useSessionStore((s) => s.isGenerating)
  const scrollRef = useRef<HTMLDivElement>(null)

  const rawItems: Array<{ kind: 'message'; data: Message; order: number }
    | { kind: 'tool'; data: ToolCall; order: number }
    | { kind: 'approval'; data: PendingApproval; order: number }
    | { kind: 'error'; data: { id: string; message: string; order: number }; order: number }> = [
    ...messages.map((m) => ({ kind: 'message' as const, data: m, order: m.order })),
    ...toolCalls.map((t) => ({ kind: 'tool' as const, data: t, order: t.order })),
    ...pendingApprovals.map((a) => ({ kind: 'approval' as const, data: a, order: a.order })),
    ...errors.map((e) => ({ kind: 'error' as const, data: e, order: e.order })),
  ].sort((a, b) => a.order - b.order)

  // Group consecutive tool calls into traces
  const timeline: TimelineItem[] = []
  let toolGroup: ToolCall[] = []

  for (const item of rawItems) {
    if (item.kind === 'tool') {
      toolGroup.push(item.data)
    } else {
      if (toolGroup.length > 0) {
        timeline.push({ kind: 'tools', data: [...toolGroup] })
        toolGroup = []
      }
      if (item.kind === 'message') {
        timeline.push({ kind: 'message', data: item.data })
      } else if (item.kind === 'approval') {
        timeline.push({ kind: 'approval', data: item.data })
      } else if (item.kind === 'error') {
        timeline.push({ kind: 'error', data: item.data })
      }
    }
  }
  if (toolGroup.length > 0) {
    timeline.push({ kind: 'tools', data: [...toolGroup] })
  }

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length, toolCalls.length, pendingApprovals.length, isGenerating])

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
        <div className="max-w-[720px] mx-auto px-6 py-6 flex flex-col gap-3">
          {timeline.map((item, i) => {
            switch (item.kind) {
              case 'message':
                return <MessageBubble key={item.data.id} message={item.data} />
              case 'tools':
                return <ToolTrace key={`trace-${i}`} tools={item.data} />
              case 'approval':
                return <ApprovalCard key={item.data.id} approval={item.data} />
              case 'error':
                return (
                  <div key={item.data.id} className="flex items-start gap-2.5 px-4 py-2.5 rounded-lg border text-[12px]" style={{ borderColor: 'color-mix(in srgb, var(--color-red) 30%, var(--color-border))', background: 'color-mix(in srgb, var(--color-red) 5%, transparent)' }}>
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--color-red)" strokeWidth="1.3" strokeLinecap="round" className="shrink-0 mt-0.5">
                      <circle cx="7" cy="7" r="5.5" /><line x1="7" y1="4.5" x2="7" y2="7.5" /><circle cx="7" cy="9.5" r="0.5" fill="var(--color-red)" />
                    </svg>
                    <span style={{ color: 'var(--color-red)' }}>{item.data.message}</span>
                  </div>
                )
            }
          })}
          {isGenerating && <ThinkingIndicator />}
        </div>
      </div>
      <ChatInput />
    </div>
  )
}
