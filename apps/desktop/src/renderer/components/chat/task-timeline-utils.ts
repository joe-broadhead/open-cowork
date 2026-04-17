import type { TaskRun } from '../../stores/session'

// Task transcript is a sequence of text segments; a segment has no content
// until the model streams something in. Filter empties and sort by order so
// the UI renders a clean stream.
export function transcriptSegments(taskRun: TaskRun) {
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

// The most recent transcript text as a single line, trimmed for preview use.
// Used by the Mission Control lane to show what an agent is doing *right now*
// — "reading https://…", "extracting…", etc.
export function latestTranscriptLine(taskRun: TaskRun, maxLength = 100): string | null {
  const segments = transcriptSegments(taskRun)
  const latest = segments[segments.length - 1]?.content?.trim()
  if (!latest) return null
  const oneLine = latest.replace(/\s+/g, ' ').trim()
  if (!oneLine) return null
  if (oneLine.length <= maxLength) return oneLine
  return `${oneLine.slice(0, maxLength - 1).trimEnd()}…`
}

export type TaskTimelineItem =
  | { kind: 'text'; id: string; content: string; order: number }
  | { kind: 'compaction'; id: string; notice: TaskRun['compactions'][number]; order: number }
  | { kind: 'tools'; id: string; tools: TaskRun['toolCalls']; order: number }

// Interleave transcript text, tool calls, and compaction notices in order.
// Tool calls emitted back-to-back group into a single ToolTrace block so
// the UI doesn't repeat the trace frame per call.
export function buildTaskTimeline(taskRun: TaskRun): TaskTimelineItem[] {
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

  const flushToolGroup = () => {
    if (toolGroup.length === 0) return
    result.push({
      kind: 'tools',
      id: `tools:${toolGroup[0].id}`,
      tools: [...toolGroup],
      order: toolGroup[0].order,
    })
    toolGroup = []
  }

  for (const item of rawItems) {
    if (item.kind === 'tool') {
      toolGroup.push(item.data)
      continue
    }
    flushToolGroup()
    if (item.kind === 'compaction') {
      result.push(item)
      continue
    }
    result.push(item)
  }

  flushToolGroup()
  return result
}
