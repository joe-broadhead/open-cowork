import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { TaskRun } from '../packages/shared/src/index.ts'
import {
  buildOrchestrationTree,
  computeLaneProgress,
  formatAgentName,
  formatCost,
  formatTokensCompact,
  groupMaxElapsed,
  laneElapsedMs,
  selectAggregateTiming,
  summarizeStatus,
} from '../apps/desktop/src/renderer/components/chat/mission-control-utils.ts'

function makeTask(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: overrides.id || 'task:root',
    title: 'Task',
    agent: 'research',
    status: 'running',
    sourceSessionId: 'child-a',
    parentSessionId: null,
    content: '',
    transcript: [],
    toolCalls: [],
    compactions: [],
    todos: [],
    error: null,
    sessionCost: 0,
    sessionTokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    order: 1,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  }
}

describe('buildOrchestrationTree', () => {
  it('returns an empty tree for no tasks', () => {
    assert.deepEqual(buildOrchestrationTree([]), [])
  })

  it('treats tasks with no parentSessionId as roots', () => {
    const root1 = makeTask({ id: 'a', sourceSessionId: 'child-a', order: 1 })
    const root2 = makeTask({ id: 'b', sourceSessionId: 'child-b', order: 2 })
    const tree = buildOrchestrationTree([root1, root2])
    assert.equal(tree.length, 2)
    assert.deepEqual(tree.map((lane) => lane.taskRun.id), ['a', 'b'])
    assert.deepEqual(tree.map((lane) => lane.children.length), [0, 0])
    assert.deepEqual(tree.map((lane) => lane.deeperCount), [0, 0])
  })

  it('nests a task under its parent when parentSessionId matches another task sourceSessionId', () => {
    const parent = makeTask({ id: 'p', sourceSessionId: 'child-p', order: 1 })
    const nested = makeTask({ id: 'c', sourceSessionId: 'child-c', parentSessionId: 'child-p', order: 2 })
    const tree = buildOrchestrationTree([parent, nested])
    assert.equal(tree.length, 1)
    assert.equal(tree[0].taskRun.id, 'p')
    assert.deepEqual(tree[0].children.map((entry) => entry.taskRun.id), ['c'])
    assert.equal(tree[0].children[0].deeperCount, 0)
  })

  it('orders child lanes by the task order field', () => {
    const parent = makeTask({ id: 'p', sourceSessionId: 'child-p', order: 1 })
    const first = makeTask({ id: 'first', sourceSessionId: 'child-first', parentSessionId: 'child-p', order: 3 })
    const second = makeTask({ id: 'second', sourceSessionId: 'child-second', parentSessionId: 'child-p', order: 2 })
    const tree = buildOrchestrationTree([parent, first, second])
    assert.deepEqual(tree[0].children.map((nested) => nested.taskRun.id), ['second', 'first'])
  })

  it('treats an orphaned child (parent not in list) as a root lane', () => {
    const orphan = makeTask({ id: 'o', sourceSessionId: 'child-o', parentSessionId: 'missing-parent' })
    const tree = buildOrchestrationTree([orphan])
    assert.equal(tree.length, 1)
    assert.equal(tree[0].taskRun.id, 'o')
  })

  it('rolls up level-3 grandchildren under the child lane as deeperCount', () => {
    // A → B → C. A is the root lane, B is its inline child, C is a
    // grandchild that previously would have orphaned into its own root.
    // Now it surfaces as `B.deeperCount === 1` so the user sees the hint
    // on B and can drill in for the full chain.
    const a = makeTask({ id: 'a', sourceSessionId: 'sa', order: 1 })
    const b = makeTask({ id: 'b', sourceSessionId: 'sb', parentSessionId: 'sa', order: 2 })
    const c = makeTask({ id: 'c', sourceSessionId: 'sc', parentSessionId: 'sb', order: 3 })
    const tree = buildOrchestrationTree([a, b, c])
    assert.equal(tree.length, 1, 'C must not orphan into a second root')
    assert.equal(tree[0].taskRun.id, 'a')
    assert.deepEqual(tree[0].children.map((lane) => lane.taskRun.id), ['b'])
    assert.equal(tree[0].children[0].deeperCount, 1)
  })

  it('counts all descendants of a child lane, not just the immediate next level', () => {
    // A → B → C → D. B.deeperCount should be 2 (C and D).
    const a = makeTask({ id: 'a', sourceSessionId: 'sa', order: 1 })
    const b = makeTask({ id: 'b', sourceSessionId: 'sb', parentSessionId: 'sa', order: 2 })
    const c = makeTask({ id: 'c', sourceSessionId: 'sc', parentSessionId: 'sb', order: 3 })
    const d = makeTask({ id: 'd', sourceSessionId: 'sd', parentSessionId: 'sc', order: 4 })
    const tree = buildOrchestrationTree([a, b, c, d])
    assert.equal(tree.length, 1)
    assert.equal(tree[0].children[0].deeperCount, 2)
  })

  it('aggregates deeperCount across fan-out at the grandchild level', () => {
    // A → B, and B fans out to C1 and C2. B.deeperCount = 2.
    const a = makeTask({ id: 'a', sourceSessionId: 'sa', order: 1 })
    const b = makeTask({ id: 'b', sourceSessionId: 'sb', parentSessionId: 'sa', order: 2 })
    const c1 = makeTask({ id: 'c1', sourceSessionId: 'sc1', parentSessionId: 'sb', order: 3 })
    const c2 = makeTask({ id: 'c2', sourceSessionId: 'sc2', parentSessionId: 'sb', order: 4 })
    const tree = buildOrchestrationTree([a, b, c1, c2])
    assert.equal(tree.length, 1)
    assert.equal(tree[0].children[0].deeperCount, 2)
  })
})

