import test from 'node:test'
import assert from 'node:assert/strict'
import type { TodoItem } from '../packages/shared/src/index.ts'
import {
  countTodos,
  sortTodos,
  summarizeTodoCounts,
  todoPriorityVisual,
  todoStatusVisual,
} from '../apps/desktop/src/renderer/components/chat/todo-utils.ts'

test('todoStatusVisual returns distinct glyphs for each SDK status', () => {
  assert.equal(todoStatusVisual('pending').glyph, '○')
  assert.equal(todoStatusVisual('in_progress').glyph, '◉')
  assert.equal(todoStatusVisual('completed').glyph, '✓')
  assert.equal(todoStatusVisual('blocked').glyph, '⊘')
  assert.equal(todoStatusVisual('cancelled').glyph, '✕')

  // completed and cancelled should render muted + strikethrough so the
  // user can instantly tell them apart from active work.
  assert.equal(todoStatusVisual('completed').strikethrough, true)
  assert.equal(todoStatusVisual('cancelled').strikethrough, true)
  assert.equal(todoStatusVisual('pending').strikethrough, false)

  // blocked must be warning-colored, not the neutral muted color.
  assert.ok(todoStatusVisual('blocked').color.includes('amber'))
})

test('todoPriorityVisual distinguishes high / medium / low and falls back to none', () => {
  assert.ok(todoPriorityVisual('high').accent)
  assert.ok(todoPriorityVisual('medium').accent)
  assert.ok(todoPriorityVisual('low').accent)
  assert.equal(todoPriorityVisual(undefined).accent, null)
  assert.equal(todoPriorityVisual('wat').accent, null)
})

test('sortTodos orders in_progress before pending, pending before completed, and high priority before low within a bucket', () => {
  const todos: TodoItem[] = [
    { id: 'a', content: 'done low', status: 'completed', priority: 'low' },
    { id: 'b', content: 'pending high', status: 'pending', priority: 'high' },
    { id: 'c', content: 'active low', status: 'in_progress', priority: 'low' },
    { id: 'd', content: 'pending low', status: 'pending', priority: 'low' },
    { id: 'e', content: 'blocked medium', status: 'blocked', priority: 'medium' },
    { id: 'f', content: 'cancelled high', status: 'cancelled', priority: 'high' },
  ]

  const sorted = sortTodos(todos)
  assert.deepEqual(sorted.map((t) => t.id), ['c', 'e', 'b', 'd', 'a', 'f'])
})

test('countTodos groups by status using SDK vocabulary', () => {
  const counts = countTodos([
    { content: '1', status: 'pending', priority: 'high' },
    { content: '2', status: 'in_progress', priority: 'low' },
    { content: '3', status: 'completed', priority: 'medium' },
    { content: '4', status: 'blocked', priority: 'low' },
    { content: '5', status: 'cancelled', priority: 'low' },
    { content: '6', status: 'running', priority: 'low' }, // alias for in_progress
  ])

  assert.equal(counts.pending, 1)
  assert.equal(counts.active, 2)
  assert.equal(counts.completed, 1)
  assert.equal(counts.blocked, 1)
  assert.equal(counts.cancelled, 1)
  assert.equal(counts.total, 6)
})

test('summarizeTodoCounts drops empty buckets and renders human-readable summary', () => {
  assert.equal(
    summarizeTodoCounts({ pending: 2, active: 1, completed: 3, blocked: 0, cancelled: 0, total: 6 }),
    '1 active · 2 pending · 3 done',
  )
  assert.equal(
    summarizeTodoCounts({ pending: 0, active: 0, completed: 0, blocked: 0, cancelled: 0, total: 0 }),
    'No todos',
  )
})
