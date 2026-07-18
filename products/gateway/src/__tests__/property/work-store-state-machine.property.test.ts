import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest } from '../../config.js'
import {
  addWorkDependency,
  applyWorkTaskAction,
  clearWorkStateForTest,
  createWorkTask,
  loadWorkState,
  startWorkTaskRun,
  type WorkDependencyType,
  type WorkStatus,
  type WorkTaskAction,
} from '../../work-store.js'

// Property-based state-machine test: drive the REAL SQLite work store through
// random-but-valid sequences of task / dependency / action operations and
// assert the store's invariants hold after every step. This complements the
// example-based work-store.test.ts by exploring interleavings no hand-written
// test enumerates. numRuns is bounded so the suite stays fast; the seed is
// pinned (overridable via FAST_CHECK_SEED) so failures reproduce.

const SEED = Number(process.env['FAST_CHECK_SEED']) || 0x51a7e
const PROPERTY_TEST_TIMEOUT_MS = 60_000
const LEGAL_STATUSES: readonly WorkStatus[] = ['pending', 'running', 'done', 'blocked', 'paused', 'cancelled', 'archived']
const ACTIONS: readonly WorkTaskAction[] = ['pause', 'resume', 'cancel', 'retry', 'done', 'block']
const DEP_TYPES: readonly WorkDependencyType[] = ['blocks', 'blocked_by', 'parent', 'child', 'related', 'duplicate']
const BLOCKING_TYPES = new Set<WorkDependencyType>(['blocks', 'blocked_by', 'parent'])

type Op =
  | { kind: 'createTask'; title: string; priority: 'HIGH' | 'MEDIUM' | 'LOW' }
  | { kind: 'addDependency'; from: number; to: number; type: WorkDependencyType }
  | { kind: 'action'; task: number; action: WorkTaskAction }
  | { kind: 'startRun'; task: number }

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('createTask' as const),
    title: fc.string({ minLength: 1, maxLength: 40 }).map(s => s.replace(/\s+/g, ' ').trim() || 'task'),
    priority: fc.constantFrom('HIGH' as const, 'MEDIUM' as const, 'LOW' as const),
  }),
  fc.record({
    kind: fc.constant('addDependency' as const),
    from: fc.nat({ max: 12 }),
    to: fc.nat({ max: 12 }),
    type: fc.constantFrom(...DEP_TYPES),
  }),
  fc.record({
    kind: fc.constant('action' as const),
    task: fc.nat({ max: 12 }),
    action: fc.constantFrom(...ACTIONS),
  }),
  fc.record({ kind: fc.constant('startRun' as const), task: fc.nat({ max: 12 }) }),
)

// Independent cycle check over blocking edges, computed against the loaded
// state so we never trust the product's own guard to police itself.
function hasBlockingCycle(deps: Array<{ taskId: string; dependsOnTaskId: string; type: WorkDependencyType }>): boolean {
  const edges = deps.filter(dep => BLOCKING_TYPES.has(dep.type))
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    const list = adjacency.get(edge.taskId) || []
    list.push(edge.dependsOnTaskId)
    adjacency.set(edge.taskId, list)
  }
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const dfs = (node: string): boolean => {
    color.set(node, GRAY)
    for (const next of adjacency.get(node) || []) {
      const c = color.get(next) ?? WHITE
      if (c === GRAY) return true
      if (c === WHITE && dfs(next)) return true
    }
    color.set(node, BLACK)
    return false
  }
  for (const node of adjacency.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE && dfs(node)) return true
  }
  return false
}

describe('work store state machine (property)', () => {
  let testDir: string
  let store: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-ws-prop-'))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    store = path.join(testDir, 'gateway.db')
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('never violates task/dependency/run invariants under random operation sequences', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 40 }), ops => {
        clearWorkStateForTest(store)
        const taskIds: string[] = []
        let runsStarted = 0

        for (const op of ops) {
          if (op.kind === 'createTask') {
            const task = createWorkTask({ title: op.title, priority: op.priority, pipeline: ['implement', 'verify'] }, store)
            taskIds.push(task.id)
          } else if (op.kind === 'addDependency' && taskIds.length > 0) {
            const from = taskIds[op.from % taskIds.length]!
            const to = taskIds[op.to % taskIds.length]!
            if (from === to) continue
            try {
              addWorkDependency({ taskId: from, dependsOnTaskId: to, type: op.type }, store)
            } catch (err) {
              // The only expected rejection is the cycle guard; anything else is
              // a real bug surfaced by the property.
              expect(String((err as Error).message)).toMatch(/cycle|already exists|not found/i)
            }
          } else if (op.kind === 'action' && taskIds.length > 0) {
            const target = taskIds[op.task % taskIds.length]
            applyWorkTaskAction(target!, op.action, {}, store)
          } else if (op.kind === 'startRun' && taskIds.length > 0) {
            const target = taskIds[op.task % taskIds.length]
            const result = startWorkTaskRun(target!, 'implement', `ses_prop_${runsStarted++}`, 'implementer', store)
            if (result) expect(result.run.taskId).toBe(target)
          }

          // Invariant checks after every mutation.
          const state = loadWorkState(store)
          const dependencies = state.dependencies || []
          const runs = state.runs || []
          const knownTaskIds = new Set(state.tasks.map(task => task.id))

          // 1. Every task carries a legal status.
          for (const task of state.tasks) expect(LEGAL_STATUSES).toContain(task.status)

          // 2. No dependency dangles: both endpoints must reference live tasks.
          for (const dep of dependencies) {
            expect(knownTaskIds.has(dep.taskId)).toBe(true)
            expect(knownTaskIds.has(dep.dependsOnTaskId)).toBe(true)
          }

          // 3. No blocking-dependency cycle ever survives a committed mutation.
          expect(hasBlockingCycle(dependencies)).toBe(false)

          // 4. No orphaned run: every persisted run points at a live task.
          for (const run of runs) expect(knownTaskIds.has(run.taskId)).toBe(true)
        }
      }),
      { seed: SEED, numRuns: 60 },
    )
  }, PROPERTY_TEST_TIMEOUT_MS)
})
