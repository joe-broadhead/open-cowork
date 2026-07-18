import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest } from '../config.js'
import { clearWorkStateForTest, loadWorkState } from '../work-store.js'
import { runQuickstart, runQuickstartPreflight, type QuickstartGateway, type QuickstartNarrator, type QuickstartTaskView } from '../quickstart.js'

/**
 * Branch coverage for the guided first-run core (`runQuickstart`) using an
 * in-memory fake gateway (no daemon needed): daemon-not-running, scheduler
 * paused, a failed run, a timeout, and the ensureDaemon start path. The
 * daemon+faked-OpenCode acceptance path lives in quickstart.e2e.test.ts.
 */
describe.sequential('quickstart core branches', () => {
  let testDir = ''
  const okProbe = async () => ({ ok: true as const, version: 'fake' })

  function capture(): { narrator: QuickstartNarrator; lines: string[] } {
    const lines: string[] = []
    const push = (m: string) => { lines.push(m) }
    return { lines, narrator: { step: push, detail: push, success: push, warn: push } }
  }

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-quickstart-unit-'))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('preflight reports every check with a fix when OpenCode is unreachable', async () => {
    const report = await runQuickstartPreflight({ probeOpencode: async () => ({ ok: false, detail: 'refused' }) })
    expect(report.ok).toBe(false)
    expect(report.checks.map(c => c.id)).toEqual(['node', 'node-sqlite', 'config-dir', 'config', 'agent-profile', 'opencode'])
    const opencode = report.checks.find(c => c.id === 'opencode')!
    expect(opencode.ok).toBe(false)
    expect(opencode.fix).toBeTruthy()
    // The local checks pass in this environment.
    expect(report.checks.filter(c => c.id !== 'opencode').every(c => c.ok)).toBe(true)
  })

  it('stops when the daemon is not running and creates no work', async () => {
    const gateway: QuickstartGateway = {
      getHealth: async () => ({ ok: false }),
      dispatchNow: async () => ({ dispatchedTotal: 0 }),
      getTask: async () => null,
    }
    const cap = capture()
    const result = await runQuickstart({ gateway, narrator: cap.narrator, probeOpencode: okProbe })
    expect(result.outcome).toBe('daemon_not_running')
    expect(result.ok).toBe(false)
    expect(result.roadmapId).toBeUndefined()
    expect(loadWorkState(path.join(testDir, 'gateway.db')).roadmaps).toHaveLength(0)
    expect(result.nextSteps).toContain('opencode-gateway start')
  })

  it('uses ensureDaemon to start a stopped daemon, then proceeds', async () => {
    let started = false
    let health = false
    const gateway: QuickstartGateway = {
      getHealth: async () => ({ ok: health }),
      dispatchNow: async () => ({ dispatchedTotal: 1 }),
      getTask: async (): Promise<QuickstartTaskView> => ({ id: 't', status: 'done', lastRun: { id: 'run_x', status: 'passed', result: { summary: 'ok' } } }),
    }
    const result = await runQuickstart({
      gateway,
      probeOpencode: okProbe,
      pollIntervalMs: 5,
      timeoutMs: 2000,
      ensureDaemon: async () => { started = true; health = true; return true },
    })
    expect(started).toBe(true)
    expect(result.outcome).toBe('completed')
    expect(result.ok).toBe(true)
  })

  it('reports a paused scheduler without waiting, but the initiative is created', async () => {
    const gateway: QuickstartGateway = {
      getHealth: async () => ({ ok: true, uptimeSeconds: 120 }),
      dispatchNow: async () => ({ schedulerPaused: true, dispatchedTotal: 0, guidance: 'paused' }),
      getTask: async () => null,
    }
    const cap = capture()
    const result = await runQuickstart({ gateway, narrator: cap.narrator, probeOpencode: okProbe })
    expect(result.outcome).toBe('scheduler_paused')
    expect(result.roadmapId).toBeTruthy()
    expect(result.taskId).toBeTruthy()
    expect(result.taskUrl).toContain('view=task')
    expect(cap.lines.join('\n')).toMatch(/paused/i)
  })

  it('surfaces a failed run outcome with the dashboard link', async () => {
    const gateway: QuickstartGateway = {
      getHealth: async () => ({ ok: true }),
      dispatchNow: async () => ({ dispatchedTotal: 1 }),
      getTask: async (): Promise<QuickstartTaskView> => ({ id: 't', status: 'blocked', lastRun: { id: 'run_fail', status: 'failed', result: { summary: 'nope' } } }),
    }
    const result = await runQuickstart({ gateway, probeOpencode: okProbe, pollIntervalMs: 5, timeoutMs: 2000 })
    expect(result.outcome).toBe('failed')
    expect(result.ok).toBe(false)
    expect(result.runId).toBe('run_fail')
    expect(result.runUrl).toContain('view=run&id=run_fail')
  })

  it('times out cleanly when the run never reaches a terminal state', async () => {
    const gateway: QuickstartGateway = {
      getHealth: async () => ({ ok: true }),
      dispatchNow: async () => ({ dispatchedTotal: 1 }),
      getTask: async (): Promise<QuickstartTaskView> => ({ id: 't', status: 'running', activeRun: { id: 'run_slow', status: 'running', stage: 'implement' } }),
    }
    const cap = capture()
    // Hermetic clock: no real sleeping. `sleep` advances the injected `now`, so
    // the deadline is reached deterministically and instantly.
    let clock = 0
    const result = await runQuickstart({
      gateway,
      narrator: cap.narrator,
      probeOpencode: okProbe,
      pollIntervalMs: 5,
      timeoutMs: 1000,
      now: () => clock,
      sleep: async ms => { clock += ms },
    })
    expect(result.outcome).toBe('timeout')
    expect(result.ok).toBe(false)
    expect(result.taskUrl).toContain('view=task')
    expect(cap.lines.join('\n')).toMatch(/Timed out/i)
  })

  it('detects a tokenless daemon (write forbidden) and creates no work', async () => {
    const gateway: QuickstartGateway = {
      getHealth: async () => ({ ok: true }),
      dispatchNow: async () => ({ dispatchedTotal: 1 }),
      getTask: async () => null,
      checkWriteAccess: async () => ({ ok: false, status: 403 }),
    }
    const cap = capture()
    const result = await runQuickstart({ gateway, narrator: cap.narrator, probeOpencode: okProbe })
    expect(result.outcome).toBe('write_forbidden')
    expect(result.ok).toBe(false)
    expect(result.roadmapId).toBeUndefined()
    expect(loadWorkState(path.join(testDir, 'gateway.db')).roadmaps).toHaveLength(0)
    expect(cap.lines.join('\n')).toMatch(/admin token|stop.*start/i)
  })

  it('surfaces a dispatch failure with the created work and no throw', async () => {
    const gateway: QuickstartGateway = {
      getHealth: async () => ({ ok: true }),
      dispatchNow: async () => { throw new Error('HTTP 500') },
      getTask: async () => null,
    }
    const cap = capture()
    const result = await runQuickstart({ gateway, narrator: cap.narrator, probeOpencode: okProbe })
    expect(result.outcome).toBe('dispatch_failed')
    expect(result.ok).toBe(false)
    // The work was created before the dispatch failed and is surfaced.
    expect(result.roadmapId).toBeTruthy()
    expect(result.taskId).toBeTruthy()
    expect(result.taskUrl).toContain('view=task')
    expect(loadWorkState(path.join(testDir, 'gateway.db')).tasks.map(t => t.id)).toContain(result.taskId)
    expect(cap.lines.join('\n')).toMatch(/Dispatch failed/i)
  })
})
