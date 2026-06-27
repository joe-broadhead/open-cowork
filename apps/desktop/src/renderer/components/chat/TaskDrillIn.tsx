import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { PendingQuestion } from '@open-cowork/shared'
import { useSessionStore, type PendingApproval, type TaskRun } from '../../stores/session'
import { t } from '../../helpers/i18n'
import { AgentAvatar } from '../agents/AgentAvatar'
import { agentTone } from '../agents/agent-builder-utils'
import type { AgentVisual } from './agent-visuals'
import { ElapsedClock } from './ElapsedClock'
import { ToolTrace } from './ToolTrace'
import { MarkdownContent } from './MarkdownContent'
import { ReasoningDisclosure } from './ReasoningDisclosure'
import { CompactionNoticeCard } from './CompactionNoticeCard'
import { TodoListView } from './TodoListView'
import { AgentRunLane } from './AgentRunLane'
import {
  buildOrchestrationTree,
  formatAgentName,
  formatCost,
  formatTokensCompact,
  groupMaxElapsed,
  sumTokens,
} from './agent-run-utils'
import { buildTaskTimeline } from './task-timeline-utils'
import { useLiveNow } from './useLiveNow'
import { useTaskDrillInLayout } from './useTaskDrillInLayout'
import { listArtifactsForTools } from './session-artifacts'
import { statusLabel } from '../../helpers/status-label'
import { Badge, Button, Card, IconButton, type BadgeTone } from '../ui'

function statusBadgeTone(status: TaskRun['status']): BadgeTone {
  if (status === 'error') return 'danger'
  if (status === 'complete') return 'success'
  if (status === 'running') return 'accent'
  return 'neutral'
}

// Slide-over drawer shown when a user clicks an agent-run lane.
// Superset of the previous TaskRunCard: same transcript / tools / todos /
// errors, plus a scorecard, the originating-session id, and any nested
// sub-agents this task itself spawned. Users can drill into a nested
// sub-agent — the drawer keeps a focus-history stack so a back button
// returns to the original task without closing.

interface Props {
  rootTask: TaskRun
  allTaskRuns: TaskRun[]
  agentVisuals: Record<string, AgentVisual>
  rootSessionId: string | null
  navigationTaskRuns?: TaskRun[]
  pendingApprovals?: PendingApproval[]
  pendingQuestions?: PendingQuestion[]
  onNavigateTask?: (task: TaskRun) => void
  onOpenTaskInTranscript?: (task: TaskRun) => void
  onOpenApproval?: (approval: PendingApproval) => void
  onOpenQuestion?: (question: PendingQuestion) => void
  onClose: () => void
}

function formatSessionId(id: string | null | undefined) {
  if (!id) return null
  if (id.length <= 14) return id
  return `${id.slice(0, 8)}…${id.slice(-6)}`
}

