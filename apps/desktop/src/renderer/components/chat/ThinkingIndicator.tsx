import { useSessionStore } from '../../stores/session'

const AGENT_LABELS: Record<string, string> = {
  analyst: 'Analyst is analyzing',
  workspace: 'Workspace is working',
  build: 'Building',
  plan: 'Planning',
  explore: 'Exploring',
}

export function ThinkingIndicator() {
  const activeAgent = useSessionStore((s) => s.activeAgent)
  const todos = useSessionStore((s) => s.todos)
  const label = activeAgent ? AGENT_LABELS[activeAgent] || `${activeAgent} is working` : 'Thinking'

  const hasTodos = todos.length > 0
  const completed = todos.filter(t => t.status === 'completed').length
  const inProgress = todos.find(t => t.status === 'in_progress')

  return (
    <div className="py-2">
      <span className="thinking-shimmer text-[13px] font-medium">{label}</span>
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
