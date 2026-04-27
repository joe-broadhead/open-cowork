import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { TaskRun } from '../../stores/session'
import { t } from '../../helpers/i18n'
import { AgentAvatar } from '../agents/AgentAvatar'
import { agentTone } from '../agents/agent-builder-utils'
import type { AgentVisual } from './agent-visuals'
import { ElapsedClock } from './ElapsedClock'
import { ToolTrace } from './ToolTrace'
import { MarkdownContent } from './MarkdownContent'
import { CompactionNoticeCard } from './CompactionNoticeCard'
import { TodoListView } from './TodoListView'
import { MissionControlLane } from './MissionControlLane'
import {
  buildOrchestrationTree,
  formatAgentName,
  formatCost,
  formatTokensCompact,
  groupMaxElapsed,
  sumTokens,
} from './mission-control-utils'
import { buildTaskTimeline } from './task-timeline-utils'
import {
  clampTaskDrillInWidth,
  DEFAULT_TASK_DRILL_IN_WIDTH,
  resolveTaskDrillInWidth,
} from './task-drill-in-layout'
import { useLiveNow } from './useLiveNow'

// Slide-over drawer shown when a user clicks a Mission Control lane.
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
  onClose: () => void
}

const TASK_DRILL_IN_LAYOUT_STORAGE_KEY = 'open-cowork.task-drill-in.layout.v1'
const LEGACY_TASK_DRILL_IN_LAYOUT_STORAGE_KEY = 'opencowork.task-drill-in.layout.v1'

function readStoredLayoutPreference(): { customWidth: number } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(TASK_DRILL_IN_LAYOUT_STORAGE_KEY)
      || window.localStorage.getItem(LEGACY_TASK_DRILL_IN_LAYOUT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { customWidth?: number }
    const customWidth = typeof parsed.customWidth === 'number' && Number.isFinite(parsed.customWidth)
      ? parsed.customWidth
      : DEFAULT_TASK_DRILL_IN_WIDTH
    return { customWidth }
  } catch {
    return null
  }
}

function statusIntent(status: TaskRun['status']): string {
  if (status === 'error') return 'var(--color-red)'
  if (status === 'complete') return 'var(--color-green)'
  if (status === 'running') return 'var(--color-accent)'
  return 'var(--color-text-muted)'
}

function statusLabel(status: TaskRun['status']): string {
  if (status === 'running') return 'Running'
  if (status === 'complete') return 'Complete'
  if (status === 'error') return 'Error'
  return 'Queued'
}

function formatSessionId(id: string | null | undefined) {
  if (!id) return null
  if (id.length <= 14) return id
  return `${id.slice(0, 8)}…${id.slice(-6)}`
}