function describeAbortError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function reportTaskAbortError(rootSessionId: string, taskSessionId: string, error: unknown, addGlobalError: (message: string) => void) {
  addGlobalError(t('taskDrillIn.abortFailed', 'Could not abort this task. Please try again.'))
  try {
    window.coworkApi?.diagnostics?.reportRendererError?.({
      message: `Failed to abort task ${taskSessionId} from ${rootSessionId}: ${describeAbortError(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
      view: 'task-drill-in',
    })
  } catch {
    // Diagnostics reporting must never make the abort failure worse.
  }
}

export const TaskDrillIn = memo(function TaskDrillInComponent({
  rootTask,
  allTaskRuns,
  agentVisuals,
  rootSessionId,
  navigationTaskRuns = [],
  pendingApprovals = [],
  pendingQuestions = [],
  onNavigateTask,
  onOpenTaskInTranscript,
  onOpenApproval,
  onOpenQuestion,
  onClose,
}: Props) {
  const [abortInFlight, setAbortInFlight] = useState(false)
  const [artifactRevealInFlight, setArtifactRevealInFlight] = useState(false)
  const addGlobalError = useSessionStore((state) => state.addGlobalError)
  // Focus history stack. Entry 0 is the root; pushing a nested task navigates
  // deeper, popping (via back) returns to the parent.
  const [focusStack, setFocusStack] = useState<string[]>([rootTask.id])
  const { drawerWidth, isResizing, onStartResize } = useTaskDrillInLayout()

  // Reset the stack whenever the drill-in opens to a different root task.
  useEffect(() => {
    setFocusStack([rootTask.id])
  }, [rootTask.id])

  // Close on Escape.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const focusedId = focusStack[focusStack.length - 1]
  const focused = useMemo(
    () => allTaskRuns.find((task) => task.id === focusedId) || rootTask,
    [allTaskRuns, focusedId, rootTask],
  )

  const nestedChildren = useMemo(() => {
    if (!focused.sourceSessionId) return []
    return allTaskRuns.filter(
      (task) => task.parentSessionId === focused.sourceSessionId && task.id !== focused.id,
    )
  }, [allTaskRuns, focused])

  const onPushFocus = useCallback((taskId: string) => {
    setFocusStack((current) => [...current, taskId])
  }, [])

  const onPopFocus = useCallback(() => {
    setFocusStack((current) => (current.length > 1 ? current.slice(0, -1) : current))
  }, [])

  const onAbortFocused = useCallback(async () => {
    if (!rootSessionId || !focused.sourceSessionId) return
    setAbortInFlight(true)
    try {
      await window.coworkApi.session.abortTask(rootSessionId, focused.sourceSessionId)
    } catch (err) {
      reportTaskAbortError(rootSessionId, focused.sourceSessionId, err, addGlobalError)
    } finally {
      setAbortInFlight(false)
    }
  }, [rootSessionId, focused.sourceSessionId, addGlobalError])

  const canAbort = Boolean(
    rootSessionId && focused.sourceSessionId && (focused.status === 'running' || focused.status === 'queued'),
  )
  const focusedVisual = useMemo(
    () => (focused.agent ? agentVisuals[focused.agent] || null : null),
    [agentVisuals, focused.agent],
  )
  const tone = agentTone(focusedVisual?.color ?? null)
  const tokens = sumTokens(focused)
  const timeline = useMemo(() => buildTaskTimeline(focused), [focused])
  const reasoning = focused.reasoning || []
  const nestedAnyRunning = nestedChildren.some((task) => task.status === 'running')
  const nestedLiveNow = useLiveNow(nestedAnyRunning)
  const nestedMaxElapsed = useMemo(() => groupMaxElapsed(nestedChildren, nestedLiveNow), [nestedChildren, nestedLiveNow])
  const nestedTree = useMemo(() => buildOrchestrationTree(nestedChildren), [nestedChildren])
  const navigationIndex = useMemo(
    () => navigationTaskRuns.findIndex((task) => task.id === focused.id),
    [navigationTaskRuns, focused.id],
  )
  const previousTask = navigationIndex > 0 ? navigationTaskRuns[navigationIndex - 1] : null
  const nextTask = navigationIndex >= 0 && navigationIndex < navigationTaskRuns.length - 1
    ? navigationTaskRuns[navigationIndex + 1]
    : null
  const focusedApprovals = useMemo(
    () => pendingApprovals.filter((approval) => approval.taskRunId === focused.id || approval.sessionId === focused.sourceSessionId),
    [pendingApprovals, focused.id, focused.sourceSessionId],
  )
  const focusedQuestions = useMemo(
    () => pendingQuestions.filter((question) => (question.sourceSessionId || question.sessionId) === focused.sourceSessionId),
    [pendingQuestions, focused.sourceSessionId],
  )
  const artifacts = useMemo(
    () => listArtifactsForTools(focused.toolCalls, focused),
    [focused],
  )

  const navigateTo = useCallback((task: TaskRun | null) => {
    if (!task) return
    setFocusStack([task.id])
    onNavigateTask?.(task)
  }, [onNavigateTask])

  const revealFirstArtifact = useCallback(async () => {
    const artifact = artifacts[0]
    if (!rootSessionId || !artifact) return
    setArtifactRevealInFlight(true)
    try {
      await window.coworkApi.artifact.reveal({
        sessionId: rootSessionId,
        filePath: artifact.filePath,
      })
    } catch (error) {
      addGlobalError(t('taskDrillIn.revealArtifactFailed', 'Could not reveal this artifact. Please try again.'))
      try {
        window.coworkApi?.diagnostics?.reportRendererError?.({
          message: `Failed to reveal task artifact ${artifact.filePath}: ${error instanceof Error ? error.message : String(error)}`,
          stack: error instanceof Error ? error.stack : undefined,
          view: 'task-drill-in',
        })
      } catch {
        // Diagnostics are best-effort from this recovery path.
      }
    } finally {
      setArtifactRevealInFlight(false)
    }
  }, [addGlobalError, artifacts, rootSessionId])

  return (
    <>
      <div
        className="no-drag fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.4)' }}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="no-drag fixed top-0 end-0 bottom-0 z-50 flex flex-col motion-reduce:transition-none"
        style={{
          width: drawerWidth,
          maxWidth: '92vw',
          background: 'var(--color-base)',
          borderLeft: '1px solid var(--color-border-subtle)',
          boxShadow: '0 0 40px rgba(0,0,0,0.35)',
          animation: 'task-drill-in-drawer-in 180ms ease-out both',
        }}
        role="dialog"
        aria-label={`${formatAgentName(focused.agent)} drill-in`}
      >
        <button
          type="button"
          aria-label={t('taskDrillIn.resizeDrawer', 'Resize panel')}
          title={t('taskDrillIn.resizeDrawerDescription', 'Drag to resize the panel')}
          onPointerDown={onStartResize}
          className="absolute top-0 bottom-0 -left-2 w-4 cursor-col-resize group"
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-20 bottom-20 left-1/2 -translate-x-1/2 w-[2px] rounded-full transition-opacity"
            style={{
              background: 'color-mix(in srgb, var(--color-accent) 24%, var(--color-border-subtle))',
              opacity: isResizing ? 1 : 0.65,
            }}
          />
        </button>
        <header
          className="flex items-start gap-3 px-5 py-4 border-b shrink-0"
          style={{ borderColor: 'var(--color-border-subtle)' }}
        >
          {focusStack.length > 1 && (
            <IconButton
              icon="chevron-left"
              label={t('taskDrillIn.backToParent', 'Back to parent task')}
              variant="secondary"
              size="sm"
              onClick={onPopFocus}
              className="shrink-0"
            />
          )}
          <div
            className="shrink-0 rounded-2xl"
            style={{
              background: `radial-gradient(circle at 30% 30%, color-mix(in srgb, ${tone} 24%, transparent), transparent 70%)`,
              padding: 4,
            }}
          >
            <AgentAvatar
              name={focused.agent || focused.title}
              color={focusedVisual?.color ?? null}
              src={focusedVisual?.avatar ?? null}
              size="lg"
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="font-display text-role-title text-text truncate">
                {formatAgentName(focused.agent)}
              </h2>
              <Badge tone={statusBadgeTone(focused.status)} className="uppercase tracking-[0.08em] font-semibold">
                {statusLabel(focused.status)}
              </Badge>
              <ElapsedClock
                startedAt={focused.startedAt ?? null}
                finishedAt={focused.finishedAt ?? null}
                className="text-2xs text-text-muted font-mono"
              />
            </div>
            {focused.title && focused.title !== formatAgentName(focused.agent) && (
              <div className="mt-0.5 text-xs text-text-secondary line-clamp-2">
                {focused.title}
              </div>
            )}
            {focused.sourceSessionId && (
              <div className="mt-1 text-2xs text-text-muted font-mono">
                id: {formatSessionId(focused.sourceSessionId)}
              </div>
            )}
          </div>
          <div className="shrink-0 flex items-center gap-1">
            {onOpenTaskInTranscript && (
              <Button
                type="button"
                onClick={() => onOpenTaskInTranscript(focused)}
                variant="secondary"
                size="sm"
                className="uppercase tracking-[0.08em]"
              >
                Source
              </Button>
            )}
            {previousTask && (
              <Button
                type="button"
                onClick={() => navigateTo(previousTask)}
                aria-label={t('taskDrillIn.previousTask', 'Previous task in current filter')}
                variant="secondary"
                size="sm"
                className="uppercase tracking-[0.08em]"
              >
                Prev
              </Button>
            )}
            {nextTask && (
              <Button
                type="button"
                onClick={() => navigateTo(nextTask)}
                aria-label={t('taskDrillIn.nextTask', 'Next task in current filter')}
                variant="secondary"
                size="sm"
                className="uppercase tracking-[0.08em]"
              >
                Next
              </Button>
            )}
            {canAbort && (
              <Button
                type="button"
                onClick={onAbortFocused}
                disabled={abortInFlight}
                loading={abortInFlight}
                aria-label={t('taskDrillIn.abortTask', 'Abort this task')}
                title={t('taskDrillIn.abortTaskDescription', 'Abort just this sub-agent; siblings and the primary keep running')}
                variant="danger"
                size="sm"
                className="uppercase tracking-[0.08em]"
              >
                {abortInFlight ? 'Aborting…' : 'Abort'}
              </Button>
            )}
            <IconButton
              icon="x"
              label={t('taskDrillIn.closeDrawer', 'Close drawer')}
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="-me-1 -mt-1"
            />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <Scorecard
            taskRun={focused}
            tokens={tokens}
            toolCount={focused.toolCalls.length}
            reviewCount={focusedApprovals.length + focusedQuestions.length}
            artifactCount={artifacts.length}
          />

          {(focusedApprovals.length > 0 || focusedQuestions.length > 0 || artifacts.length > 0) && (
            <section className="px-5 pb-4">
              <div className="flex flex-wrap items-center gap-2">
                {focusedApprovals[0] && onOpenApproval ? (
                  <Button
                    type="button"
                    onClick={() => onOpenApproval(focusedApprovals[0]!)}
                    variant="secondary"
                    size="sm"
                  >
                    Open approval ({focusedApprovals.length})
                  </Button>
                ) : null}
                {focusedQuestions[0] && onOpenQuestion ? (
                  <Button
                    type="button"
                    onClick={() => onOpenQuestion(focusedQuestions[0]!)}
                    variant="secondary"
                    size="sm"
                  >
                    Open question ({focusedQuestions.length})
                  </Button>
                ) : null}
                {artifacts[0] && rootSessionId ? (
                  <Button
                    type="button"
                    onClick={() => void revealFirstArtifact()}
                    disabled={artifactRevealInFlight}
                    loading={artifactRevealInFlight}
                    variant="secondary"
                    size="sm"
                  >
                    {artifactRevealInFlight ? 'Revealing...' : `Open artifact (${artifacts.length})`}
                  </Button>
                ) : null}
              </div>
            </section>
          )}

          {nestedTree.length > 0 && (
            <section className="px-5 py-4 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
              <div className="text-2xs uppercase tracking-[0.08em] text-text-muted mb-2">
                Nested sub-agents ({nestedChildren.length})
              </div>
              <Card variant="flat" padding="sm" className="flex flex-col gap-0.5">
                {nestedTree.map((lane) => (
                  <AgentRunLane
                    key={lane.taskRun.id}
                    taskRun={lane.taskRun}
                    agentVisual={lane.taskRun.agent ? (agentVisuals[lane.taskRun.agent] || null) : null}
                    groupMaxElapsedMs={nestedMaxElapsed}
                    now={nestedLiveNow}
                    expanded={false}
                    deeperCount={lane.children.reduce((sum, child) => sum + 1 + child.deeperCount, 0)}
                    onToggle={() => onPushFocus(lane.taskRun.id)}
                  />
                ))}
              </Card>
            </section>
          )}

          <section className="px-5 py-4 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
            <div className="text-2xs uppercase tracking-[0.08em] text-text-muted mb-3">
              Transcript
            </div>
            {reasoning.length > 0 && (
              <div className="mb-3">
                <ReasoningDisclosure
                  segments={reasoning}
                  streaming={focused.status === 'running'}
                  compact
                />
              </div>
            )}
            {timeline.length === 0 && !focused.error ? (
              <div className="text-2xs text-text-muted">
                {focused.status === 'running' ? 'Waiting for output…' : 'No transcript captured.'}
              </div>
            ) : (
              <div className="space-y-2.5">
                {timeline.map((item) => {
                  if (item.kind === 'tools') {
                    return (
                      <div key={item.id}>
                        <ToolTrace tools={item.tools} />
                      </div>
                    )
                  }
                  if (item.kind === 'compaction') {
                    return <CompactionNoticeCard key={item.id} notice={item.notice} />
                  }
                  return (
                    <Card key={item.id} variant="tile" padding="sm">
                      <MarkdownContent
                        text={item.content}
                        className="text-xs"
                        streaming={focused.status === 'running'}
                      />
                    </Card>
                  )
                })}
              </div>
            )}
            {focused.error && (
              <div className="mt-3 rounded-lg px-3 py-2.5 text-2xs" style={{
                color: 'var(--color-red)',
                background: 'color-mix(in srgb, var(--color-red) 8%, transparent)',
                border: '1px solid color-mix(in srgb, var(--color-red) 30%, transparent)',
              }}>
                {focused.error}
              </div>
            )}
          </section>

          {focused.todos.length > 0 && (
            <section className="px-5 py-4 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
              <div className="text-2xs uppercase tracking-[0.08em] text-text-muted mb-2">
                Todos
              </div>
              <TodoListView todos={focused.todos} variant="compact" />
            </section>
          )}
        </div>
      </aside>
    </>
  )
})

function Scorecard({
  taskRun,
  tokens,
  toolCount,
  reviewCount,
  artifactCount,
}: {
  taskRun: TaskRun
  tokens: number
  toolCount: number
  reviewCount: number
  artifactCount: number
}) {
  const cells: Array<{ label: string; value: string; tone?: string }> = [
    { label: 'Duration', value: formatTaskDuration(taskRun) },
    { label: 'Tokens', value: formatTokensCompact(tokens) || '—' },
    { label: 'Cost', value: formatCost(taskRun.sessionCost) || '$0.00' },
    { label: 'Tools', value: String(toolCount) },
    { label: 'Reviews', value: String(reviewCount), tone: reviewCount > 0 ? 'var(--color-amber)' : undefined },
    { label: 'Artifacts', value: String(artifactCount) },
    { label: 'Input', value: formatTokensCompact(taskRun.sessionTokens.input) || '—' },
    { label: 'Output', value: formatTokensCompact(taskRun.sessionTokens.output) || '—' },
    { label: 'Reasoning', value: formatTokensCompact(taskRun.sessionTokens.reasoning) || '—' },
    {
      label: 'Cache',
      value: formatTokensCompact(taskRun.sessionTokens.cacheRead + taskRun.sessionTokens.cacheWrite) || '—',
    },
  ]
  return (
    <section className="px-5 py-4">
      <div className="grid grid-cols-3 gap-2">
        {cells.map((cell) => (
          <Card key={cell.label} variant="tile" padding="sm">
            <div className="text-2xs uppercase tracking-[0.08em] text-text-muted">{cell.label}</div>
            <div
              className="text-sm font-medium font-mono tabular-nums mt-0.5"
              style={{ color: cell.tone || 'var(--color-text)' }}
            >
              {cell.value}
            </div>
          </Card>
        ))}
      </div>
    </section>
  )
}

function formatTaskDuration(taskRun: TaskRun) {
  if (!taskRun.startedAt) return '—'
  const startedAt = new Date(taskRun.startedAt).getTime()
  if (!Number.isFinite(startedAt)) return '—'
  const finishedAt = taskRun.finishedAt ? new Date(taskRun.finishedAt).getTime() : Date.now()
  if (!Number.isFinite(finishedAt)) return '—'
  const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}
