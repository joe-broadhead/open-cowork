import { useSessionStore } from '../../stores/session'

const AGENT_LABELS: Record<string, string> = {
  analyst: 'Analyst is analyzing',
  cowork: 'Cowork is coordinating',
  plan: 'Planning',
  research: 'Research is investigating',
  explore: 'Explore is working',
  'sheets-builder': 'Sheets Builder is working',
  'docs-writer': 'Docs Writer is drafting',
  'gmail-drafter': 'Gmail Drafter is preparing',
}

export function ThinkingIndicator() {
  const activeAgent = useSessionStore((s) => s.activeAgent)
  const todos = useSessionStore((s) => s.todos)
  const contextState = useSessionStore((s) => s.contextState)
  const taskRuns = useSessionStore((s) => s.taskRuns)
  const messages = useSessionStore((s) => s.messages)
  const runningTaskCount = taskRuns.filter((task) => task.status === 'running' || task.status === 'queued').length
  const latestTaskOrder = taskRuns.reduce((max, task) => Math.max(max, task.order), 0)
  const latestAssistantOrder = messages.reduce((max, message) => message.role === 'assistant' ? Math.max(max, message.order) : max, 0)
  const isMergingResults = activeAgent === 'cowork' && runningTaskCount === 0 && latestTaskOrder > latestAssistantOrder
  const label = runningTaskCount > 0 && activeAgent === 'cowork'
    ? `Cowork is coordinating ${runningTaskCount} sub-agent${runningTaskCount === 1 ? '' : 's'}`
    : isMergingResults
      ? 'Cowork is merging sub-agent results'
      : activeAgent
        ? AGENT_LABELS[activeAgent] || `${activeAgent} is working`
        : 'Thinking'

  const hasTodos = todos.length > 0

  return (
    <div className="py-2">
      <span className="thinking-shimmer text-[13px] font-medium">{label}</span>
      {contextState === 'compacting' && (
        <div className="mt-1 text-[11px]" style={{ color: 'var(--color-amber)' }}>
          Compacting conversation to preserve context...
        </div>
      )}
      {hasTodos && (
        <div className="mt-2 flex flex-col gap-1">
          {todos.map((todo, i) => (
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
