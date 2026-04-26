import { memo } from 'react'
import type { TaskRun } from '../../stores/session'
import { t } from '../../helpers/i18n'
import { AgentAvatar } from '../agents/AgentAvatar'
import { agentTone } from '../agents/agent-builder-utils'
import type { AgentVisual } from './agent-visuals'
import { ElapsedClock } from './ElapsedClock'
import {
  computeLaneProgress,
  formatAgentName,
  formatCost,
  formatTokensCompact,
  sumTokens,
} from './mission-control-utils'
import { latestTranscriptLine } from './task-timeline-utils'

// A single horizontal swim lane showing one delegated sub-agent task.
// Kept compact so multiple lanes stack cleanly in a parallel-dispatch
// block. Shares the visual grammar of the agent selection cards
// (avatar halo in the agent's tone, status dot, pill chips).

interface Props {
  taskRun: TaskRun
  agentVisual?: AgentVisual | null
  groupMaxElapsedMs: number
  now: number
  indentLevel?: 0 | 1
  expanded?: boolean
  // When this lane has descendants that aren't rendered inline (e.g. a
  // child lane has grandchildren) we show a subtle "↳ N deeper" chip so
  // users aren't surprised when the drill-in drawer reveals more nesting.
  // 0 / undefined means nothing is hidden; the chip doesn't render.
  deeperCount?: number
  onToggle?: () => void
}

function statusDotColor(status: TaskRun['status'], tone: string): string {
  if (status === 'error') return 'var(--color-red)'
  if (status === 'complete') return 'var(--color-green)'
  if (status === 'running') return tone
  return 'var(--color-text-muted)'
}

function statusLabel(status: TaskRun['status']): string {
  switch (status) {
    case 'running': return t('taskStatus.running', 'running')
    case 'complete': return t('taskStatus.done', 'done')
    case 'error': return t('taskStatus.errored', 'errored')
    case 'queued': return t('taskStatus.queued', 'queued')
  }
}

export const MissionControlLane = memo(function MissionControlLane({
  taskRun,
  agentVisual = null,
  groupMaxElapsedMs,
  now,
  indentLevel = 0,
  expanded,
  deeperCount = 0,
  onToggle,
}: Props) {
  const tone = agentTone(agentVisual?.color ?? null)
  const progress = computeLaneProgress(taskRun, groupMaxElapsedMs, now)
  const tokens = sumTokens(taskRun)
  const dotColor = statusDotColor(taskRun.status, tone)
  const isRunning = taskRun.status === 'running'
  const indent = indentLevel * 24
  const liveActivity = isRunning ? latestTranscriptLine(taskRun, 120) : null

  return (
    <div
      className="flex flex-col rounded-lg"
      style={{
        marginLeft: indent,
        background: expanded ? 'color-mix(in srgb, var(--color-elevated) 60%, transparent)' : 'transparent',
        borderLeft: indentLevel > 0 ? `2px solid color-mix(in srgb, ${tone} 30%, transparent)` : undefined,
      }}
    >
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-hover transition-colors cursor-pointer text-start relative"
      style={{
        paddingLeft: indentLevel > 0 ? 10 : undefined,
      }}
      aria-expanded={expanded}
      aria-label={`${formatAgentName(taskRun.agent)} — ${statusLabel(taskRun.status)}`}
    >
      <div
        className="relative shrink-0"
        style={{
          width: 24,
          height: 24,
        }}
      >
        <AgentAvatar
          name={taskRun.agent || taskRun.title}
          color={agentVisual?.color ?? null}
          src={agentVisual?.avatar ?? null}
          size="sm"
        />
      </div>

      <div className="flex items-center gap-1.5 min-w-0 flex-1">
        <span className="text-[12px] font-medium text-text truncate">
          {formatAgentName(taskRun.agent)}
        </span>
        <StatusDot color={dotColor} pulse={isRunning} />
        <span
          className="text-[10px] lowercase"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {statusLabel(taskRun.status)}
        </span>
        {(taskRun.startedAt || isRunning) && (
          <ElapsedClock startedAt={taskRun.startedAt ?? null} finishedAt={taskRun.finishedAt ?? null} />
        )}
        {deeperCount > 0 && (
          <span
            className="inline-flex items-center gap-0.5 text-[10px] text-text-muted"
            title={t('missionControl.deeperTitle', 'This sub-agent dispatched {{count}} further sub-task(s). Click the lane to drill in.', { count: String(deeperCount) })}
          >
            <span aria-hidden="true">↳</span>
            <span>{deeperCount} deeper</span>
          </span>
        )}
      </div>

      <ProgressBar progress={progress} tone={tone} running={isRunning} />

      <div className="shrink-0 flex items-center gap-1.5 ms-2">
        {tokens > 0 && (
          <span className="text-[10px] text-text-muted font-mono tabular-nums">
            {formatTokensCompact(tokens)} tok
          </span>
        )}
        {taskRun.sessionCost > 0 && (
          <span className="text-[10px] text-text-muted font-mono tabular-nums">
            {formatCost(taskRun.sessionCost)}
          </span>
        )}
      </div>
    </button>
    {liveActivity && (
      <div
        className="text-[11px] text-text-muted leading-relaxed line-clamp-1 px-3 pb-2 italic"
        style={{
          paddingLeft: indentLevel > 0 ? 10 : 48, // align with the lane text baseline (avatar 24 + gap 10)
        }}
        title={liveActivity}
      >
        {liveActivity}
      </div>
    )}
    </div>
  )
})

function StatusDot({ color, pulse }: { color: string; pulse: boolean }) {
  return (
    <span
      className="shrink-0 inline-block rounded-full"
      style={{
        width: 6,
        height: 6,
        background: color,
        boxShadow: pulse ? `0 0 0 2px color-mix(in srgb, ${color} 30%, transparent)` : undefined,
        animation: pulse ? 'mission-control-pulse 1.4s ease-in-out infinite' : undefined,
      }}
      aria-hidden="true"
    />
  )
}

function ProgressBar({ progress, tone, running }: { progress: number; tone: string; running: boolean }) {
  const width = `${Math.round(progress * 100)}%`
  return (
    <span
      className="shrink-0 inline-block rounded-full overflow-hidden relative"
      style={{
        width: 80,
        height: 4,
        background: 'color-mix(in srgb, var(--color-text-muted) 15%, transparent)',
      }}
      aria-hidden="true"
    >
      <span
        className="absolute top-0 start-0 bottom-0 rounded-full"
        style={{
          width,
          background: running
            ? `linear-gradient(90deg, color-mix(in srgb, ${tone} 40%, transparent), ${tone})`
            : tone,
          transition: 'width 250ms ease-out',
        }}
      />
    </span>
  )
}
