import test from 'node:test'
import assert from 'node:assert/strict'
import { syncTodosWithTaskRuns } from '../apps/desktop/src/renderer/helpers/todo-sync.ts'

test('syncTodosWithTaskRuns marks matching todos completed when child tasks finish', () => {
  const todos = [
    { content: 'Research Model Context Protocol (MCP) - architecture, use cases, ecosystem', status: 'pending', priority: 'high' },
    { content: 'Research Open Skills Standard - specification, adoption, benefits', status: 'pending', priority: 'high' },
    { content: 'Synthesize findings and prepare meeting materials', status: 'pending', priority: 'medium' },
  ]

  const synced = syncTodosWithTaskRuns(todos, [
    { id: 'a', title: 'MCP deep research', status: 'complete' },
    { id: 'b', title: 'Open Skills Standard research', status: 'running' },
  ])

  assert.equal(synced[0].status, 'completed')
  assert.equal(synced[1].status, 'in_progress')
  assert.equal(synced[2].status, 'pending')
})

test('syncTodosWithTaskRuns does not overwrite unrelated todos', () => {
  const todos = [
    { content: 'Prepare final summary', status: 'pending', priority: 'medium' },
  ]

  const synced = syncTodosWithTaskRuns(todos, [
    { id: 'a', title: 'MCP deep research', status: 'complete' },
  ])

  assert.equal(synced[0].status, 'pending')
})

test('syncTodosWithTaskRuns does not complete follow-up review todos that only share topic words', () => {
  const todos = [
    { content: 'Review MCP research results with Ewerton', status: 'pending', priority: 'medium' },
  ]

  const synced = syncTodosWithTaskRuns(todos, [
    { id: 'a', title: 'MCP deep research', status: 'complete' },
  ])

  assert.equal(synced[0].status, 'pending')
})
