import type { TodoItem } from '@open-cowork/shared'

// Canonical rendering for TodoItem status / priority across the task
// drill-in drawer, ThinkingIndicator, and the Todos panel in
// SessionInspector. Keeping one source of truth prevents the glyphs and
// colors from drifting per surface.

const PRIORITY_RANK: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
}

// High priority + in-progress float to the top; cancelled sinks.
const STATUS_RANK: Record<string, number> = {
  in_progress: 0,
  blocked: 1,
  pending: 2,
  completed: 3,
  cancelled: 4,
}

export function sortTodos(todos: TodoItem[]): TodoItem[] {
  return todos.slice().sort((a, b) => {
    const aStatus = STATUS_RANK[(a.status || '').toLowerCase()] ?? 5
    const bStatus = STATUS_RANK[(b.status || '').toLowerCase()] ?? 5
    if (aStatus !== bStatus) return aStatus - bStatus

    const aPriority = PRIORITY_RANK[(a.priority || '').toLowerCase()] ?? 3
    const bPriority = PRIORITY_RANK[(b.priority || '').toLowerCase()] ?? 3
    return aPriority - bPriority
  })
}

export type TodoVisual = {
  glyph: string
  color: string
  label: string
  strikethrough: boolean
  muted: boolean
}

export function todoStatusVisual(status: string | null | undefined): TodoVisual {
  const normalized = (status || '').toLowerCase()
  if (normalized === 'completed') {
    return { glyph: '✓', color: 'var(--color-green)', label: 'Done', strikethrough: true, muted: true }
  }
  if (normalized === 'in_progress' || normalized === 'running') {
    return { glyph: '◉', color: 'var(--color-accent)', label: 'Active', strikethrough: false, muted: false }
  }
  if (normalized === 'blocked') {
    return { glyph: '⊘', color: 'var(--color-amber)', label: 'Blocked', strikethrough: false, muted: false }
  }
  if (normalized === 'cancelled' || normalized === 'canceled') {
    return { glyph: '✕', color: 'var(--color-text-muted)', label: 'Cancelled', strikethrough: true, muted: true }
  }
  return { glyph: '○', color: 'var(--color-text-muted)', label: 'Pending', strikethrough: false, muted: false }
}

export type TodoPriorityVisual = {
  // CSS color var for the left border / dot. null means no visual emphasis.
  accent: string | null
  label: string
}

export function todoPriorityVisual(priority: string | null | undefined): TodoPriorityVisual {
  const normalized = (priority || '').toLowerCase()
  if (normalized === 'high') return { accent: 'var(--color-red)', label: 'High' }
  if (normalized === 'medium') return { accent: 'var(--color-amber)', label: 'Medium' }
  if (normalized === 'low') return { accent: 'var(--color-text-muted)', label: 'Low' }
  return { accent: null, label: '' }
}

// Count todos by status bucket using the same vocabulary as the glyph
// function above so summaries don't drift. Consumers can label and
// format however they like.
export type TodoCounts = {
  pending: number
  active: number
  completed: number
  blocked: number
  cancelled: number
  total: number
}

export function countTodos(todos: TodoItem[]): TodoCounts {
  const counts: TodoCounts = { pending: 0, active: 0, completed: 0, blocked: 0, cancelled: 0, total: todos.length }
  for (const todo of todos) {
    const normalized = (todo.status || '').toLowerCase()
    if (normalized === 'in_progress' || normalized === 'running') counts.active += 1
    else if (normalized === 'completed') counts.completed += 1
    else if (normalized === 'blocked') counts.blocked += 1
    else if (normalized === 'cancelled' || normalized === 'canceled') counts.cancelled += 1
    else counts.pending += 1
  }
  return counts
}

export function summarizeTodoCounts(counts: TodoCounts): string {
  const parts = [
    counts.active > 0 ? `${counts.active} active` : null,
    counts.pending > 0 ? `${counts.pending} pending` : null,
    counts.blocked > 0 ? `${counts.blocked} blocked` : null,
    counts.completed > 0 ? `${counts.completed} done` : null,
    counts.cancelled > 0 ? `${counts.cancelled} cancelled` : null,
  ].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' · ') : 'No todos'
}