describe('computeLaneProgress', () => {
  it('returns 1 for complete tasks regardless of elapsed', () => {
    const task = makeTask({ status: 'complete', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:05Z' })
    assert.equal(computeLaneProgress(task, 10_000), 1)
  })

  it('returns 0 for queued tasks', () => {
    const task = makeTask({ status: 'queued', startedAt: null })
    assert.equal(computeLaneProgress(task, 10_000), 0)
  })

  it('scales running tasks against the group max', () => {
    const start = Date.now() - 2_000
    const task = makeTask({ status: 'running', startedAt: new Date(start).toISOString() })
    const progress = computeLaneProgress(task, 4_000)
    assert.ok(progress > 0.3 && progress < 0.7, `expected ~0.5, got ${progress}`)
  })

  it('clamps running tasks to a minimum visible fill so the lane is not empty', () => {
    const start = Date.now() - 5
    const task = makeTask({ status: 'running', startedAt: new Date(start).toISOString() })
    const progress = computeLaneProgress(task, 60_000)
    assert.ok(progress >= 0.04, `expected floor 0.04, got ${progress}`)
  })
})

describe('laneElapsedMs + groupMaxElapsed', () => {
  it('uses finishedAt for complete tasks', () => {
    const task = makeTask({
      status: 'complete',
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:10Z',
    })
    assert.equal(laneElapsedMs(task, Date.parse('2026-01-01T00:05:00Z')), 10_000)
  })

  it('does not keep counting wall-clock time for complete tasks missing finishedAt', () => {
    const task = makeTask({
      status: 'complete',
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: null,
    })
    assert.equal(laneElapsedMs(task, Date.parse('2026-01-03T00:00:00Z')), 0)
  })

  it('selects the slowest lane as the group max', () => {
    const fast = makeTask({ id: 'fast', status: 'complete', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:03Z' })
    const slow = makeTask({ id: 'slow', status: 'complete', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:11Z' })
    assert.equal(groupMaxElapsed([fast, slow], Date.parse('2026-01-01T01:00:00Z')), 11_000)
  })
})

describe('selectAggregateTiming', () => {
  it('prefers the earliest running start when any lane is still running', () => {
    const early = makeTask({ id: 'e', status: 'complete', startedAt: '2026-01-01T00:00:01Z', finishedAt: '2026-01-01T00:00:03Z' })
    const later = makeTask({ id: 'l', status: 'running', startedAt: '2026-01-01T00:00:05Z' })
    const result = selectAggregateTiming([early, later])
    assert.equal(result.startedAt, '2026-01-01T00:00:05Z')
    assert.equal(result.finishedAt, null)
  })

  it('falls back to finished-start/latest-finish when all tasks are done', () => {
    const a = makeTask({ id: 'a', status: 'complete', startedAt: '2026-01-01T00:00:02Z', finishedAt: '2026-01-01T00:00:08Z' })
    const b = makeTask({ id: 'b', status: 'complete', startedAt: '2026-01-01T00:00:03Z', finishedAt: '2026-01-01T00:00:10Z' })
    const result = selectAggregateTiming([a, b])
    assert.equal(result.startedAt, '2026-01-01T00:00:02Z')
    assert.equal(result.finishedAt, '2026-01-01T00:00:10Z')
  })

  it('treats terminal tasks without finishedAt as zero-duration instead of live', () => {
    const a = makeTask({ id: 'a', status: 'complete', startedAt: '2026-01-01T00:00:02Z', finishedAt: null })
    const result = selectAggregateTiming([a])
    assert.equal(result.startedAt, '2026-01-01T00:00:02Z')
    assert.equal(result.finishedAt, '2026-01-01T00:00:02Z')
  })
})

describe('summarizeStatus', () => {
  it('reports running count when any lane is running or queued', () => {
    const a = makeTask({ status: 'running' })
    const b = makeTask({ status: 'queued' })
    const c = makeTask({ status: 'complete' })
    assert.equal(summarizeStatus([a, b, c]), '2 running')
  })

  it('reports error count when everything has settled but something failed', () => {
    const a = makeTask({ status: 'complete' })
    const b = makeTask({ status: 'error' })
    assert.equal(summarizeStatus([a, b]), '1 errored')
  })

  it('reports complete count when all done and none errored', () => {
    const a = makeTask({ status: 'complete' })
    const b = makeTask({ status: 'complete' })
    assert.equal(summarizeStatus([a, b]), '2 complete')
  })
})

describe('formatAgentName / formatTokensCompact / formatCost', () => {
  it('humanizes agent slugs', () => {
    assert.equal(formatAgentName('code-reviewer'), 'Code Reviewer')
    assert.equal(formatAgentName('research'), 'Research')
    assert.equal(formatAgentName(null), 'Sub-agent')
  })

  it('formats tokens in the right range', () => {
    assert.equal(formatTokensCompact(0), '')
    assert.equal(formatTokensCompact(42), '42')
    assert.equal(formatTokensCompact(1_234), '1.2k')
    assert.equal(formatTokensCompact(14_000), '14k')
    assert.equal(formatTokensCompact(1_500_000), '1.5M')
  })

  it('formats cost with a sub-cent floor', () => {
    assert.equal(formatCost(0), '')
    assert.equal(formatCost(0.003), '<$0.01')
    assert.equal(formatCost(0.08), '$0.08')
  })
})
