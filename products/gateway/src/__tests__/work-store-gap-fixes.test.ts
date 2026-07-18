import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { clearConfigCacheForTest } from '../config.js'
import {
  closeWorkDb,
  completeWorkTaskRun,
  createWorkTask,
  createWorkTasks,
  disposeWorkStore,
  getRun,
  loadWorkState,
  startWorkTaskRun,
} from '../work-store.js'
import { createStorageBackup, restoreStorageBackup } from '../storage.js'

describe('work-store gap fixes', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-gap-fixes-'))
  const store = path.join(testDir, 'gateway.db')

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    disposeWorkStore()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(testDir, { recursive: true })
  })

  afterEach(() => {
    disposeWorkStore()
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
  })

  describe('FIX 2 — idempotent externally-triggered creation', () => {
    it('returns the existing task when the same idempotency key is reused', () => {
      const first = createWorkTask({ title: 'ingest issue 42', idempotencyKey: 'gh:issue:42' }, store)
      const second = createWorkTask({ title: 'ingest issue 42 (retry)', idempotencyKey: 'gh:issue:42' }, store)

      expect(second.id).toBe(first.id)
      expect(second.title).toBe('ingest issue 42') // original wins; no duplicate insert
      expect(loadWorkState(store).tasks.filter(task => task.title.startsWith('ingest issue 42'))).toHaveLength(1)
    })

    it('creates distinct tasks for distinct keys and for no key', () => {
      const a = createWorkTask({ title: 'a', idempotencyKey: 'k-a' }, store)
      const b = createWorkTask({ title: 'b', idempotencyKey: 'k-b' }, store)
      const c = createWorkTask({ title: 'c' }, store)
      const d = createWorkTask({ title: 'c' }, store) // no key => unique per call

      expect(new Set([a.id, b.id, c.id, d.id]).size).toBe(4)
      expect(loadWorkState(store).tasks).toHaveLength(4)
    })

    it('dedupes within a bulk create call and persists the source key across mutations', () => {
      const [first, second] = createWorkTasks([
        { title: 'bulk one', idempotencyKey: 'bulk:1' },
        { title: 'bulk one again', idempotencyKey: 'bulk:1' },
      ], undefined, store)
      expect(second!.id).toBe(first!.id)

      // Source key must round-trip so a later create with the same key still dedupes
      const third = createWorkTask({ title: 'bulk one third', idempotencyKey: 'bulk:1' }, store)
      expect(third.id).toBe(first!.id)
      expect(loadWorkState(store).tasks).toHaveLength(1)
    })
  })

  describe('FIX 4 — corrupt JSON columns fail closed', () => {
    it('loads a task with a corrupt attempts_json column using the default instead of throwing', () => {
      const task = createWorkTask({ title: 'corrupt me', pipeline: ['implement'] }, store)
      closeWorkDb(store)
      const raw = new DatabaseSync(store)
      raw.prepare('UPDATE tasks SET attempts_json = ? WHERE id = ?').run('{not valid json', task.id)
      raw.close()

      const state = loadWorkState(store)
      const reloaded = state.tasks.find(row => row.id === task.id)
      expect(reloaded).toBeDefined()
      expect(reloaded!.attempts).toEqual({}) // fail-closed default, not a crash
    })
  })

  describe('FIX 1 — run detail via targeted query + full history queryable', () => {
    it('serves getRun by id and session id from the runs table with history present', () => {
      const tasks = [0, 1, 2].map(i => createWorkTask({ title: `t${i}`, pipeline: ['implement'] }, store))
      const runs = tasks.map(task => {
        const started = startWorkTaskRun(task.id, 'implement', `ses_${task.id}`, 'build', store)!.run
        completeWorkTaskRun(started.id, { status: 'pass', summary: 'ok', feedback: '', artifacts: [], evidence: [], raw: '' }, 1, store)
        return started
      })

      const target = runs[1]
      expect(getRun(target!.id, store)?.id).toBe(target!.id)
      expect(getRun(`ses_${tasks[1]!.id}`, store)?.id).toBe(target!.id)
      expect(getRun('does-not-exist', store)).toBeUndefined()

      // Full history remains queryable through the materialized state read path.
      expect(loadWorkState(store).runs).toHaveLength(3)
    })
  })

  describe('FIX 3 — structural CHECK invariants on fresh databases', () => {
    it('rejects an invalid task status/priority and dependency type at the SQLite boundary', () => {
      createWorkTask({ title: 'seed schema' }, store) // materialize the schema
      closeWorkDb(store)
      const raw = new DatabaseSync(store)
      try {
        expect(() => raw.prepare(
          `INSERT INTO tasks (id, roadmap_id, title, description, status, priority, agent, pipeline_json, attempts_json, source_type, source_key, created_at, updated_at)
           VALUES ('t_bad', 'r', 't', 'd', 'not-a-status', 'HIGH', 'build', '[]', '{}', 'manual', 'manual:t_bad', 'now', 'now')`,
        ).run()).toThrow(/CHECK/i)
        expect(() => raw.prepare(
          `INSERT INTO tasks (id, roadmap_id, title, description, status, priority, agent, pipeline_json, attempts_json, source_type, source_key, created_at, updated_at)
           VALUES ('t_bad2', 'r', 't', 'd', 'pending', 'URGENT', 'build', '[]', '{}', 'manual', 'manual:t_bad2', 'now', 'now')`,
        ).run()).toThrow(/CHECK/i)
        expect(() => raw.prepare(
          `INSERT INTO work_dependencies (task_id, depends_on_task_id, type, created_at) VALUES ('a', 'b', 'sometimes', 'now')`,
        ).run()).toThrow(/CHECK/i)
        expect(() => raw.prepare(
          `INSERT INTO runs (id, task_id, stage, session_id, profile, status, attempt, started_at) VALUES ('run_bad', 't', 's', 'ses', 'p', 'weird', 1, 'now')`,
        ).run()).toThrow(/CHECK/i)
      } finally {
        raw.close()
      }
    })

    it('accepts a valid full lifecycle', () => {
      const task = createWorkTask({ title: 'lifecycle', priority: 'LOW', pipeline: ['implement'] }, store)
      const run = startWorkTaskRun(task.id, 'implement', 'ses_life', 'build', store)!.run
      expect(() => completeWorkTaskRun(run.id, { status: 'pass', summary: 'ok', feedback: '', artifacts: [], evidence: [], raw: '' }, 1, store)).not.toThrow()
      expect(loadWorkState(store).runs[0]!.status).toBe('passed')
    })
  })

  describe('FIX 5 — connection + statement cache', () => {
    it('keeps distinct store paths isolated', () => {
      const storeB = path.join(testDir, 'other.db')
      createWorkTask({ title: 'in A' }, store)
      createWorkTask({ title: 'in B' }, storeB)
      expect(loadWorkState(store).tasks.map(t => t.title)).toEqual(['in A'])
      expect(loadWorkState(storeB).tasks.map(t => t.title)).toEqual(['in B'])
    })

    it('self-heals when the database file is deleted out-of-band', () => {
      createWorkTask({ title: 'before delete' }, store)
      expect(loadWorkState(store).tasks).toHaveLength(1)
      // Simulate a harness/operator removing the db underneath the cached handle.
      for (const f of [store, `${store}-wal`, `${store}-shm`]) { try { fs.rmSync(f, { force: true }) } catch {} }
      // The cache must detect the vanished inode and re-open a fresh database.
      expect(loadWorkState(store).tasks).toHaveLength(0)
      const task = createWorkTask({ title: 'after delete' }, store)
      expect(getRun('none', store)).toBeUndefined()
      expect(loadWorkState(store).tasks.map(t => t.id)).toEqual([task.id])
    })

    it('round-trips a backup + restore with the cache active', async () => {
      createWorkTask({ title: 'durable before backup' }, store)
      const backup = createStorageBackup({ stateDir: testDir })
      expect(fs.existsSync(backup.path)).toBe(true)

      // Mutate after backup, then restore should roll the store back.
      createWorkTask({ title: 'added after backup' }, store)
      expect(loadWorkState(store).tasks).toHaveLength(2)

      await restoreStorageBackup(backup.path, { maintenanceMode: true, skipSafetyBackup: true })
      const restored = loadWorkState(store).tasks.map(t => t.title)
      expect(restored).toEqual(['durable before backup'])
    })
  })
})
