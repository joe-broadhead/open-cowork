import { useState } from 'react'
import type { PendingQuestion, SessionError } from '@open-cowork/shared'
import type { PendingApproval, TaskRun } from '../../stores/session'
import type { TimelineItem } from './chat-view-timeline'
import { MessageBubble } from './MessageBubble'
import { ToolTrace } from './ToolTrace'
import { AgentRunPanel } from './AgentRunPanel'
import { CompactionNoticeCard } from './CompactionNoticeCard'
import { ApprovalCard } from './ApprovalCard'
import { agentRunFilterStorageKey } from './agent-run-filter-model'
import { Icon, IconButton } from '@open-cowork/ui'
import { t } from '../../helpers/i18n'

// Error timeline entries are append-only per-session runtime errors with no
// store-level dismiss action and no reference to the user turn that produced
// them, so there is no safe "Retry" to wire here. Instead the card is locally
// dismissible so a transient error is no longer a dead end in the transcript.
function ChatErrorCard({ error }: { error: SessionError }) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  return (
    <div className="chat-error-card">
      <Icon name="alert-circle" size={16} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">{error.message}</span>
      <IconButton
        icon="x"
        size="sm"
        label={t('chat.error.dismiss', 'Dismiss')}
        className="shrink-0 -my-1 -me-1"
        onClick={() => setDismissed(true)}
      />
    </div>
  )
}

type ChatTimelineItemProps = {
  item: TimelineItem
  isGenerating: boolean
  latestAssistantOrder: number
  agentVisuals: Record<string, { avatar: string | null; color: string | null }>
  currentSessionId: string | null
  focusedTaskRunId: string | null
  pendingApprovals: PendingApproval[]
  pendingQuestions: PendingQuestion[]
  handoffAgentBySessionId: Record<string, string>
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
  handoffAgentBySessionId,
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
          handoffAgentBySessionId={handoffAgentBySessionId}
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
          handoffAgentBySessionId={handoffAgentBySessionId}
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
      return <ChatErrorCard error={item.data} />
  }
}
