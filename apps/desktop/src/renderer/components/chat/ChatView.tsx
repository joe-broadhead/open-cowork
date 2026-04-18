import { useRef, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useSessionStore, type Message, type ToolCall, type PendingApproval, type SessionError, type TaskRun, type CompactionNotice } from '../../stores/session'
import { loadSessionMessages } from '../../helpers/loadSessionMessages'
import { t } from '../../helpers/i18n'
import { MessageBubble } from './MessageBubble'
import { ToolTrace } from './ToolTrace'
import { ApprovalCard } from './ApprovalCard'
import { ThinkingIndicator } from './ThinkingIndicator'
import { ChatInput } from './ChatInput'
import { TaskDrillIn } from './TaskDrillIn'
import { CompactionNoticeCard } from './CompactionNoticeCard'
import { MissionControl } from './MissionControl'
import { SessionInspector } from './SessionInspector'
import { SessionQuestionDock } from './SessionQuestionDock'

// Virtualize when the transcript gets long enough that inline
// rendering starts to bite. Below the threshold we keep the simple
// flex-column map — layout thrash during streaming is worse with
// absolute-positioned virtualizer rows for short chats where every
// message is likely on screen anyway.
const VIRTUALIZE_THRESHOLD = 80

// Conservative row estimate in pixels. Measured rows override this on
// first render via the virtualizer's `measureElement`; the estimate
// just seeds initial scrollbar height.
const CHAT_ROW_ESTIMATE_PX = 140

type TimelineItem =
  | { kind: 'message'; data: Message }
  | { kind: 'tools'; data: ToolCall[] }
  | { kind: 'task'; data: TaskRun }
  | { kind: 'task_group'; data: TaskRun[] }
  | { kind: 'compaction'; data: CompactionNotice }
  | { kind: 'approval'; data: PendingApproval }
  | { kind: 'error'; data: SessionError }

