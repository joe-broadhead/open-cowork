import { memo, useMemo } from 'react'
import type { TaskRun } from '../../stores/session'
import { TaskRunCard } from './TaskRunCard'
import { ElapsedClock } from './ElapsedClock'
import { MissionControlLane } from './MissionControlLane'
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
} from './mission-control-utils'

// Swim-lane block that renders a group of delegated tasks as a
// compact timeline. Each task is one lane. Nested sub-agent
// delegations render as indented child lanes. Clicking a lane
// toggles the inline TaskRunCard so users can inspect transcript,
// tools, todos, and errors exactly as they could before — the lane
// is an additional affordance layered on top of that view, not a
// replacement for it.

interface Props {
  taskRuns: TaskRun[]
  expanded: boolean
  onToggle: () => void
  isTaskExpanded: (task: TaskRun) => boolean
  onToggleTask: (task: TaskRun) => void
}

export const MissionControl = memo(function MissionControl({
  taskRuns,
  expanded,
  onToggle,
  isTaskExpanded,
  onToggleTask,
}: Props) {
  const tree = useMemo(() => buildOrchestrationTree(taskRuns), [taskRuns])
  const aggregate = useMemo(() => selectAggregateTiming(taskRuns), [taskRuns])
  const maxElapsed = useMemo(() => groupMaxElapsed(taskRuns), [taskRuns])
  const uniqueAgents = useMemo(() => {
    const set = new Set<string>()
    for (const task of taskRuns) {
      if (task.agent) set.add(task.agent)
    }
    return Array.from(set)
  }, [taskRuns])
  const tokenTotal = useMemo(() => groupTokenTotal(taskRuns), [taskRuns])
  const costTotal = useMemo(() => groupCostTotal(taskRuns), [taskRuns])

  const anyRunning = taskRuns.some((task) => task.status === 'running')
  const allComplete = taskRuns.every((task) => task.status === 'complete')
  const anyErrored = taskRuns.some((task) => task.status === 'error')
  const headerLabel = anyRunning
    ? 'Agents working'
    : allComplete
      ? 'Agents complete'
      : anyErrored
        ? 'Agents errored'
        : 'Agents'

  // Summary line. Prefers a human description of the task set over raw
  // counts. If one agent ran multiple tasks we name it (e.g. "3 Research
  // tasks"); if multiple agents took part we say "3 tasks · 2 agents";
  // a lone task just surfaces the agent name.
  const taskSummary = useMemo(() => {
    const total = taskRuns.length
    if (total === 1) {
      return formatAgentName(taskRuns[0].agent)
    }
    if (uniqueAgents.length === 1) {
      return `${total} ${formatAgentName(uniqueAgents[0])} tasks`
    }
    if (uniqueAgents.length > 1) {
      return `${total} tasks · ${uniqueAgents.length} agents`
    }
    return `${total} tasks`
  }, [taskRuns, uniqueAgents])

  // Running-state note only — when everything's settled the header label
  // already carries the semantic, so we drop the count to avoid the
  // "3 complete" redundancy under an "Agents complete" pill.
  const runningStatusNote = anyRunning
    ? summarizeStatus(taskRuns)
    : anyErrored && !allComplete
      ? summarizeStatus(taskRuns)
      : null

  return (
    <section
      className="rounded-xl border bg-surface overflow-hidden"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3.5 py-2.5 hover:bg-surface-hover transition-colors cursor-pointer text-left"
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
        </span>
        <Chevron expanded={expanded} />
      </button>

      {expanded && (
      <div
        className="flex flex-col gap-0.5 px-2 pb-2 pt-1 border-t"
        style={{ borderColor: 'var(--color-border-subtle)' }}
      >
        {tree.map((lane) => (
          <div key={lane.taskRun.id} className="flex flex-col">
            <MissionControlLane
              taskRun={lane.taskRun}
              groupMaxElapsedMs={maxElapsed}
              expanded={isTaskExpanded(lane.taskRun)}
              onToggle={() => onToggleTask(lane.taskRun)}
            />
            {isTaskExpanded(lane.taskRun) && (
              <div className="px-2 pb-2">
                <TaskRunCard
                  taskRun={lane.taskRun}
                  expanded
                  onToggle={() => onToggleTask(lane.taskRun)}
                />
              </div>
            )}
            {lane.children.map((nested) => (
              <div key={nested.id} className="flex flex-col">
                <MissionControlLane
                  taskRun={nested}
                  groupMaxElapsedMs={maxElapsed}
                  indentLevel={1}
                  expanded={isTaskExpanded(nested)}
                  onToggle={() => onToggleTask(nested)}
                />
                {isTaskExpanded(nested) && (
                  <div className="px-2 pb-2" style={{ marginLeft: 24 }}>
                    <TaskRunCard
                      taskRun={nested}
                      expanded
                      onToggle={() => onToggleTask(nested)}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      )}
    </section>
  )
})

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
