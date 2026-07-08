import { useRef, useEffect, useMemo, useState, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  buildTaskRunAgentBySourceSession,
  resolveConversationTaskContext,
  type CoordinationBoardPayload,
  type PendingQuestion,
} from '@open-cowork/shared'
import type { AppNavigationTarget } from '../../app-types'
import { useSessionStore, type Message, type PendingApproval, type TaskRun } from '../../stores/session'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { switchToSession } from '../../helpers/switchToSession'
import { t } from '../../helpers/i18n'
import { ThinkingIndicator } from './ThinkingIndicator'
import { ChatInput } from './ChatInput'
import { TaskDrillIn } from './TaskDrillIn'
import { SessionInspector } from './SessionInspector'
import { SessionQuestionDock } from './SessionQuestionDock'
import { buildChatTimeline, messageSignature, type TimelineItem } from './chat-view-timeline'
import { useChatAgentVisuals } from './useChatAgentVisuals'
import {
  isAgentRunFiltersEnabled,
} from './agent-run-filter-model'
import { ChatThreadHeader } from './ChatThreadHeader'
import { ChatTimelineItem } from './ChatTimelineItem'
import { Button, WorkbenchLayout } from '../ui'

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
const THREAD_MAX_WIDTH_WITH_INSPECTOR = 820
const THREAD_MAX_WIDTH = 'var(--measure)'

type ChatViewProps = {
  onNavigate?: (target: AppNavigationTarget) => void
}

