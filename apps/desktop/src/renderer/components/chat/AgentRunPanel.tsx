import { memo, useEffect, useMemo, useState } from 'react'
import { resolveTaskRunHandoffAgent, type PendingQuestion } from '@open-cowork/shared'
import type { PendingApproval, TaskRun } from '../../stores/session'
import type { AgentVisual } from './agent-visuals'
import { ElapsedClock } from './ElapsedClock'
import { AgentRunLane } from './AgentRunLane'
import { useLiveNow } from './useLiveNow'
import {
  buildOrchestrationTree,
  formatAgentName,
  formatCost,
  formatTokensCompact,
  groupCostTotal,
  groupMaxElapsed,
  groupTokenTotal,
  selectAggregateTiming,
  summarizeStatus,
} from './agent-run-utils'
import {
  DEFAULT_AGENT_RUN_FILTER_STATE,
  type AgentRunActivityFilter,
  type AgentRunFilterState,
  type AgentRunStatusFilter,
  buildAgentRunFilterSummary,
  buildTaskRunMetrics,
  buildTaskReviewIndex,
  readAgentRunFilterState,
  reviewActivityForTask,
  selectAgentRunVisibleTasks,
  writeAgentRunFilterState,
} from './agent-run-filter-model'

// Swim-lane block that renders delegated OpenCode tasks as a compact
// timeline. Nested sub-agent delegations render as indented child lanes.
// Clicking a lane hands focus to the parent so it can open the drill-in
// drawer with transcript, tools, todos, errors, and task metrics.

interface Props {
  taskRuns: TaskRun[]
  agentVisuals: Record<string, AgentVisual>
  expanded: boolean
  onToggle: () => void
  focusedTaskId: string | null
  onFocusTask: (task: TaskRun, visibleTasks?: TaskRun[]) => void
  pendingApprovals?: PendingApproval[]
  pendingQuestions?: PendingQuestion[]
  handoffAgentBySessionId?: Record<string, string>
  scaleEnabled?: boolean
  scaleStorageKey?: string
}

const statusOptions: Array<{ id: AgentRunStatusFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'errored', label: 'Errored' },
  { id: 'complete', label: 'Complete' },
  { id: 'cancelled', label: 'Cancelled' },
]

const statusOutlineOptions = statusOptions.filter((option): option is { id: Exclude<AgentRunStatusFilter, 'all'>; label: string } => option.id !== 'all')

const activityOptions: Array<{ id: AgentRunActivityFilter; label: string }> = [
  { id: 'all', label: 'All activity' },
  { id: 'needs_review', label: 'Needs review' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'questions', label: 'Questions' },
  { id: 'tools', label: 'Tool activity' },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'errors', label: 'Errors' },
]

