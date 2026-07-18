import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { clearWorkersForTest, getWorkerCounts, listWorkers, loadWorkerState, reconcileOpenCodeSessions, saveWorkerState, trackWorker } from '../workers.js'

const worker = (id: string) => listWorkers().find(w => w.id === id)

describe('Gateway session sidecar state', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-sessions-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const store = path.join(testDir, 'sessions.json')

  beforeEach(() => {
    clearWorkersForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('persists and reloads session sidecar state', () => {
    trackWorker({ id: 'ses_1', title: 'Example', parentId: 'test', status: 'running', startedAt: '2026-01-01T00:00:00.000Z', lastCheck: '2026-01-01T00:00:00.000Z', lastTodo: null, lastMessage: null })
    saveWorkerState(store)

    clearWorkersForTest()
    loadWorkerState(store)

    expect(worker('ses_1')?.title).toBe('Example')
    expect(getWorkerCounts()).toMatchObject({ total: 1, running: 1 })
  })

  it('writes the session sidecar with private permissions', () => {
    trackWorker({ id: 'ses_private', title: 'Private', parentId: 'test', status: 'running', startedAt: '2026-01-01T00:00:00.000Z', lastCheck: '2026-01-01T00:00:00.000Z', lastTodo: null, lastMessage: null })
    saveWorkerState(store)

    expect((fs.statSync(store).mode & 0o777).toString(8)).toBe('600')
    expect((fs.statSync(testDir).mode & 0o777).toString(8)).toBe('700')
    expect(fs.readdirSync(testDir).filter(name => name.startsWith('sessions.json.tmp-'))).toEqual([])
  })

  it('does not wipe in-memory session entries when persisted JSON is corrupt', () => {
    trackWorker({ id: 'ses_keep', title: 'Keep me', parentId: 'test', status: 'running', startedAt: '2026-01-01T00:00:00.000Z', lastCheck: '2026-01-01T00:00:00.000Z', lastTodo: null, lastMessage: null })
    fs.mkdirSync(testDir, { recursive: true })
    fs.writeFileSync(store, '{broken json', { mode: 0o600 })

    loadWorkerState(store)

    expect(worker('ses_keep')?.title).toBe('Keep me')
    expect(getWorkerCounts()).toMatchObject({ total: 1, running: 1 })
  })

  it('reconciles active and completed GW sessions', () => {
    const now = Date.parse('2026-01-01T00:15:00.000Z')
    const created = Date.parse('2026-01-01T00:10:00.000Z')

    const count = reconcileOpenCodeSessions([
      { id: 'active', title: 'GW:Active task', time: { created }, tokens: {} },
      { id: 'done', title: 'GW:Done task', time: { created }, tokens: { input: 10 } },
      { id: 'ignore', title: 'Not gateway', time: { created }, tokens: { input: 10 } },
    ], now)

    expect(count).toBe(2)
    expect(worker('active')?.status).toBe('running')
    expect(worker('done')?.status).toBe('completed')
  })

  it('ignores stale empty orphan sessions', () => {
    const now = Date.parse('2026-01-01T00:30:00.000Z')
    const created = Date.parse('2026-01-01T00:00:00.000Z')

    reconcileOpenCodeSessions([
      { id: 'orphan', title: 'GW:Never ran', time: { created }, tokens: {} },
    ], now)

    expect(worker('orphan')).toBeUndefined()
  })
})
