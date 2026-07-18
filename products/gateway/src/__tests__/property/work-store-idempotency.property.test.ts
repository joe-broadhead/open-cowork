import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest } from '../../config.js'
import { clearWorkStateForTest, createWorkTask, loadWorkState } from '../../work-store.js'

// Property: an idempotencyKey collapses any number of repeated creates into
// exactly one task. Tested at the store level (the durable contract) so it
// holds regardless of how routes are eventually wired on top of it.

const SEED = Number(process.env['FAST_CHECK_SEED']) || 0x1de3
const PROPERTY_TEST_TIMEOUT_MS = 60_000

describe('work store idempotent create (property)', () => {
  let testDir: string
  let store: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-ws-idem-'))
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

  it('creating a task with the same idempotencyKey any number of times yields exactly one task', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 32 }).filter(s => s.trim().length > 0),
        fc.string({ minLength: 1, maxLength: 40 }).map(s => s.replace(/\s+/g, ' ').trim() || 'task'),
        fc.integer({ min: 1, max: 8 }),
        (idempotencyKey, title, repeats) => {
          clearWorkStateForTest(store)
          const created = Array.from({ length: repeats }, () =>
            createWorkTask({ title, idempotencyKey, sourceType: 'test' }, store),
          )

          // Every call returns the same task id...
          const ids = new Set(created.map(task => task.id))
          expect(ids.size).toBe(1)

          // ...and the store holds exactly one matching row. The store trims
          // keys, so match against the normalized (trimmed) value.
          const normalizedKey = idempotencyKey.trim()
          const matching = loadWorkState(store).tasks.filter(task => task.sourceKey === normalizedKey && task.sourceType === 'test')
          expect(matching).toHaveLength(1)
        },
      ),
      { seed: SEED, numRuns: 50 },
    )
  }, PROPERTY_TEST_TIMEOUT_MS)

  it('distinct idempotencyKeys never collapse into one task', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ minLength: 1, maxLength: 24 }).filter(s => s.trim().length > 0), { minLength: 2, maxLength: 6 }), keys => {
        clearWorkStateForTest(store)
        for (const key of keys) createWorkTask({ title: `task ${key}`, idempotencyKey: key, sourceType: 'test' }, store)
        // The store normalizes keys by trimming, so two raw keys that trim to
        // the same value are one dedupe identity — count distinct trimmed keys.
        const distinctKeys = new Set(keys.map(k => k.trim()))
        const rows = loadWorkState(store).tasks.filter(task => task.sourceType === 'test')
        expect(rows).toHaveLength(distinctKeys.size)
      }),
      { seed: SEED, numRuns: 40 },
    )
  }, PROPERTY_TEST_TIMEOUT_MS)
})
