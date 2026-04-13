import { useRef, useEffect, useMemo, useState } from 'react'
import { useSessionStore, type Message, type ToolCall, type PendingApproval, type SessionError, type TaskRun, type CompactionNotice } from '../../stores/session'
import { MessageBubble } from './MessageBubble'
import { ToolTrace } from './ToolTrace'
import { ApprovalCard } from './ApprovalCard'
import { ThinkingIndicator } from './ThinkingIndicator'
import { ChatInput } from './ChatInput'
import { TaskRunCard } from './TaskRunCard'
import { CompactionNoticeCard } from './CompactionNoticeCard'
import { TaskTeamBlock } from './TaskTeamBlock'

type TimelineItem =
  | { kind: 'message'; data: Message }
  | { kind: 'tools'; data: ToolCall[] }
  | { kind: 'task'; data: TaskRun }
  | { kind: 'task_group'; data: TaskRun[] }
  | { kind: 'compaction'; data: CompactionNotice }
  | { kind: 'approval'; data: PendingApproval }
  | { kind: 'error'; data: SessionError }

export function ChatView({ brandName }: { brandName: string }) {
  const messages = useSessionStore((s) => s.messages)
  const toolCalls = useSessionStore((s) => s.toolCalls)
  const taskRuns = useSessionStore((s) => s.taskRuns)
  const compactions = useSessionStore((s) => s.compactions)
  const pendingApprovals = useSessionStore((s) => s.pendingApprovals)
  const errors = useSessionStore((s) => s.errors)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const isGenerating = useSessionStore((s) => s.isGenerating)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [expandedTaskRuns, setExpandedTaskRuns] = useState<Record<string, boolean>>({})
  const [expandedTaskGroups, setExpandedTaskGroups] = useState<Record<string, boolean>>({})
  const visibleApprovals = useMemo(
    () => pendingApprovals.filter((approval) => approval.sessionId === currentSessionId),
    [pendingApprovals, currentSessionId],
  )
  const visibleErrors = useMemo(
    () => errors.filter((error) => !error.sessionId || error.sessionId === currentSessionId),
    [errors, currentSessionId],
  )
  const latestAssistantOrder = useMemo(
    () => messages.reduce((max, message) => message.role === 'assistant' ? Math.max(max, message.order) : max, 0),
    [messages],
  )

  const timeline = useMemo(() => {
  const rawItems: Array<{ kind: 'message'; data: Message; order: number }
    | { kind: 'tool'; data: ToolCall; order: number }
    | { kind: 'task'; data: TaskRun; order: number }
    | { kind: 'compaction'; data: CompactionNotice; order: number }
    | { kind: 'approval'; data: PendingApproval; order: number }
    | { kind: 'error'; data: { id: string; message: string; order: number }; order: number }> = [
    ...messages.map((m) => ({ kind: 'message' as const, data: m, order: m.order })),
    ...toolCalls.map((t) => ({ kind: 'tool' as const, data: t, order: t.order })),
    ...taskRuns.map((t) => ({ kind: 'task' as const, data: t, order: t.order })),
    ...compactions.map((c) => ({ kind: 'compaction' as const, data: c, order: c.order })),
    ...visibleApprovals.map((a) => ({ kind: 'approval' as const, data: a, order: a.order })),
    ...visibleErrors.map((e) => ({ kind: 'error' as const, data: e, order: e.order })),
  ].sort((a, b) => a.order - b.order)

  // Group consecutive tool calls into traces
  const result: TimelineItem[] = []
  let toolGroup: ToolCall[] = []
  let taskGroup: TaskRun[] = []

  const flushTaskGroup = () => {
    if (taskGroup.length === 0) return
    if (taskGroup.length === 1) {
      result.push({ kind: 'task', data: taskGroup[0] })
    } else {
      result.push({ kind: 'task_group', data: [...taskGroup] })
    }
    taskGroup = []
  }

  for (const item of rawItems) {
    if (item.kind === 'tool') {
      flushTaskGroup()
      toolGroup.push(item.data)
    } else if (item.kind === 'task') {
      if (toolGroup.length > 0) {
        result.push({ kind: 'tools', data: [...toolGroup] })
        toolGroup = []
      }
      taskGroup.push(item.data)
    } else {
      if (toolGroup.length > 0) {
        result.push({ kind: 'tools', data: [...toolGroup] })
        toolGroup = []
      }
      flushTaskGroup()
      if (item.kind === 'message') {
        result.push({ kind: 'message', data: item.data })
      } else if (item.kind === 'compaction') {
        result.push({ kind: 'compaction', data: item.data })
      } else if (item.kind === 'approval') {
        result.push({ kind: 'approval', data: item.data })
      } else if (item.kind === 'error') {
        result.push({ kind: 'error', data: item.data })
      }
    }
  }
  if (toolGroup.length > 0) {
    result.push({ kind: 'tools', data: [...toolGroup] })
  }
  flushTaskGroup()
  return result
  }, [messages, toolCalls, taskRuns, compactions, visibleApprovals, visibleErrors])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length, toolCalls.length, compactions.length, visibleApprovals.length, visibleErrors.length, isGenerating])

  useEffect(() => {
    setExpandedTaskRuns({})
    setExpandedTaskGroups({})
  }, [currentSessionId])

  const isTaskExpanded = (taskRun: TaskRun) => {
    return expandedTaskRuns[taskRun.id] ?? false
  }

  const toggleTaskExpanded = (taskRun: TaskRun) => {
    setExpandedTaskRuns((current) => ({
      ...current,
      [taskRun.id]: !(current[taskRun.id] ?? false),
    }))
  }

  const taskGroupKey = (taskRuns: TaskRun[]) => taskRuns.map((task) => task.id).join(':')

  const isTaskGroupExpanded = (taskRuns: TaskRun[]) => {
    const key = taskGroupKey(taskRuns)
    return expandedTaskGroups[key] ?? false
  }

  const toggleTaskGroupExpanded = (taskRuns: TaskRun[]) => {
    const key = taskGroupKey(taskRuns)
    setExpandedTaskGroups((current) => ({
      ...current,
      [key]: !(current[key] ?? false),
    }))
  }

  if (!currentSessionId) {
    const suggestions = [
      { icon: '📊', text: 'Analyze last week\'s sales data' },
      { icon: '📝', text: 'Create a project status report' },
      { icon: '📧', text: 'Check my inbox for urgent messages' },
      { icon: '📅', text: 'What\'s on my calendar today?' },
    ]

    const handleQuickStart = async (text: string) => {
      let sessionId: string | null = null
      try {
        const session = await window.openCowork.session.create()
        sessionId = session.id
        const store = useSessionStore.getState()
        store.addSession(session)
        store.setCurrentSession(session.id)
        store.addMessage(session.id, { id: crypto.randomUUID(), role: 'user', content: text })
        store.addBusy(session.id)
        store.setIsGenerating(true)
        await window.openCowork.session.prompt(session.id, text, undefined, 'assistant')
      } catch (err) {
        console.error('Quick start failed:', err)
        const store = useSessionStore.getState()
        if (sessionId) {
          store.removeBusy(sessionId)
        }
        store.setIsGenerating(false)
      }
    }

    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        <div className="flex flex-col items-center gap-6 max-w-md">
          <div className="w-16 h-16 rounded-2xl bg-surface border border-border flex items-center justify-center">
            <span className="text-2xl font-bold text-accent">O</span>
          </div>
          <div className="text-center">
            <div className="text-[18px] font-semibold text-text mb-1.5">Welcome to {brandName}</div>
            <div className="text-[13px] text-text-muted">A configurable OpenCode desktop shell for tools, skills, and sub-agent teams</div>
          </div>
          <div className="grid grid-cols-2 gap-2.5 w-full">
            {suggestions.map((s, i) => (
              <button key={i} onClick={() => handleQuickStart(s.text)}
                className="flex items-center gap-2.5 px-3.5 py-3 rounded-xl border border-border-subtle bg-surface hover:bg-surface-hover text-left transition-colors cursor-pointer">
                <span className="text-[16px]">{s.icon}</span>
                <span className="text-[12px] text-text-secondary leading-snug">{s.text}</span>
              </button>
            ))}
          </div>
          <div className="text-[11px] text-text-muted">
            Press <kbd className="px-1.5 py-0.5 rounded bg-surface-hover text-[10px] font-mono">⌘N</kbd> for a new thread
            or <kbd className="px-1.5 py-0.5 rounded bg-surface-hover text-[10px] font-mono">⌘K</kbd> to search
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="max-w-[900px] mx-auto px-6 py-4 flex flex-col gap-2.5">
          {timeline.map((item, i) => {
            switch (item.kind) {
              case 'message':
                return (
                  <MessageBubble
                    key={item.data.id}
                    message={item.data}
                    streaming={isGenerating && item.data.role === 'assistant' && item.data.order === latestAssistantOrder}
                  />
                )
              case 'tools':
                return <ToolTrace key={`trace-${i}`} tools={item.data} />
              case 'task':
                return (
                  <TaskRunCard
                    key={item.data.id}
                    taskRun={item.data}
                    expanded={isTaskExpanded(item.data)}
                    onToggle={() => toggleTaskExpanded(item.data)}
                  />
                )
              case 'task_group':
                return (
                  <TaskTeamBlock
                    key={`task-group-${item.data.map((task) => task.id).join(':')}`}
                    taskRuns={item.data}
                    expanded={isTaskGroupExpanded(item.data)}
                    onToggle={() => toggleTaskGroupExpanded(item.data)}
                    isTaskExpanded={isTaskExpanded}
                    onToggleTask={toggleTaskExpanded}
                  />
                )
              case 'compaction':
                return <CompactionNoticeCard key={item.data.id} notice={item.data} />
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
