import { useMemo } from 'react'
import type { TaskRun } from '../../stores/session'
import { TaskRunCard } from './TaskRunCard'

function summarizeStatus(taskRuns: TaskRun[]) {
  const running = taskRuns.filter((task) => task.status === 'running' || task.status === 'queued').length
  const complete = taskRuns.filter((task) => task.status === 'complete').length
  const errored = taskRuns.filter((task) => task.status === 'error').length

  if (running > 0) return `${running} running`
  if (errored > 0) return `${errored} errored`
  if (complete > 0) return `${complete} complete`
  return 'Queued'
}

function uniqueAgents(taskRuns: TaskRun[]) {
  return Array.from(new Set(taskRuns.map((task) => task.agent).filter(Boolean) as string[]))
}

function formatAgentName(name: string) {
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function TaskTeamBlock({
  taskRuns,
  expanded,
  onToggle,
  isTaskExpanded,
  onToggleTask,
}: {
  taskRuns: TaskRun[]
  expanded: boolean
  onToggle: () => void
  isTaskExpanded: (taskRun: TaskRun) => boolean
  onToggleTask: (taskRun: TaskRun) => void
}) {
  const agentNames = useMemo(() => uniqueAgents(taskRuns), [taskRuns])
  const statusSummary = useMemo(() => summarizeStatus(taskRuns), [taskRuns])
  const tokenTotal = useMemo(
    () => taskRuns.reduce((sum, task) => sum + task.sessionTokens.input + task.sessionTokens.output + task.sessionTokens.reasoning, 0),
    [taskRuns],
  )

  return (
    <div className="rounded-2xl border border-border-subtle overflow-hidden bg-surface">
      <button
        onClick={onToggle}
        className="w-full px-4 py-3.5 text-left flex items-start justify-between gap-3 cursor-pointer hover:bg-surface-hover transition-colors"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span
              className="px-2 py-0.5 rounded-md text-[10px] font-medium"
              style={{ color: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' }}
            >
              Team
            </span>
            <span className="text-[12px] font-medium text-text-secondary">
              {taskRuns.length} sub-agents working in parallel
            </span>
            <span className="text-[10px] text-text-muted">{statusSummary}</span>
            {tokenTotal > 0 && (
              <span className="text-[10px] text-text-muted">{Math.round(tokenTotal).toLocaleString()} tokens</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {agentNames.map((agent) => (
              <span
                key={agent}
                className="px-2 py-0.5 rounded-full text-[10px] border border-border-subtle text-text-muted"
                style={{ background: 'color-mix(in srgb, var(--color-base) 88%, var(--color-text) 12%)' }}
              >
                {formatAgentName(agent)}
              </span>
            ))}
          </div>
        </div>

        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          className="text-text-muted shrink-0 mt-1"
          style={{ transform: expanded ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }}
        >
          <polyline points="2.5,3.5 5,6.5 7.5,3.5" />
        </svg>
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-border-subtle">
          <div className="pt-3 grid gap-3">
            {taskRuns.map((taskRun) => (
              <TaskRunCard
                key={taskRun.id}
                taskRun={taskRun}
                expanded={isTaskExpanded(taskRun)}
                onToggle={() => onToggleTask(taskRun)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
