import type { PendingQuestion } from '@open-cowork/shared'
import type { PendingApproval, TaskRun } from '../../stores/session'
import type { TimelineItem } from './chat-view-timeline'
import { MessageBubble } from './MessageBubble'
import { ToolTrace } from './ToolTrace'
import { AgentRunPanel } from './AgentRunPanel'
import { CompactionNoticeCard } from './CompactionNoticeCard'
import { ApprovalCard } from './ApprovalCard'
import { agentRunFilterStorageKey } from './agent-run-filter-model'

type ChatTimelineItemProps = {
  item: TimelineItem
  isGenerating: boolean
  latestAssistantOrder: number
  agentVisuals: Record<string, { avatar: string | null; color: string | null }>
  currentSessionId: string | null
  focusedTaskRunId: string | null
  pendingApprovals: PendingApproval[]
  pendingQuestions: PendingQuestion[]
  agentRunFiltersEnabled: boolean
  onFocusTask: (taskRun: TaskRun, visibleTaskRuns?: TaskRun[]) => void
  isTaskGroupExpanded: (groupedTaskRuns: TaskRun[]) => boolean
  toggleTaskGroupExpanded: (groupedTaskRuns: TaskRun[]) => void
  taskGroupKey: (groupedTaskRuns: TaskRun[]) => string
}

export function ChatTimelineItem({
  item,
  isGenerating,
  latestAssistantOrder,
  agentVisuals,
  currentSessionId,
  focusedTaskRunId,
  pendingApprovals,
  pendingQuestions,
  agentRunFiltersEnabled,
  onFocusTask,
  isTaskGroupExpanded,
  toggleTaskGroupExpanded,
  taskGroupKey,
}: ChatTimelineItemProps) {
  switch (item.kind) {
    case 'message':
      return (
        <MessageBubble
          message={item.data}
          streaming={isGenerating && item.data.role === 'assistant' && item.data.order === latestAssistantOrder}
        />
      )
    case 'tools':
      return <ToolTrace tools={item.data} />
    case 'task':
      return (
        <AgentRunPanel
          taskRuns={[item.data]}
          agentVisuals={agentVisuals}
          expanded={isTaskGroupExpanded([item.data])}
          onToggle={() => toggleTaskGroupExpanded([item.data])}
          focusedTaskId={focusedTaskRunId}
          onFocusTask={onFocusTask}
          pendingApprovals={pendingApprovals}
          pendingQuestions={pendingQuestions}
          scaleEnabled={agentRunFiltersEnabled}
          scaleStorageKey={agentRunFilterStorageKey(currentSessionId, taskGroupKey([item.data]))}
        />
      )
    case 'task_group':
      return (
        <AgentRunPanel
          taskRuns={item.data}
          agentVisuals={agentVisuals}
          expanded={isTaskGroupExpanded(item.data)}
          onToggle={() => toggleTaskGroupExpanded(item.data)}
          focusedTaskId={focusedTaskRunId}
          onFocusTask={onFocusTask}
          pendingApprovals={pendingApprovals}
          pendingQuestions={pendingQuestions}
          scaleEnabled={agentRunFiltersEnabled}
          scaleStorageKey={agentRunFilterStorageKey(currentSessionId, taskGroupKey(item.data))}
        />
      )
    case 'compaction':
      return <CompactionNoticeCard notice={item.data} />
    case 'approval':
      return (
        <div data-approval-id={item.data.id}>
          <ApprovalCard approval={item.data} />
        </div>
      )
    case 'error':
      return (
        <div className="flex items-start gap-2.5 px-4 py-2.5 rounded-lg border text-[12px]" style={{ borderColor: 'color-mix(in srgb, var(--color-red) 30%, var(--color-border))', background: 'color-mix(in srgb, var(--color-red) 5%, transparent)' }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--color-red)" strokeWidth="1.3" strokeLinecap="round" className="shrink-0 mt-0.5">
            <circle cx="7" cy="7" r="5.5" /><line x1="7" y1="4.5" x2="7" y2="7.5" /><circle cx="7" cy="9.5" r="0.5" fill="var(--color-red)" />
          </svg>
          <span style={{ color: 'var(--color-red)' }}>{item.data.message}</span>
        </div>
      )
  }
}
