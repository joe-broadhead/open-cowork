import { useSessionStore } from '../../stores/session'

const AGENT_LABELS: Record<string, string> = {
  assistant: 'Assistant is coordinating',
  cowork: 'Assistant is coordinating',
  plan: 'Planning',
  research: 'Research is investigating',
  explore: 'Explore is working',
}

export function ThinkingIndicator() {
  const activeAgent = useSessionStore((s) => s.activeAgent)
  const todos = useSessionStore((s) => s.todos)
  const executionPlan = useSessionStore((s) => s.executionPlan)
  const contextState = useSessionStore((s) => s.contextState)
  const taskRuns = useSessionStore((s) => s.taskRuns)
  const messages = useSessionStore((s) => s.messages)
  const runningTaskCount = taskRuns.filter((task) => task.status === 'running' || task.status === 'queued').length
  const latestTaskOrder = taskRuns.reduce((max, task) => Math.max(max, task.order), 0)
  const latestAssistantOrder = messages.reduce((max, message) => message.role === 'assistant' ? Math.max(max, message.order) : max, 0)
  const isAssistant = activeAgent === 'assistant' || activeAgent === 'cowork'
  const isMergingResults = isAssistant && runningTaskCount === 0 && latestTaskOrder > latestAssistantOrder
  const label = runningTaskCount > 0 && isAssistant
    ? `Assistant is coordinating ${runningTaskCount} sub-agent${runningTaskCount === 1 ? '' : 's'}`
    : isMergingResults
      ? 'Assistant is merging sub-agent results'
      : activeAgent
        ? AGENT_LABELS[activeAgent] || `${activeAgent} is working`
        : 'Thinking'

  const visibleChecklist = executionPlan.length > 0 ? executionPlan : todos
  const hasChecklist = visibleChecklist.length > 0

  return (
    <div className="py-2">
      <span className="thinking-shimmer text-[13px] font-medium">{label}</span>
      {contextState === 'compacting' && (
        <div className="mt-1 text-[11px]" style={{ color: 'var(--color-amber)' }}>
          Compacting conversation to preserve context...
        </div>
      )}
      {hasChecklist && (
        <div className="mt-2 flex flex-col gap-1">
          {visibleChecklist.map((todo, i) => (
            <div key={todo.id || i} className="flex items-center gap-2 text-[11px]">
              <span style={{ color: todo.status === 'completed' ? 'var(--color-green)' : todo.status === 'in_progress' ? 'var(--color-accent)' : 'var(--color-text-muted)' }}>
                {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◉' : '○'}
              </span>
              <span style={{ color: todo.status === 'completed' ? 'var(--color-text-muted)' : 'var(--color-text-secondary)' }}>
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
