import type { PendingQuestion } from '@open-cowork/shared'
import type { PendingApproval, TaskRun } from '../../stores/session'
import type { TimelineItem } from './chat-view-timeline'
import { MessageBubble } from './MessageBubble'
import { ToolTrace } from './ToolTrace'
import { AgentRunPanel } from './AgentRunPanel'
import { CompactionNoticeCard } from './CompactionNoticeCard'
import { ApprovalCard } from './ApprovalCard'
import { agentRunFilterStorageKey } from './agent-run-filter-model'
import { Icon } from '../ui'

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
  onOpenApprovalSource?: (approval: PendingApproval) => void
  approvalHasSource?: (approval: PendingApproval) => boolean
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
  onOpenApprovalSource,
  approvalHasSource,
}: ChatTimelineItemProps) {
  switch (item.kind) {
    case 'message':
      return (
        <MessageBubble
          message={item.data}
          streaming={isGenerating && item.data.role === 'assistant' && item.data.order === latestAssistantOrder}
          actionsEnabled={item.actionsEnabled}
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
          <ApprovalCard
            approval={item.data}
            queueCount={pendingApprovals.length}
            onOpenSource={approvalHasSource?.(item.data) ? () => onOpenApprovalSource?.(item.data) : undefined}
          />
        </div>
      )
    case 'error':
      return (
        <div className="chat-error-card">
          <Icon name="alert-circle" size={16} className="mt-0.5 shrink-0" />
          <span>{item.data.message}</span>
        </div>
      )
  }
}
