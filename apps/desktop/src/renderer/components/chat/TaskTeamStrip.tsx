import { useMemo } from 'react'
import type { TaskRun } from '../../stores/session'

function formatAgentName(name: string | null) {
  if (!name) return 'Sub-Agent'
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function TaskTeamStrip({ taskRuns }: { taskRuns: TaskRun[] }) {
  const activeTaskRuns = useMemo(
    () => taskRuns.filter((task) => task.status === 'running' || task.status === 'queued'),
    [taskRuns],
  )

  if (activeTaskRuns.length < 2) return null

  return (
    <div className="rounded-xl border border-border-subtle bg-surface px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className="px-2 py-0.5 rounded-md text-[10px] font-medium"
          style={{ color: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' }}
        >
          Team
        </span>
        <span className="text-[12px] font-medium text-text-secondary">
          {activeTaskRuns.length} sub-agents are working in parallel
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {activeTaskRuns.map((task) => (
          <div
            key={task.id}
            className="px-2.5 py-1.5 rounded-lg border border-border-subtle bg-elevated min-w-0"
          >
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-accent animate-pulse" />
              <span className="text-[11px] font-medium text-text-secondary">{formatAgentName(task.agent)}</span>
            </div>
            <div className="mt-1 text-[10px] text-text-muted truncate max-w-[220px]">{task.title}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