export function ChatView({ onNavigate }: ChatViewProps = {}) {
  const currentView = useSessionStore((s) => s.currentView)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const activeWorkspaceId = useSessionStore((s) => s.activeWorkspaceId)
  const sessions = useSessionStore((s) => s.sessions)
  const addGlobalError = useSessionStore((s) => s.addGlobalError)
  const [unrevertingSessionId, setUnrevertingSessionId] = useState<string | null>(null)
  const [capturePending, setCapturePending] = useState(false)
  const [capturedSessionId, setCapturedSessionId] = useState<string | null>(null)
  const messages = currentView.messages
  const toolCalls = currentView.toolCalls
  const taskRuns = currentView.taskRuns
  const compactions = currentView.compactions
  const pendingApprovals = currentView.pendingApprovals
  const pendingQuestions = currentView.pendingQuestions
  const isGenerating = currentView.isGenerating
  const scrollRef = useRef<HTMLDivElement>(null)
  const [focusedTaskRunId, setFocusedTaskRunId] = useState<string | null>(null)
  const [focusedTaskContextIds, setFocusedTaskContextIds] = useState<string[]>([])
  const [focusedQuestionId, setFocusedQuestionId] = useState<string | null>(null)
  const [expandedTaskGroups, setExpandedTaskGroups] = useState<Record<string, boolean>>({})
  const [inspectorOpen, setInspectorOpen] = useState(true)
  const [autoFollowPaused, setAutoFollowPaused] = useState(false)
  const [transcriptAnnouncement, setTranscriptAnnouncement] = useState('')
  const announcedAssistantRef = useRef<{ sessionId: string | null; messageId: string | null }>({ sessionId: null, messageId: null })
  const [coordinationBoard, setCoordinationBoard] = useState<CoordinationBoardPayload | null>(null)
  const agentRunFiltersEnabled = useMemo(() => isAgentRunFiltersEnabled(), [])
  const visibleApprovals = pendingApprovals
  const transcriptMaxWidth = inspectorOpen ? THREAD_MAX_WIDTH_WITH_INSPECTOR : THREAD_MAX_WIDTH
  const activeWorkspaceIsLocal = activeWorkspaceId === LOCAL_WORKSPACE_ID
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
    () => currentView.errors.filter((error) => !error.sessionId || error.sessionId === currentSessionId),
    [currentView.errors, currentSessionId],
  )
  const latestAssistantOrder = useMemo(
    () => messages.reduce((max, message) => message.role === 'assistant' ? Math.max(max, message.order) : max, 0),
    [messages],
  )
  const agentVisuals = useChatAgentVisuals(currentSession?.directory)
  const taskContext = useMemo(
    () => resolveConversationTaskContext(coordinationBoard, currentSessionId),
    [coordinationBoard, currentSessionId],
  )
  const handoffAgentBySessionId = useMemo(
    () => buildTaskRunAgentBySourceSession(taskRuns),
    [taskRuns],
  )

  const captureToKnowledge = useCallback(async () => {
    if (!currentSessionId || !currentSession) return
    if (!activeWorkspaceIsLocal) {
      addGlobalError('Capture to knowledge is available in the Local desktop workspace. Use Cloud Web for Cloud Knowledge capture.')
      return
    }
    setCapturePending(true)
    try {
      const snapshot = await window.coworkApi.knowledge.snapshot({ workspaceId: activeWorkspaceId })
      const space = snapshot.spaces.find((candidate) => candidate.role === 'Maintainer' || candidate.role === 'Contributor') || snapshot.spaces[0]
      if (!space) throw new Error('No Knowledge Space is available for capture.')
      const title = currentSession.title || `Chat ${currentSessionId.slice(0, 8)}`
      const transcriptHighlights = messages
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .slice(-6)
        .map((message) => `${message.role}: ${message.content || ''}`.slice(0, 240))
        .filter((line) => line.trim().length > 8)
      await window.coworkApi.knowledge.propose({
        workspaceId: activeWorkspaceId,
        spaceId: space.id,
        pageTitle: `Conversation: ${title}`,
        by: 'you',
        summary: `Capture accepted context from "${title}" for Knowledge review.`,
        add: Math.max(1, transcriptHighlights.length + 2),
        del: 0,
        links: [{
          kind: 'thread',
          label: title,
          targetId: currentSessionId,
        }],
        body: [
          {
            id: 'capture-summary',
            type: 'callout',
            text: `Captured from chat ${currentSessionId}. Review before publishing this as durable knowledge.`,
          },
          {
            id: 'capture-context',
            type: 'h',
            text: 'Conversation context',
          },
          ...(transcriptHighlights.length
            ? [{ id: 'capture-highlights', type: 'list' as const, items: transcriptHighlights }]
            : [{ id: 'capture-placeholder', type: 'p' as const, text: 'No transcript highlights were available yet.' }]),
        ],
      })
      setCapturedSessionId(currentSessionId)
    } catch (error) {
      addGlobalError(error instanceof Error ? error.message : String(error))
    } finally {
      setCapturePending(false)
    }
  }, [activeWorkspaceId, activeWorkspaceIsLocal, addGlobalError, currentSession, currentSessionId, messages])

  // Reflect an already-pending capture for this conversation so navigating away
  // and back doesn't reset the action and let a second proposal be created for
  // the same thread (the button state is otherwise component-local). Only the
  // Local desktop workspace can capture; the proposal records the session id as a
  // 'thread' link targetId, so a pending one for this session means "already proposed".
  useEffect(() => {
    if (!activeWorkspaceIsLocal || !currentSessionId) return
    let disposed = false
    void (async () => {
      try {
        const snapshot = await window.coworkApi.knowledge.snapshot({ workspaceId: activeWorkspaceId })
        const alreadyPending = snapshot.proposals.some(
          (proposal) => proposal.status === 'pending'
            && proposal.links.some((link) => link.targetId === currentSessionId),
        )
        if (!disposed && alreadyPending) setCapturedSessionId(currentSessionId)
      } catch {
        // Best-effort hydration; if the snapshot can't be read the button simply
        // stays actionable.
      }
    })()
    return () => { disposed = true }
  }, [activeWorkspaceId, activeWorkspaceIsLocal, currentSessionId])

  useEffect(() => {
    let disposed = false
    const loadBoard = async () => {
      try {
        const board = await window.coworkApi.coordination.board()
        if (!disposed) setCoordinationBoard(board)
      } catch {
        if (!disposed) setCoordinationBoard(null)
      }
    }
    void loadBoard()
    const unsubscribe = window.coworkApi.on.coordinationUpdated(() => {
      void loadBoard()
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  // Content-keyed identity cache so a derived message keeps the same object
  // reference across rebuilds when its rendered content is unchanged — letting
  // MessageBubble's memo skip its markdown/mermaid render for every message that
  // didn't change on a streamed patch. Pruned to the live key set each pass so it
  // can't outgrow the transcript.
  const messageIdentityCache = useRef<Map<string, { signature: string; message: Message }>>(new Map())
  const timeline = useMemo(() => {
    const cache = messageIdentityCache.current
    const seenKeys = new Set<string>()
    const result = buildChatTimeline({
      messages,
      toolCalls,
      taskRuns,
      compactions,
      approvals: visibleApprovals,
      errors: visibleErrors,
    }, {
      stabilizeMessage: (key, message) => {
        seenKeys.add(key)
        const signature = messageSignature(message)
        const cached = cache.get(key)
        if (cached && cached.signature === signature) return cached.message
        cache.set(key, { signature, message })
        return message
      },
    })
    for (const key of cache.keys()) {
      if (!seenKeys.has(key)) cache.delete(key)
    }
    return result
  }, [messages, toolCalls, taskRuns, compactions, visibleApprovals, visibleErrors])

  // Announce only a genuinely new, settled assistant reply to screen readers
  // through the dedicated polite live region. Opening an existing thread (or each
  // streamed patch) must not replay history: we baseline on the latest message
  // whenever the session changes, then emit once after a new assistant message has
  // finished generating.
  useEffect(() => {
    const latestAssistant = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant' && (message.content ?? '').trim().length > 0)
    if (announcedAssistantRef.current.sessionId !== currentSessionId) {
      announcedAssistantRef.current = { sessionId: currentSessionId, messageId: latestAssistant?.id ?? null }
      setTranscriptAnnouncement('')
      return
    }
    if (isGenerating || !latestAssistant) return
    if (announcedAssistantRef.current.messageId === latestAssistant.id) return
    announcedAssistantRef.current.messageId = latestAssistant.id
    setTranscriptAnnouncement(latestAssistant.content.trim().slice(0, 300))
  }, [messages, isGenerating, currentSessionId])

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
      const following = distanceFromBottom <= AUTO_FOLLOW_PX
      isAutoFollowing.current = following
      setAutoFollowPaused(!following)
    }
    scroller.addEventListener('scroll', handler, { passive: true })
    return () => scroller.removeEventListener('scroll', handler)
  }, [])

  const virtualize = timeline.length > VIRTUALIZE_THRESHOLD
  const virtualizer = useVirtualizer({
    enabled: virtualize,
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
        case 'message': return item.key
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
    setFocusedTaskContextIds([])
    setFocusedQuestionId(null)
    setExpandedTaskGroups({})
    isAutoFollowing.current = true
    setAutoFollowPaused(false)
  }, [currentSessionId])

  useEffect(() => {
    if (!focusedQuestionId) return
    if (pendingQuestions.some((question) => question.id === focusedQuestionId)) return
    setFocusedQuestionId(null)
  }, [focusedQuestionId, pendingQuestions])

  useEffect(() => {
    setInspectorOpen(true)
  }, [currentSessionId])

  const onFocusTask = (taskRun: TaskRun, visibleTaskRuns?: TaskRun[]) => {
    setFocusedTaskRunId(taskRun.id)
    setFocusedTaskContextIds((visibleTaskRuns && visibleTaskRuns.length > 0 ? visibleTaskRuns : taskRuns).map((task) => task.id))
  }
  const onCloseFocusedTask = () => setFocusedTaskRunId(null)
  const focusedTaskRun = useMemo(
    () => (focusedTaskRunId ? taskRuns.find((task) => task.id === focusedTaskRunId) || null : null),
    [taskRuns, focusedTaskRunId],
  )
  const focusedTaskNavigationRuns = useMemo(() => {
    if (focusedTaskContextIds.length === 0) return taskRuns
    const byId = new Map(taskRuns.map((task) => [task.id, task]))
    return focusedTaskContextIds.map((id) => byId.get(id)).filter(Boolean) as TaskRun[]
  }, [focusedTaskContextIds, taskRuns])
  const activePendingQuestion = useMemo(
    () => focusedQuestionId
      ? pendingQuestions.find((question) => question.id === focusedQuestionId) || pendingQuestions[0] || null
      : pendingQuestions[0] || null,
    [focusedQuestionId, pendingQuestions],
  )

  // Stable key across siblings being added mid-dispatch. The old
  // "ids.join(':')" flipped every time a new task joined the fan-out, so
  // any user-toggled collapse would reset to the default (expanded) the
  // moment a sub-agent spawned. Keying on the first task's id keeps the
  // user's intent stable.
  const taskGroupKey = (groupedTaskRuns: TaskRun[]) => groupedTaskRuns[0]?.id || ''

  const scrollTaskRunIntoView = (taskRun: TaskRun) => {
    setFocusedTaskRunId(null)
    const timelineIndex = timeline.findIndex((item) => {
      if (item.kind === 'task') return item.data.id === taskRun.id
      if (item.kind === 'task_group') return item.data.some((task) => task.id === taskRun.id)
      return false
    })

    requestAnimationFrame(() => {
      if (virtualize && timelineIndex >= 0) {
        virtualizerRef.current.scrollToIndex(timelineIndex, { align: 'center' })
        return
      }
      const selector = `[data-task-run-id="${escapeAttributeSelector(taskRun.id)}"], [data-agent-run-task-ids~="${escapeAttributeSelector(taskRun.id)}"]`
      const target = scrollRef.current?.querySelector<HTMLElement>(selector)
      target?.scrollIntoView({ block: 'center', behavior: preferredScrollBehavior() })
    })
  }

  const approvalSourceTask = (approval: PendingApproval) => {
    if (!approval.taskRunId) return null
    return taskRuns.find((task) => task.id === approval.taskRunId) || null
  }

  const approvalHasSource = (approval: PendingApproval) => {
    if (toolCalls.some((tool) => tool.id === approval.id)) return true
    if (taskRuns.some((task) => task.toolCalls.some((tool) => tool.id === approval.id))) return true
    return Boolean(approvalSourceTask(approval))
  }

  const scrollApprovalSourceIntoView = (approval: PendingApproval) => {
    setFocusedTaskRunId(null)
    const toolTimelineIndex = timeline.findIndex((item) => {
      if (item.kind === 'tools') return item.data.some((tool) => tool.id === approval.id)
      if (item.kind === 'task') return item.data.toolCalls.some((tool) => tool.id === approval.id)
      if (item.kind === 'task_group') return item.data.some((task) => task.toolCalls.some((tool) => tool.id === approval.id))
      return false
    })

    requestAnimationFrame(() => {
      const toolTarget = scrollRef.current?.querySelector<HTMLElement>(`[data-tool-call-id="${escapeAttributeSelector(approval.id)}"]`)
      if (toolTarget) {
        toolTarget.scrollIntoView({ block: 'center', behavior: preferredScrollBehavior() })
        return
      }

      if (virtualize && toolTimelineIndex >= 0) {
        virtualizerRef.current.scrollToIndex(toolTimelineIndex, { align: 'center' })
        return
      }

      const task = approvalSourceTask(approval)
      if (task) scrollTaskRunIntoView(task)
    })
  }

  const scrollApprovalIntoView = (approval: PendingApproval) => {
    setFocusedTaskRunId(null)
    const timelineIndex = timeline.findIndex((item) => item.kind === 'approval' && item.data.id === approval.id)
    requestAnimationFrame(() => {
      if (virtualize && timelineIndex >= 0) {
        virtualizerRef.current.scrollToIndex(timelineIndex, { align: 'center' })
        return
      }
      const target = scrollRef.current?.querySelector<HTMLElement>(`[data-approval-id="${escapeAttributeSelector(approval.id)}"]`)
      target?.scrollIntoView({ block: 'center', behavior: preferredScrollBehavior() })
    })
  }

  const openQuestionDock = (question: PendingQuestion) => {
    setFocusedQuestionId(question.id)
    setFocusedTaskRunId(null)
    requestAnimationFrame(() => {
      const scroller = scrollRef.current
      if (!scroller) return
      if (typeof scroller.scrollTo === 'function') {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: preferredScrollBehavior() })
      } else {
        scroller.scrollTop = scroller.scrollHeight
      }
    })
  }

  const scrollToLatest = () => {
    isAutoFollowing.current = true
    setAutoFollowPaused(false)
    const scroller = scrollRef.current

    requestAnimationFrame(() => {
      if (virtualize) {
        const last = timeline.length - 1
        if (last >= 0) virtualizerRef.current.scrollToIndex(last, { align: 'end' })
      }
      const currentScroller = scroller || scrollRef.current
      if (!currentScroller) return
      if (typeof currentScroller.scrollTo === 'function') {
        currentScroller.scrollTo({
          top: currentScroller.scrollHeight,
          behavior: preferredScrollBehavior(),
        })
      } else {
        currentScroller.scrollTop = currentScroller.scrollHeight
      }
    })
  }

  const isTaskGroupExpanded = (groupedTaskRuns: TaskRun[]) => {
    const key = taskGroupKey(groupedTaskRuns)
    // Agent run panels are the compact view, so default to expanded.
    // Users can collapse to just the header via the chevron.
    return expandedTaskGroups[key] ?? true
  }

  const renderTimelineItem = (item: TimelineItem) => {
    return (
      <ChatTimelineItem
        item={item}
        isGenerating={isGenerating}
        latestAssistantOrder={latestAssistantOrder}
        agentVisuals={agentVisuals}
        currentSessionId={currentSessionId}
        focusedTaskRunId={focusedTaskRunId}
        pendingApprovals={pendingApprovals}
        pendingQuestions={pendingQuestions}
        handoffAgentBySessionId={handoffAgentBySessionId}
        agentRunFiltersEnabled={agentRunFiltersEnabled}
        onFocusTask={onFocusTask}
        isTaskGroupExpanded={isTaskGroupExpanded}
        toggleTaskGroupExpanded={toggleTaskGroupExpanded}
        taskGroupKey={taskGroupKey}
        onOpenApprovalSource={scrollApprovalSourceIntoView}
        approvalHasSource={approvalHasSource}
      />
    )
  }

  const toggleTaskGroupExpanded = (groupedTaskRuns: TaskRun[]) => {
    const key = taskGroupKey(groupedTaskRuns)
    setExpandedTaskGroups((current) => ({
      ...current,
      [key]: !(current[key] ?? true),
    }))
  }

  // When the active thread goes away (deleted, reset, or never existed
  // — e.g. the user hits /chat directly) we render nothing. App.tsx
  // watches this and bounces the view back to Home, whose composer is
  // now the single source of truth for "start a new thread."
  if (!currentSessionId) return null

  const conversationPane = (
    <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <ChatThreadHeader
          currentSession={currentSession}
          currentSessionId={currentSessionId}
          parentSession={parentSession}
          inspectorOpen={inspectorOpen}
          unreverting={unrevertingSessionId === currentSessionId}
          taskContext={taskContext}
          onOpenParent={() => {
            if (currentSession?.parentSessionId) {
              void switchToSession(currentSession.parentSessionId)
            }
          }}
          onOpenBoard={taskContext ? () => onNavigate?.('projects') : undefined}
          onCaptureToKnowledge={activeWorkspaceIsLocal ? captureToKnowledge : undefined}
          captureToKnowledgePending={capturePending}
          captureToKnowledgeDone={capturedSessionId === currentSessionId}
          onToggleInspector={() => setInspectorOpen((open) => !open)}
          onUnrevert={() => {
            setUnrevertingSessionId(currentSessionId)
            void window.coworkApi.session.unrevert(currentSessionId)
              .then((ok) => {
                if (!ok) addGlobalError('Could not unrevert this session. Please try again.')
              })
              .catch(() => {
                addGlobalError('Could not unrevert this session. Please try again.')
              })
              .finally(() => setUnrevertingSessionId(null))
          }}
        />

        <div className="relative flex-1 min-h-0">
          {/* Named scroll region — NOT a live region. Virtualization mounts/unmounts
              rows as you scroll, which an aria-live container announced as spurious
              "new content". New messages are announced via the dedicated polite
              region below instead. */}
          <div
            ref={scrollRef}
            className="h-full overflow-y-auto"
            role="region"
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
                    <div className="mx-auto px-6" style={{ maxWidth: transcriptMaxWidth }}>
                      <div className="py-[5px]">{renderTimelineItem(item)}</div>
                    </div>
                  </div>
                )
              })}
              {isGenerating ? (
                <div className="mx-auto px-6 py-2" style={{ maxWidth: transcriptMaxWidth, transform: `translateY(${virtualizer.getTotalSize()}px)` }}>
                  <ThinkingIndicator />
                </div>
              ) : null}
              </div>
            ) : (
              <div className="mx-auto px-6 py-4 flex flex-col gap-2.5" style={{ maxWidth: transcriptMaxWidth }}>
                {timeline.map((item) => (
                  <div key={timelineItemKey(item)}>{renderTimelineItem(item)}</div>
                ))}
                {isGenerating && <ThinkingIndicator />}
              </div>
            )}
          </div>
          {autoFollowPaused ? (
            <div className="chat-jump-latest">
              <Button size="sm" variant="secondary" rightIcon="arrow-down" onClick={scrollToLatest}>
                {t('chat.jumpToLatest', 'Jump to latest')}
              </Button>
            </div>
          ) : null}
          {/* Dedicated polite live region: announces only a genuinely new, settled
              assistant message once — never the whole transcript or scroll churn. */}
          <div className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="chat-transcript-announcer">
            {transcriptAnnouncement}
          </div>
        </div>
        {activePendingQuestion && (
          <SessionQuestionDock
            request={activePendingQuestion}
            queueCount={pendingQuestions.length}
          />
        )}
        <ChatInput />
      </div>
  )

  const reviewPane = inspectorOpen
    ? <SessionInspector onClose={() => setInspectorOpen(false)} />
    : null
  const overlays = focusedTaskRun ? (
        <TaskDrillIn
          rootTask={focusedTaskRun}
          allTaskRuns={taskRuns}
          agentVisuals={agentVisuals}
          rootSessionId={currentSessionId}
          navigationTaskRuns={focusedTaskNavigationRuns}
          pendingApprovals={pendingApprovals}
          pendingQuestions={pendingQuestions}
          onNavigateTask={(taskRun) => onFocusTask(taskRun, focusedTaskNavigationRuns)}
          onOpenTaskInTranscript={scrollTaskRunIntoView}
          onOpenApproval={scrollApprovalIntoView}
          onOpenQuestion={openQuestionDock}
          onClose={onCloseFocusedTask}
        />
  ) : null

  return (
    <WorkbenchLayout
      className="desktop-chat-workbench flex-1 min-h-0"
      mainLabel={t('chat.conversationPane', 'Conversation')}
      reviewLabel={t('chat.reviewPane', 'Review')}
      mainPane={conversationPane}
      reviewPane={reviewPane}
      reviewOpen={inspectorOpen}
      overlays={overlays}
    />
  )
}

function escapeAttributeSelector(value: string) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

function preferredScrollBehavior(): ScrollBehavior {
  const reduce = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  return reduce ? 'auto' : 'smooth'
}

function timelineItemKey(item: TimelineItem) {
  switch (item.kind) {
    case 'message': return item.key
    case 'tools': return `tools:${item.data[0]?.id || 'empty'}`
    case 'task': return `task:${item.data.id}`
    case 'task_group': return `task-group:${item.data[0]?.id || 'empty'}`
    case 'compaction': return `compaction:${item.data.id}`
    case 'approval': return `approval:${item.data.id}`
    case 'error': return `error:${item.data.id}`
  }
}