export const AgentRunPanel = memo(function AgentRunPanelComponent({
  taskRuns,
  agentVisuals,
  expanded,
  onToggle,
  focusedTaskId,
  onFocusTask,
  pendingApprovals = [],
  pendingQuestions = [],
  handoffAgentBySessionId = {},
  scaleEnabled = false,
  scaleStorageKey,
}: Props) {
  const storageKey = scaleStorageKey || `inline:${taskRuns.map((task) => task.id).join(',')}`
  const [scaleState, setScaleState] = useState<AgentRunFilterState>(() => DEFAULT_AGENT_RUN_FILTER_STATE)

  useEffect(() => {
    if (!scaleEnabled) return
    setScaleState(readAgentRunFilterState(typeof window !== 'undefined' ? window.localStorage : null, storageKey))
  }, [scaleEnabled, storageKey])

  useEffect(() => {
    if (!scaleEnabled) return
    writeAgentRunFilterState(typeof window !== 'undefined' ? window.localStorage : null, storageKey, scaleState)
  }, [scaleEnabled, storageKey, scaleState])

  const reviewIndex = useMemo(
    () => buildTaskReviewIndex(taskRuns, pendingApprovals, pendingQuestions),
    [taskRuns, pendingApprovals, pendingQuestions],
  )
  const visibleTaskRuns = useMemo(
    () => scaleEnabled ? selectAgentRunVisibleTasks(taskRuns, scaleState, reviewIndex) : taskRuns,
    [scaleEnabled, taskRuns, scaleState, reviewIndex],
  )
  const tree = useMemo(() => buildOrchestrationTree(visibleTaskRuns), [visibleTaskRuns])
  const aggregate = useMemo(() => selectAggregateTiming(taskRuns), [taskRuns])
  const anyRunning = taskRuns.some((task) => task.status === 'running')
  const liveNow = useLiveNow(anyRunning)
  const maxElapsed = useMemo(() => groupMaxElapsed(visibleTaskRuns, liveNow), [visibleTaskRuns, liveNow])
  const scaleSummary = useMemo(
    () => buildAgentRunFilterSummary(taskRuns, visibleTaskRuns, reviewIndex, liveNow),
    [taskRuns, visibleTaskRuns, reviewIndex, liveNow],
  )
  const uniqueAgents = useMemo(() => {
    const set = new Set<string>()
    for (const task of taskRuns) {
      if (task.agent) set.add(task.agent)
    }
    return Array.from(set)
  }, [taskRuns])
  const tokenTotal = useMemo(() => groupTokenTotal(taskRuns), [taskRuns])
  const costTotal = useMemo(() => groupCostTotal(taskRuns), [taskRuns])
  const activeFilters = scaleState.statusFilter !== 'all' || scaleState.agentFilter !== 'all' || scaleState.activityFilter !== 'all'
  const focusTask = (taskRun: TaskRun) => {
    if (scaleEnabled) {
      onFocusTask(taskRun, visibleTaskRuns)
      return
    }
    onFocusTask(taskRun)
  }
  const handoffLabelForTask = (taskRun: TaskRun) => {
    const agent = resolveTaskRunHandoffAgent(taskRun, handoffAgentBySessionId)
    return agent ? formatAgentName(agent) : null
  }

  const allComplete = taskRuns.every((task) => task.status === 'complete')
  const anyErrored = taskRuns.some((task) => task.status === 'error')
  const headerLabel = anyRunning
    ? 'Coworkers working'
    : allComplete
      ? 'Coworkers complete'
      : anyErrored
        ? 'Coworkers need review'
        : 'Coworkers'

  // Summary line. Prefers a human description of the task set over raw
  // counts — for a short coworker roster we name the agents explicitly, so
  // "1 Research + 1 Explore" reads as "2 tasks · Research, Explore"
  // instead of a lossy "2 tasks · 2 coworkers". Falls back to a count-only
  // summary when the roster gets long (4+).
  const AGENT_ROSTER_THRESHOLD = 3
  const taskSummary = useMemo(() => {
    const total = taskRuns.length
    if (total === 1) {
      return formatAgentName(taskRuns[0]!.agent)
    }
    if (uniqueAgents.length === 1) {
      return `${total} ${formatAgentName(uniqueAgents[0])} tasks`
    }
    if (uniqueAgents.length >= 2 && uniqueAgents.length <= AGENT_ROSTER_THRESHOLD) {
      const names = uniqueAgents.map(formatAgentName).join(', ')
      return `${total} tasks · ${names}`
    }
    if (uniqueAgents.length > AGENT_ROSTER_THRESHOLD) {
      return `${total} tasks · ${uniqueAgents.length} coworkers`
    }
    return `${total} tasks`
  }, [taskRuns, uniqueAgents])

  // Running-state note only — when everything's settled the header label
  // already carries the semantic, so we drop the count to avoid the
  // "3 complete" redundancy under a "Coworkers complete" pill.
  const runningStatusNote = anyRunning
    ? summarizeStatus(taskRuns)
    : anyErrored && !allComplete
      ? summarizeStatus(taskRuns)
      : null

  return (
    <section
      className="rounded-xl border bg-surface overflow-hidden"
      style={{
        // Coworker delegation lane (prototype .lane-card): a tone-colored left bar that
        // turns accent + gains a soft glow ring while the lane is live/running.
        borderColor: 'var(--color-border-subtle)',
        borderInlineStartWidth: '3px',
        borderInlineStartColor: anyRunning
          ? 'color-mix(in srgb, var(--color-accent) 55%, transparent)'
          : allComplete
            ? 'color-mix(in srgb, var(--color-green) 45%, var(--color-border-subtle))'
            : anyErrored
              ? 'color-mix(in srgb, var(--color-red) 45%, var(--color-border-subtle))'
              : 'color-mix(in srgb, var(--color-accent) 38%, var(--color-border-subtle))',
        boxShadow: anyRunning
          ? '0 0 0 1px color-mix(in srgb, var(--color-accent) 22%, transparent), var(--shadow-1)'
          : 'var(--shadow-1), var(--specular)',
      }}
      data-agent-run-task-ids={taskRuns.map((task) => task.id).join(' ')}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3.5 py-2.5 hover:bg-surface-hover transition-colors cursor-pointer text-start"
        aria-expanded={expanded}
      >
        <span
          className="text-[10px] uppercase tracking-[0.08em] font-semibold px-1.5 py-0.5 rounded shrink-0"
          style={{
            color: anyRunning
              ? 'var(--color-accent)'
              : allComplete
                ? 'var(--color-green)'
                : anyErrored
                  ? 'var(--color-red)'
                  : 'var(--color-text-secondary)',
            background: anyRunning
              ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)'
              : allComplete
                ? 'color-mix(in srgb, var(--color-green) 12%, transparent)'
                : anyErrored
                  ? 'color-mix(in srgb, var(--color-red) 12%, transparent)'
                  : 'color-mix(in srgb, var(--color-text-muted) 10%, transparent)',
          }}
        >
          {headerLabel}
        </span>
        <span className="text-[12px] text-text-secondary flex-1 min-w-0 flex items-center gap-1.5 flex-wrap">
          {anyRunning ? (
            <span
              className="inline-block h-1.5 w-1.5 rounded-full shrink-0"
              style={{ background: 'var(--color-accent)', animation: 'ui-status-pulse 1.7s var(--ease-out) infinite' }}
              aria-hidden="true"
            />
          ) : null}
          <span>{taskSummary}</span>
          {runningStatusNote && (
            <>
              <span className="text-text-muted">·</span>
              <span className="text-text-muted">{runningStatusNote}</span>
            </>
          )}
          {(aggregate.startedAt || aggregate.finishedAt) && (
            <>
              <span className="text-text-muted">·</span>
              <ElapsedClock startedAt={aggregate.startedAt} finishedAt={aggregate.finishedAt} />
            </>
          )}
          {tokenTotal > 0 && (
            <>
              <span className="text-text-muted">·</span>
              <span className="text-text-muted font-mono tabular-nums">
                {formatTokensCompact(tokenTotal)} tok
              </span>
            </>
          )}
          {costTotal > 0 && (
            <>
              <span className="text-text-muted">·</span>
              <span className="text-text-muted font-mono tabular-nums">
                {formatCost(costTotal)}
              </span>
            </>
          )}
          {scaleEnabled && activeFilters && (
            <>
              <span className="text-text-muted">·</span>
              <span className="text-text-muted">{scaleSummary.filtered}/{scaleSummary.total} shown</span>
            </>
          )}
        </span>
        <Chevron expanded={expanded} />
      </button>

      {expanded && (
      <div
        className="flex flex-col gap-0.5 px-2 pb-2 pt-1 border-t"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        {scaleEnabled && (
          <AgentRunFilterControls
            state={scaleState}
            summary={scaleSummary}
            onChange={setScaleState}
            onReset={() => setScaleState(DEFAULT_AGENT_RUN_FILTER_STATE)}
          />
        )}
        {scaleEnabled && visibleTaskRuns.length === 0 ? (
          <div className="rounded-lg border border-border-subtle bg-elevated px-3 py-4 text-center text-[12px] text-text-muted">
            No delegated tasks match the current task filters.
          </div>
        ) : null}
        {tree.map((lane) => (
          <div key={lane.taskRun.id} className="flex flex-col">
            <AgentRunLane
              taskRun={lane.taskRun}
              agentVisual={lane.taskRun.agent ? (agentVisuals[lane.taskRun.agent] || null) : null}
              groupMaxElapsedMs={maxElapsed}
              now={liveNow}
              expanded={focusedTaskId === lane.taskRun.id}
              handoffLabel={handoffLabelForTask(lane.taskRun)}
              metrics={scaleEnabled ? scaleSummaryForTask(lane.taskRun, reviewIndex, liveNow) : undefined}
              onToggle={() => focusTask(lane.taskRun)}
            />
            {lane.children.map((nested) => (
              <AgentRunLane
                key={nested.taskRun.id}
                taskRun={nested.taskRun}
                agentVisual={nested.taskRun.agent ? (agentVisuals[nested.taskRun.agent] || null) : null}
                groupMaxElapsedMs={maxElapsed}
                now={liveNow}
                indentLevel={1}
                expanded={focusedTaskId === nested.taskRun.id}
                deeperCount={nested.deeperCount}
                handoffLabel={handoffLabelForTask(nested.taskRun)}
                metrics={scaleEnabled ? scaleSummaryForTask(nested.taskRun, reviewIndex, liveNow) : undefined}
                onToggle={() => focusTask(nested.taskRun)}
              />
            ))}
          </div>
        ))}
      </div>
      )}
    </section>
  )
})