export function ChatView({ brandName }: { brandName: string }) {
  const currentView = useSessionStore((s) => s.currentView)
  const globalErrors = useSessionStore((s) => s.globalErrors)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const addGlobalError = useSessionStore((s) => s.addGlobalError)
  const [unrevertingSessionId, setUnrevertingSessionId] = useState<string | null>(null)
  const messages = currentView.messages
  const toolCalls = currentView.toolCalls
  const taskRuns = currentView.taskRuns
  const compactions = currentView.compactions
  const pendingApprovals = currentView.pendingApprovals
  const pendingQuestions = currentView.pendingQuestions
  const isGenerating = currentView.isGenerating
  const scrollRef = useRef<HTMLDivElement>(null)
  const [focusedTaskRunId, setFocusedTaskRunId] = useState<string | null>(null)
  const [expandedTaskGroups, setExpandedTaskGroups] = useState<Record<string, boolean>>({})
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const visibleApprovals = pendingApprovals
  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId) || null,
    [sessions, currentSessionId],
  )
  const parentSession = useMemo(
    () => currentSession?.parentSessionId
      ? sessions.find((session) => session.id === currentSession.parentSessionId) || null
      : null,
    [sessions, currentSession?.parentSessionId],
  )
  const visibleErrors = useMemo(
    () => [...currentView.errors, ...globalErrors].filter((error) => !error.sessionId || error.sessionId === currentSessionId),
    [currentView.errors, globalErrors, currentSessionId],
  )
  const latestAssistantOrder = useMemo(
    () => messages.reduce((max, message) => message.role === 'assistant' ? Math.max(max, message.order) : max, 0),
    [messages],
  )

  const timeline = useMemo(() => {
    const rawItems: Array<
      { kind: 'message'; data: Message; order: number }
      | { kind: 'tool'; data: ToolCall; order: number }
      | { kind: 'task'; data: TaskRun; order: number }
      | { kind: 'compaction'; data: CompactionNotice; order: number }
      | { kind: 'approval'; data: PendingApproval; order: number }
      | { kind: 'error'; data: SessionError; order: number }
    > = [
      ...messages.map((m) => ({ kind: 'message' as const, data: m, order: m.order })),
      ...toolCalls.map((tc) => ({ kind: 'tool' as const, data: tc, order: tc.order })),
      ...taskRuns.map((tr) => ({ kind: 'task' as const, data: tr, order: tr.order })),
      ...compactions.map((c) => ({ kind: 'compaction' as const, data: c, order: c.order })),
      ...visibleApprovals.map((a) => ({ kind: 'approval' as const, data: a, order: a.order })),
      ...visibleErrors.map((e) => ({ kind: 'error' as const, data: e, order: e.order })),
    ].sort((a, b) => a.order - b.order)

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

  // Track whether the user is pinned to the bottom of the transcript. When
  // they scroll up to re-read something, we stop slamming the view back to
  // the bottom on every streamed patch — the previous behaviour was the
  // main source of the "jittery" feel during fast tool-call bursts (e.g.
  // chart generation). As soon as the user scrolls back near the bottom
  // (within 80 px) we re-enable the auto-follow.
  const AUTO_FOLLOW_PX = 80
  const isAutoFollowing = useRef(true)

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return undefined
    const handler = () => {
      const distanceFromBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
      isAutoFollowing.current = distanceFromBottom <= AUTO_FOLLOW_PX
    }
    scroller.addEventListener('scroll', handler, { passive: true })
    return () => scroller.removeEventListener('scroll', handler)
  }, [])

  const virtualize = timeline.length > VIRTUALIZE_THRESHOLD
  const virtualizer = useVirtualizer({
    count: virtualize ? timeline.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CHAT_ROW_ESTIMATE_PX,
    overscan: 6,
    // Stable key across re-renders so a streaming patch doesn't remount
    // the row. Matches the keys used in the non-virtualized path.
    getItemKey: (index) => {
      const item = timeline[index]
      if (!item) return index
      switch (item.kind) {
        case 'message': return `msg:${item.data.id}`
        case 'tools': return `tools:${item.data[0]?.id || index}`
        case 'task': return `task:${item.data.id}`
        case 'task_group': return `task-group:${item.data[0]?.id || index}`
        case 'compaction': return `compaction:${item.data.id}`
        case 'approval': return `approval:${item.data.id}`
        case 'error': return `error:${item.data.id}`
        default: return index
      }
    },
  })

  // `useVirtualizer` returns a fresh object on every render, so we MUST NOT
  // put `virtualizer` in the dep array: the effect would re-fire every
  // render, call `scrollToIndex`, which triggers another render, and we'd
  // get a scroll-thrashing loop. Stash it in a ref so the effect reads the
  // current instance without tracking identity.
  const virtualizerRef = useRef(virtualizer)
  virtualizerRef.current = virtualizer

  useEffect(() => {
    if (!isAutoFollowing.current) return
    if (virtualize) {
      const last = timeline.length - 1
      if (last >= 0) virtualizerRef.current.scrollToIndex(last, { align: 'end' })
      return
    }
    const scroller = scrollRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [
    messages.length,
    toolCalls.length,
    taskRuns.length,
    compactions.length,
    visibleApprovals.length,
    visibleErrors.length,
    isGenerating,
    virtualize,
    timeline.length,
  ])

  useEffect(() => {
    setFocusedTaskRunId(null)
    setExpandedTaskGroups({})
  }, [currentSessionId])

  useEffect(() => {
    setInspectorOpen(true)
  }, [currentSessionId])

  const onFocusTask = (taskRun: TaskRun) => {
    setFocusedTaskRunId(taskRun.id)
  }
  const onCloseFocusedTask = () => setFocusedTaskRunId(null)
  const focusedTaskRun = useMemo(
    () => (focusedTaskRunId ? taskRuns.find((task) => task.id === focusedTaskRunId) || null : null),
    [taskRuns, focusedTaskRunId],
  )

  // Stable key across siblings being added mid-dispatch. The old
  // "ids.join(':')" flipped every time a new task joined the fan-out, so
  // any user-toggled collapse would reset to the default (expanded) the
  // moment a sub-agent spawned. Keying on the first task's id keeps the
  // user's intent stable.
  const taskGroupKey = (groupedTaskRuns: TaskRun[]) => groupedTaskRuns[0]?.id || ''

  const isTaskGroupExpanded = (groupedTaskRuns: TaskRun[]) => {
    const key = taskGroupKey(groupedTaskRuns)
    // Mission Control lanes are the compact view, so default to expanded.
    // Users can collapse to just the header via the chevron.
    return expandedTaskGroups[key] ?? true
  }

  const renderTimelineItem = (
    item: TimelineItem,
    index: number,
  ): ReactNode => {
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
        return <ToolTrace key={`trace-${item.data[0]?.id || index}`} tools={item.data} />
      case 'task':
        return (
          <MissionControl
            key={item.data.id}
            taskRuns={[item.data]}
            expanded={isTaskGroupExpanded([item.data])}
            onToggle={() => toggleTaskGroupExpanded([item.data])}
            focusedTaskId={focusedTaskRunId}
            onFocusTask={onFocusTask}
          />
        )
      case 'task_group':
        return (
          <MissionControl
            key={`task-group-${item.data[0]?.id || index}`}
            taskRuns={item.data}
            expanded={isTaskGroupExpanded(item.data)}
            onToggle={() => toggleTaskGroupExpanded(item.data)}
            focusedTaskId={focusedTaskRunId}
            onFocusTask={onFocusTask}
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
  }

  const toggleTaskGroupExpanded = (groupedTaskRuns: TaskRun[]) => {
    const key = taskGroupKey(groupedTaskRuns)
    setExpandedTaskGroups((current) => ({
      ...current,
      [key]: !(current[key] ?? true),
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
      try {
        const session = await window.coworkApi.session.create()
        const store = useSessionStore.getState()
        store.addSession(session)
        store.setCurrentSession(session.id)
        await window.coworkApi.session.activate(session.id)
        await window.coworkApi.session.prompt(session.id, text, undefined, 'build')
      } catch (err) {
        console.error('Quick start failed:', err)
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
            <div className="text-[13px] text-text-muted">A configurable OpenCode desktop shell for tools, skills, MCPs, and agents</div>
          </div>
          <div className="grid grid-cols-2 gap-2.5 w-full">
            {suggestions.map((s, i) => (
              <button key={i} onClick={() => handleQuickStart(s.text)}
                className="flex items-center gap-2.5 px-3.5 py-3 rounded-xl border border-border-subtle bg-surface hover:bg-surface-hover text-start transition-colors cursor-pointer">
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
    <div className="flex-1 flex min-h-0">
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="shrink-0 border-b border-border-subtle px-4 py-2 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-text truncate">
              {currentSession?.title || `Thread ${currentSessionId.slice(0, 8)}`}
            </div>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {currentSession?.directory && (
                <span className="text-[11px] text-text-muted truncate">
                  {currentSession.directory}
                </span>
              )}
              {currentSession?.parentSessionId && (
                <button
                  type="button"
                  onClick={() => {
                    if (currentSession.parentSessionId) {
                      void loadSessionMessages(currentSession.parentSessionId)
                    }
                  }}
                  title={parentSession
                    ? `Jump to parent: ${parentSession.title || parentSession.id}`
                    : 'Jump to parent thread'}
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border border-border-subtle text-text-muted hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
                >
                  <span>⑂</span>
                  <span>Forked from {parentSession?.title ? parentSession.title : 'thread'}</span>
                </button>
              )}
              {currentSession?.changeSummary && currentSession.changeSummary.files > 0 && (
                <span
                  title={`${currentSession.changeSummary.files} file${currentSession.changeSummary.files === 1 ? '' : 's'} changed`}
                  className="inline-flex items-center gap-1.5 text-[10px] px-1.5 py-0.5 rounded-full border border-border-subtle"
                >
                  <span style={{ color: 'var(--color-green)' }}>+{currentSession.changeSummary.additions}</span>
                  <span style={{ color: 'var(--color-red)' }}>−{currentSession.changeSummary.deletions}</span>
                  <span className="text-text-muted">
                    · {currentSession.changeSummary.files} file{currentSession.changeSummary.files === 1 ? '' : 's'}
                  </span>
                </span>
              )}
              {currentSession?.revertedMessageId && (
                <button
                  type="button"
                  disabled={unrevertingSessionId === currentSessionId}
                  onClick={async () => {
                    if (!currentSessionId) return
                    setUnrevertingSessionId(currentSessionId)
                    try {
                      const ok = await window.coworkApi.session.unrevert(currentSessionId)
                      if (!ok) addGlobalError('Could not unrevert this session. Please try again.')
                    } finally {
                      setUnrevertingSessionId(null)
                    }
                  }}
                  title={t('chat.revertedSessionTitle', 'This session is reverted — click to restore the later messages')}
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-60 disabled:cursor-wait"
                  style={{
                    color: 'var(--color-warning)',
                    background: 'color-mix(in srgb, var(--color-warning) 12%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--color-warning) 40%, transparent)',
                  }}
                >
                  {unrevertingSessionId === currentSessionId ? 'Unreverting…' : 'Reverted · click to unrevert'}
                </button>
              )}
            </div>
          </div>
          <button
            onClick={() => setInspectorOpen((open) => !open)}
            className="shrink-0 px-3 py-1.5 rounded-full text-[12px] font-medium border border-border-subtle text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer"
          >
            {inspectorOpen ? 'Hide Context' : 'Show Context'}
          </button>
        </div>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto"
          role="log"
          aria-live="polite"
          aria-atomic="false"
          aria-label={t('chat.transcriptAriaLabel', 'Chat transcript')}
        >
          {virtualize ? (
            <div
              style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}
            >
              {virtualizer.getVirtualItems().map((vRow) => {
                const item = timeline[vRow.index]
                if (!item) return null
                return (
                  <div
                    key={vRow.key}
                    data-index={vRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vRow.start}px)`,
                    }}
                  >
                    <div className={`mx-auto px-6 ${inspectorOpen ? 'max-w-[820px]' : 'max-w-[900px]'}`}>
                      <div className="py-[5px]">{renderTimelineItem(item, vRow.index)}</div>
                    </div>
                  </div>
                )
              })}
              {isGenerating ? (
                <div className={`mx-auto px-6 py-2 ${inspectorOpen ? 'max-w-[820px]' : 'max-w-[900px]'}`} style={{ transform: `translateY(${virtualizer.getTotalSize()}px)` }}>
                  <ThinkingIndicator />
                </div>
              ) : null}
            </div>
          ) : (
            <div className={`mx-auto px-6 py-4 flex flex-col gap-2.5 ${inspectorOpen ? 'max-w-[820px]' : 'max-w-[900px]'}`}>
              {timeline.map((item, i) => renderTimelineItem(item, i))}
              {isGenerating && <ThinkingIndicator />}
            </div>
          )}
        </div>
        {pendingQuestions[0] && (
          <SessionQuestionDock
            request={pendingQuestions[0]}
            queueCount={pendingQuestions.length}
          />
        )}
        <ChatInput />
      </div>

      {inspectorOpen && <SessionInspector onClose={() => setInspectorOpen(false)} />}
      {focusedTaskRun && (
        <TaskDrillIn
          rootTask={focusedTaskRun}
          allTaskRuns={taskRuns}
          rootSessionId={currentSessionId}
          onClose={onCloseFocusedTask}
        />
      )}
    </div>
  )
}
