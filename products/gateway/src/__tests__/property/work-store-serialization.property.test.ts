import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest } from '../../config.js'
import {
  addWorkDependency,
  clearWorkStateForTest,
  completeWorkTaskRun,
  createWorkTask,
  loadWorkState,
  saveWorkState,
  startWorkTaskRun,
  type WorkState,
} from '../../work-store.js'

// Property: the SQLite row mapping is a faithful inverse — writeRow(rowTo(x))
// preserves x. We drive the real store (never a reimplemented model): whatever
// the store persists, a save + reload must reproduce byte-for-byte (modulo the
// savedAt clock stamp). This is the *_json parse/stringify asymmetry trap —
// pipeline_json, attempts_json, environment_json, result_json, quality_spec_json
// all flow through here.

const SEED = Number(process.env['FAST_CHECK_SEED']) || 0xba5e
const PROPERTY_TEST_TIMEOUT_MS = 60_000

const stageArb = fc.constantFrom('implement', 'review', 'verify', 'plan', 'test')

const taskArb = fc.record({
  title: fc.string({ minLength: 1, maxLength: 40 }).map(s => s.replace(/\s+/g, ' ').trim() || 'task'),
  priority: fc.constantFrom('HIGH' as const, 'MEDIUM' as const, 'LOW' as const),
  pipeline: fc.uniqueArray(stageArb, { minLength: 1, maxLength: 3 }),
  note: fc.option(fc.string({ maxLength: 60 }), { nil: undefined }),
  slaClass: fc.option(fc.constantFrom('gold', 'silver', 'bronze'), { nil: undefined }),
  stageProfiles: fc.option(fc.dictionary(stageArb, fc.constantFrom('implementer', 'reviewer', 'verifier'), { maxKeys: 2 }), { nil: undefined }),
})

function withoutSavedAt(state: WorkState): Omit<WorkState, 'savedAt'> {
  const { savedAt: _savedAt, ...rest } = state
  return rest
}

describe('work store serialization round-trip (property)', () => {
  let testDir: string
  let store: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-ws-serde-'))
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

  it('save(load(x)) is a stable fixpoint for arbitrary populated states', () => {
    fc.assert(
      fc.property(fc.array(taskArb, { minLength: 1, maxLength: 8 }), fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 6 }), (tasks, depPairs) => {
        clearWorkStateForTest(store)
        const ids: string[] = []
        for (const spec of tasks) {
          try {
            const task = createWorkTask(spec, store)
            ids.push(task.id)
          } catch {
            // Inputs the store rejects are irrelevant to the round-trip claim.
          }
        }
        if (ids.length === 0) return

        // Add a few non-cyclic dependencies to populate work_dependencies rows.
        for (const [a, b] of depPairs) {
          const from = ids[a % ids.length]!
          const to = ids[b % ids.length]!
          if (from === to) continue
          try { addWorkDependency({ taskId: from, dependsOnTaskId: to }, store) } catch {}
        }

        // Exercise runs so environment_json / result_json columns carry data.
        const runTaskId = ids[0]
        const started = startWorkTaskRun(runTaskId!, 'implement', 'ses_serde', 'implementer', store)
        if (started) {
          completeWorkTaskRun(started.run.id, {
            status: 'pass',
            summary: 'round-trip run',
            feedback: '',
            artifacts: ['patch:abc'],
            evidence: [{ type: 'diff', ref: 'abc', summary: 'evidence' }],
            raw: '{"k":"v"}',
          }, 2, store)
        }

        // First load == rowTo(current rows). Save it back (writeRow), reload,
        // and the two normalized snapshots must be identical.
        const first = loadWorkState(store)
        saveWorkState(first, store)
        const second = loadWorkState(store)

        expect(withoutSavedAt(second)).toEqual(withoutSavedAt(first))
      }),
      { seed: SEED, numRuns: 50 },
    )
  }, PROPERTY_TEST_TIMEOUT_MS)
})