function scaleSummaryForTask(taskRun: TaskRun, reviewIndex: ReturnType<typeof buildTaskReviewIndex>, now: number) {
  const activity = reviewActivityForTask(reviewIndex, taskRun.id)
  return buildTaskRunMetrics(taskRun, activity, now)
}

function AgentRunFilterControls({
  state,
  summary,
  onChange,
  onReset,
}: {
  state: AgentRunFilterState
  summary: ReturnType<typeof buildAgentRunFilterSummary>
  onChange: (next: AgentRunFilterState | ((current: AgentRunFilterState) => AgentRunFilterState)) => void
  onReset: () => void
}) {
  const hasFilters = state.statusFilter !== 'all' || state.agentFilter !== 'all' || state.activityFilter !== 'all'
  const update = (patch: Partial<AgentRunFilterState>) => {
    onChange((current) => ({ ...current, ...patch }))
  }

  return (
    <div className="mb-2 rounded-lg border border-border-subtle bg-elevated px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {statusOutlineOptions.map((option) => {
            const active = state.statusFilter === option.id
            const count = summary.statuses[option.id]
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => update({ statusFilter: active ? 'all' : option.id })}
                className="rounded-md border px-2 py-1 text-[10px] font-medium transition-colors hover:bg-surface-hover"
                style={{
                  color: active ? 'var(--color-accent)' : 'var(--color-text-muted)',
                  borderColor: active ? 'color-mix(in srgb, var(--color-accent) 45%, transparent)' : 'var(--color-border-subtle)',
                  background: active ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)' : 'transparent',
                }}
              >
                {option.label} {count}
              </button>
            )
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] text-text-muted">
            Status
            <select
              value={state.statusFilter}
              onChange={(event) => update({ statusFilter: event.target.value as AgentRunStatusFilter })}
              className="rounded-md border border-border-subtle bg-surface px-2 py-1 text-[11px] normal-case tracking-normal text-text-secondary"
            >
              {statusOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] text-text-muted">
            Coworker
            <select
              value={state.agentFilter}
              onChange={(event) => update({ agentFilter: event.target.value })}
              className="max-w-[160px] rounded-md border border-border-subtle bg-surface px-2 py-1 text-[11px] normal-case tracking-normal text-text-secondary"
            >
              <option value="all">All coworkers</option>
              {summary.agents.map((agent) => (
                <option key={agent.id || 'unassigned'} value={agent.id}>{agent.label} ({agent.count})</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] text-text-muted">
            Activity
            <select
              value={state.activityFilter}
              onChange={(event) => update({ activityFilter: event.target.value as AgentRunActivityFilter })}
              className="rounded-md border border-border-subtle bg-surface px-2 py-1 text-[11px] normal-case tracking-normal text-text-secondary"
            >
              {activityOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          {hasFilters ? (
            <button type="button" onClick={onReset} className="rounded-md border border-border-subtle px-2 py-1 text-[11px] text-text-muted hover:bg-surface-hover hover:text-text">
              Reset
            </button>
          ) : null}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-6 gap-2 max-[860px]:grid-cols-3 max-[560px]:grid-cols-2">
        <ScaleMetric label="Showing" value={`${summary.filtered}/${summary.total}`} />
        <ScaleMetric label="Duration" value={formatDuration(summary.metrics.durationMs)} />
        <ScaleMetric label="Tools" value={String(summary.metrics.toolCount)} />
        <ScaleMetric label="Approvals" value={String(summary.metrics.approvalCount)} />
        <ScaleMetric label="Artifacts" value={String(summary.metrics.artifactCount)} />
        <ScaleMetric label="Last event" value={formatLastEvent(summary.metrics.lastEventAt)} />
      </div>
    </div>
  )
}

function ScaleMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-subtle bg-surface px-2 py-2">
      <div className="text-[9px] uppercase tracking-[0.08em] text-text-muted">{label}</div>
      <div className="mt-1 truncate text-[12px] font-medium text-text-secondary">{value}</div>
    </div>
  )
}

function formatDuration(durationMs: number) {
  if (durationMs <= 0) return '-'
  const seconds = Math.round(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function formatLastEvent(value: string | null) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(date)
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-text-muted"
      style={{
        transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
        transition: 'transform 200ms ease',
      }}
      aria-hidden="true"
    >
      <polyline points="3,4.5 6,7.5 9,4.5" />
    </svg>
  )
}
