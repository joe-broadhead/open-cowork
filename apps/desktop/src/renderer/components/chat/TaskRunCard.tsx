import { useMemo } from 'react'
import type { TaskRun } from '../../stores/session'
import { ToolTrace, summarizeTools } from './ToolTrace'
import { MarkdownContent } from './MarkdownContent'
import { CompactionNoticeCard } from './CompactionNoticeCard'

function formatAgentName(name: string | null) {
  if (!name) return 'Sub-Agent'
  return name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatSessionId(id: string | null) {
  if (!id) return null
  if (id.length <= 14) return id
  return `${id.slice(0, 8)}…${id.slice(-6)}`
}

function formatCost(cost: number) {
  if (cost <= 0) return '$0.00'
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  return `$${cost.toFixed(2)}`
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${n}`
}

function statusLabel(status: TaskRun['status']) {
  if (status === 'running') return 'Running'
  if (status === 'complete') return 'Complete'
  if (status === 'error') return 'Error'
  return 'Queued'
}

function statusColor(status: TaskRun['status']) {
  if (status === 'running') return 'var(--color-accent)'
  if (status === 'complete') return 'var(--color-green)'
  if (status === 'error') return 'var(--color-red)'
  return 'var(--color-text-muted)'
}

function transcriptSegments(taskRun: TaskRun) {
  const transcript = taskRun.transcript.length > 0
    ? taskRun.transcript
    : taskRun.content
      ? [{ id: `${taskRun.id}:legacy`, content: taskRun.content, order: taskRun.order }]
      : []

  return transcript
    .slice()
    .sort((a, b) => a.order - b.order)
    .filter((segment) => segment.content.trim().length > 0)
}

type TaskTimelineItem =
  | { kind: 'text'; id: string; content: string; order: number }
  | { kind: 'compaction'; id: string; notice: TaskRun['compactions'][number]; order: number }
  | { kind: 'tools'; id: string; tools: TaskRun['toolCalls']; order: number }

function taskTimeline(taskRun: TaskRun) {
  const transcript = transcriptSegments(taskRun).map((segment) => ({
    kind: 'text' as const,
    id: segment.id,
    content: segment.content,
    order: segment.order,
  }))
  const tools = taskRun.toolCalls.map((tool) => ({
    kind: 'tool' as const,
    data: tool,
    order: tool.order,
  }))
  const compactions = taskRun.compactions.map((notice) => ({
    kind: 'compaction' as const,
    id: notice.id,
    notice,
    order: notice.order,
  }))

  const rawItems = [...transcript, ...tools, ...compactions].sort((a, b) => a.order - b.order)
  const result: TaskTimelineItem[] = []
  let toolGroup: TaskRun['toolCalls'] = []

  for (const item of rawItems) {
    if (item.kind === 'tool') {
      toolGroup.push(item.data)
      continue
    }

    if (toolGroup.length > 0) {
      result.push({
        kind: 'tools',
        id: `tools:${toolGroup[0].id}`,
        tools: [...toolGroup],
        order: toolGroup[0].order,
      })
      toolGroup = []
    }

    if (item.kind === 'compaction') {
      result.push(item)
      continue
    }

    result.push(item)
  }

  if (toolGroup.length > 0) {
    result.push({
      kind: 'tools',
      id: `tools:${toolGroup[0].id}`,
      tools: [...toolGroup],
      order: toolGroup[0].order,
    })
  }

  return result
}

export function TaskRunCard({
  taskRun,
  expanded,
  onToggle,
}: {
  taskRun: TaskRun
  expanded: boolean
  onToggle: () => void
}) {
  const usageLabel = useMemo(() => {
    const totalTokens = taskRun.sessionTokens.input + taskRun.sessionTokens.output + taskRun.sessionTokens.reasoning
    if (totalTokens <= 0 && taskRun.sessionCost <= 0) return null
    return `${formatTokens(totalTokens)} tokens ${formatCost(taskRun.sessionCost)}`
  }, [taskRun.sessionCost, taskRun.sessionTokens])
  const timeline = useMemo(() => taskTimeline(taskRun), [taskRun])
  const hasDetails = timeline.length > 0 || taskRun.todos.length > 0 || !!taskRun.error
  const collapsedSummary = useMemo(() => summarizeTools(taskRun.toolCalls), [taskRun.toolCalls])
  const latestCompaction = taskRun.compactions.length > 0 ? taskRun.compactions[taskRun.compactions.length - 1] : null
  return (
    <div className="rounded-xl border border-border-subtle bg-surface overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-4 py-3 text-left flex items-start justify-between gap-3 cursor-pointer hover:bg-surface-hover transition-colors"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="px-2 py-0.5 rounded-full text-[10px] font-medium border"
              style={{
                background: 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
                color: 'var(--color-accent)',
                borderColor: 'color-mix(in srgb, var(--color-accent) 35%, transparent)',
              }}
            >
              {formatAgentName(taskRun.agent)}
            </span>
            <span className="text-[12px] font-medium text-text-secondary">{taskRun.title}</span>
            <span className="text-[10px]" style={{ color: statusColor(taskRun.status) }}>
              {statusLabel(taskRun.status)}
            </span>
            {latestCompaction && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full border"
                style={{
                  color: 'var(--color-amber)',
                  borderColor: 'color-mix(in srgb, var(--color-amber) 35%, transparent)',
                  background: 'color-mix(in srgb, var(--color-amber) 10%, transparent)',
                }}
              >
                {latestCompaction.status === 'compacting' ? 'Compacting' : 'Compacted'}
              </span>
            )}
            {usageLabel && (
              <span className="text-[10px] text-text-muted">{usageLabel}</span>
            )}
          </div>
          {taskRun.sourceSessionId && (
            <div className="mt-1 text-[10px] text-text-muted font-mono">
              id: {formatSessionId(taskRun.sourceSessionId)}
            </div>
          )}
          {!expanded && taskRun.toolCalls.length > 0 && (
            <div className="mt-2 text-[11px] text-text-muted">
              {collapsedSummary}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {taskRun.status === 'running' && (
            <span
              className="inline-block w-3 h-3 border-2 border-t-transparent rounded-full animate-spin"
              style={{ borderColor: 'var(--color-accent)', borderTopColor: 'transparent' }}
            />
          )}
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            className="text-text-muted"
            style={{ transform: expanded ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }}
          >
            <polyline points="2.5,3.5 5,6.5 7.5,3.5" />
          </svg>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 border-t border-border-subtle">
          {timeline.length > 0 ? (
            <div className="pt-3 space-y-2.5">
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
                    <MarkdownContent text={item.content} className="text-[12px]" />
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="pt-3 text-[11px] text-text-muted">
              {taskRun.status === 'running' ? 'Waiting for output...' : 'No transcript captured.'}
            </div>
          )}

          {taskRun.todos.length > 0 && (
            <div className="mt-3 flex flex-col gap-1">
              {taskRun.todos.map((todo, index) => (
                <div key={todo.id || index} className="flex items-center gap-2 text-[11px]">
                  <span style={{ color: todo.status === 'completed' ? 'var(--color-green)' : todo.status === 'in_progress' ? 'var(--color-accent)' : 'var(--color-text-muted)' }}>
                    {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◉' : '○'}
                  </span>
                  <span className="text-text-secondary">{todo.content}</span>
                </div>
              ))}
            </div>
          )}

          {!hasDetails && (
            <div className="pt-3 text-[11px] text-text-muted">No task details available.</div>
          )}

          {taskRun.error && (
            <div className="mt-3 text-[11px]" style={{ color: 'var(--color-red)' }}>
              {taskRun.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
