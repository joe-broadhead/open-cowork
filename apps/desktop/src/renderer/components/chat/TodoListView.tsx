import type { TodoItem } from '@open-cowork/shared'
import { sortTodos, todoPriorityVisual, todoStatusVisual } from './todo-utils'

type Props = {
  todos: TodoItem[]
  // Passing 'compact' trims spacing for inline rendering inside task cards.
  variant?: 'default' | 'compact'
  // Show a row-level priority tag (High / Medium / Low). Defaults to true —
  // the ThinkingIndicator fallback intentionally omits it to stay terse.
  showPriorityTag?: boolean
}

export function TodoListView({ todos, variant = 'default', showPriorityTag = true }: Props) {
  if (todos.length === 0) return null

  const sorted = sortTodos(todos)
  const gap = variant === 'compact' ? 'gap-1' : 'gap-1.5'
  const rowPadY = variant === 'compact' ? 'py-0.5' : 'py-1'

  return (
    <ul className={`flex flex-col ${gap}`}>
      {sorted.map((todo, index) => {
        const status = todoStatusVisual(todo.status)
        const priority = todoPriorityVisual(todo.priority)
        const key = todo.id || `${todo.content}-${index}`

        return (
          <li
            key={key}
            className={`flex items-start gap-2 text-[11px] leading-snug ${rowPadY}`}
            style={{
              borderLeft: priority.accent
                ? `2px solid ${priority.accent}`
                : '2px solid transparent',
              paddingLeft: priority.accent ? '8px' : '10px',
            }}
          >
            <span
              aria-hidden="true"
              title={status.label}
              className="shrink-0 leading-none pt-[2px]"
              style={{ color: status.color }}
            >
              {status.glyph}
            </span>
            <span
              className="min-w-0 flex-1"
              style={{
                color: status.muted ? 'var(--color-text-muted)' : 'var(--color-text-secondary)',
                textDecoration: status.strikethrough ? 'line-through' : 'none',
                wordBreak: 'break-word',
              }}
            >
              {todo.content || <em style={{ color: 'var(--color-text-muted)' }}>Untitled todo</em>}
            </span>
            {showPriorityTag && priority.accent && (
              <span
                className="shrink-0 px-1.5 py-px rounded-full text-[9px] font-medium uppercase tracking-[0.04em]"
                title={`${priority.label} priority`}
                style={{
                  color: priority.accent,
                  background: `color-mix(in srgb, ${priority.accent} 12%, transparent)`,
                }}
              >
                {priority.label}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
