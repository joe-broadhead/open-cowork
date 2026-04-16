import { useSessionStore } from '../../stores/session'
import { TodoListView } from './TodoListView'

const AGENT_LABELS: Record<string, string> = {
  build: 'Build is coordinating',
  plan: 'Planning',
  general: 'General is working',
  explore: 'Explore is working',
}

export function ThinkingIndicator() {
  const currentView = useSessionStore((s) => s.currentView)
  const activeAgent = currentView.activeAgent
  const todos = currentView.todos
  const executionPlan = currentView.executionPlan
  const contextState = currentView.contextState
  const taskRuns = currentView.taskRuns
  const messages = currentView.messages
  const isAwaitingPermission = currentView.isAwaitingPermission
  const runningTaskCount = taskRuns.filter((task) => task.status === 'running' || task.status === 'queued').length
  const latestTaskOrder = taskRuns.reduce((max, task) => Math.max(max, task.order), 0)
  const latestAssistantOrder = messages.reduce((max, message) => message.role === 'assistant' ? Math.max(max, message.order) : max, 0)
  const isBuild = activeAgent === 'build'
  const isMergingResults = isBuild && runningTaskCount === 0 && latestTaskOrder > latestAssistantOrder
  const label = isAwaitingPermission
    ? 'Awaiting your approval'
    : runningTaskCount > 0 && isBuild
    ? `Build is coordinating ${runningTaskCount} agent${runningTaskCount === 1 ? '' : 's'}`
    : isMergingResults
      ? 'Build is merging agent results'
      : activeAgent
        ? AGENT_LABELS[activeAgent] || `${activeAgent} is working`
        : 'Thinking'

  const hasPlan = executionPlan.length > 0
  const hasTodos = todos.length > 0

  return (
    <div className="py-2">
      <span className="thinking-shimmer text-[13px] font-medium">{label}</span>
      {contextState === 'compacting' && (
        <div className="mt-1 text-[11px]" style={{ color: 'var(--color-amber)' }}>
          Compacting conversation to preserve context...
        </div>
      )}
      {(hasPlan || hasTodos) && (
        <div className="mt-3 flex flex-col gap-3">
          {hasPlan && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-1">
                Agent plan
              </div>
              <TodoListView todos={executionPlan} variant="compact" showPriorityTag={false} />
            </div>
          )}
          {hasTodos && (
            <div>
              <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-1">
                Session todos
              </div>
              <TodoListView todos={todos} variant="compact" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