export const TaskDrillIn = memo(function TaskDrillIn({
  rootTask,
  allTaskRuns,
  agentVisuals,
  rootSessionId,
  onClose,
}: Props) {
  const storedLayout = useMemo(() => readStoredLayoutPreference(), [])
  const [abortInFlight, setAbortInFlight] = useState(false)
  // Focus history stack. Entry 0 is the root; pushing a nested task navigates
  // deeper, popping (via back) returns to the parent.
  const [focusStack, setFocusStack] = useState<string[]>([rootTask.id])
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
  const [customWidth, setCustomWidth] = useState(storedLayout?.customWidth || DEFAULT_TASK_DRILL_IN_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null)

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

  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    setCustomWidth((current) => clampTaskDrillInWidth(current, viewportWidth))
  }, [viewportWidth])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(TASK_DRILL_IN_LAYOUT_STORAGE_KEY, JSON.stringify({
        customWidth,
      }))
      window.localStorage.removeItem(LEGACY_TASK_DRILL_IN_LAYOUT_STORAGE_KEY)
    } catch {
      /* localStorage unavailable — non-fatal */
    }
  }, [customWidth])

  useEffect(() => {
    if (!isResizing) return

    const handlePointerMove = (event: PointerEvent) => {
      const current = resizeStateRef.current
      if (!current) return
      const nextWidth = clampTaskDrillInWidth(
        current.startWidth + (current.startX - event.clientX),
        viewportWidth,
      )
      setCustomWidth(nextWidth)
    }

    const finishResize = () => {
      resizeStateRef.current = null
      setIsResizing(false)
    }

    const previousUserSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishResize)

    return () => {
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishResize)
    }
  }, [isResizing, viewportWidth])

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
      console.error('Failed to abort task:', err)
    } finally {
      setAbortInFlight(false)
    }
  }, [rootSessionId, focused.sourceSessionId])

  const canAbort = Boolean(
    rootSessionId && focused.sourceSessionId && (focused.status === 'running' || focused.status === 'queued'),
  )
  const drawerWidth = useMemo(() => resolveTaskDrillInWidth({
    customWidth,
    viewportWidth,
  }), [customWidth, viewportWidth])

  const focusedVisual = useMemo(
    () => (focused.agent ? agentVisuals[focused.agent] || null : null),
    [agentVisuals, focused.agent],
  )
  const tone = agentTone(focusedVisual?.color ?? null)
  const tokens = sumTokens(focused)
  const timeline = useMemo(() => buildTaskTimeline(focused), [focused])
  const nestedAnyRunning = nestedChildren.some((task) => task.status === 'running')
  const nestedLiveNow = useLiveNow(nestedAnyRunning)
  const nestedMaxElapsed = useMemo(() => groupMaxElapsed(nestedChildren, nestedLiveNow), [nestedChildren, nestedLiveNow])
  const nestedTree = useMemo(() => buildOrchestrationTree(nestedChildren), [nestedChildren])

  const onStartResize = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    resizeStateRef.current = {
      startX: event.clientX,
      startWidth: drawerWidth,
    }
    setCustomWidth(drawerWidth)
    setIsResizing(true)
    event.preventDefault()
  }, [drawerWidth])

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
          animation: 'mission-control-drawer-in 180ms ease-out both',
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
            <button
              type="button"
              onClick={onPopFocus}
              aria-label={t('taskDrillIn.backToParent', 'Back to parent task')}
              className="shrink-0 inline-flex items-center justify-center rounded-lg border hover:bg-surface-hover transition-colors cursor-pointer"
              style={{
                width: 28,
                height: 28,
                borderColor: 'var(--color-border-subtle)',
                color: 'var(--color-text-secondary)',
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="7,2 3,6 7,10" />
              </svg>
            </button>
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
              <h2 className="text-[15px] font-semibold text-text truncate">
                {formatAgentName(focused.agent)}
              </h2>
              <span
                className="text-[10px] uppercase tracking-[0.08em] font-semibold px-1.5 py-0.5 rounded"
                style={{
                  color: statusIntent(focused.status),
                  background: `color-mix(in srgb, ${statusIntent(focused.status)} 12%, transparent)`,
                }}
              >
                {statusLabel(focused.status)}
              </span>
              <ElapsedClock
                startedAt={focused.startedAt ?? null}
                finishedAt={focused.finishedAt ?? null}
                className="text-[11px] text-text-muted font-mono"
              />
            </div>
            {focused.title && focused.title !== formatAgentName(focused.agent) && (
              <div className="mt-0.5 text-[12px] text-text-secondary line-clamp-2">
                {focused.title}
              </div>
            )}
            {focused.sourceSessionId && (
              <div className="mt-1 text-[10px] text-text-muted font-mono">
                id: {formatSessionId(focused.sourceSessionId)}
              </div>
            )}
          </div>
          <div className="shrink-0 flex items-center gap-1">
            {canAbort && (
              <button
                type="button"
                onClick={onAbortFocused}
                disabled={abortInFlight}
                aria-label={t('taskDrillIn.abortTask', 'Abort this task')}
                title={t('taskDrillIn.abortTaskDescription', 'Abort just this sub-agent; siblings and the primary keep running')}
                className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] font-semibold px-2 py-1 rounded cursor-pointer disabled:opacity-40"
                style={{
                  color: 'var(--color-amber)',
                  background: 'color-mix(in srgb, var(--color-amber) 10%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--color-amber) 28%, transparent)',
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
                  <rect x="2" y="2" width="6" height="6" rx="1" />
                </svg>
                {abortInFlight ? 'Aborting…' : 'Abort'}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label={t('taskDrillIn.closeDrawer', 'Close drawer')}
              className="text-text-muted hover:text-text cursor-pointer leading-none text-[22px] -me-1 -mt-1"
            >
              ×
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <Scorecard taskRun={focused} tokens={tokens} />

          {nestedTree.length > 0 && (
            <section className="px-5 py-4 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
              <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-2">
                Nested sub-agents ({nestedChildren.length})
              </div>
              <div className="flex flex-col gap-0.5 rounded-lg border" style={{ borderColor: 'var(--color-border-subtle)' }}>
                {nestedTree.map((lane) => (
                  <MissionControlLane
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
              </div>
            </section>
          )}

          <section className="px-5 py-4 border-t" style={{ borderColor: 'var(--color-border-subtle)' }}>
            <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-3">
              Transcript
            </div>
            {timeline.length === 0 && !focused.error ? (
              <div className="text-[11px] text-text-muted">
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
                    <div
                      key={item.id}
                      className="rounded-lg border px-3 py-2.5"
                      style={{
                        background: 'color-mix(in srgb, var(--color-base) 90%, var(--color-text) 10%)',
                        borderColor: 'var(--color-border-subtle)',
                      }}
                    >
                      <MarkdownContent
                        text={item.content}
                        className="text-[12px]"
                        streaming={focused.status === 'running'}
                      />
                    </div>
                  )
                })}
              </div>
            )}
            {focused.error && (
              <div className="mt-3 rounded-lg px-3 py-2.5 text-[11px]" style={{
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
              <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-2">
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

function Scorecard({ taskRun, tokens }: { taskRun: TaskRun; tokens: number }) {
  const cells: Array<{ label: string; value: string; tone?: string }> = [
    { label: 'Tokens', value: formatTokensCompact(tokens) || '—' },
    { label: 'Cost', value: formatCost(taskRun.sessionCost) || '$0.00' },
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
          <div
            key={cell.label}
            className="rounded-lg px-2.5 py-2 border"
            style={{
              background: 'var(--color-elevated)',
              borderColor: 'var(--color-border-subtle)',
            }}
          >
            <div className="text-[9px] uppercase tracking-[0.08em] text-text-muted">{cell.label}</div>
            <div
              className="text-[13px] font-medium font-mono tabular-nums mt-0.5"
              style={{ color: cell.tone || 'var(--color-text)' }}
            >
              {cell.value}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
