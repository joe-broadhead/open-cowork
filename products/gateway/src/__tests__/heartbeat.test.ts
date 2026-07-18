import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearHeartbeatForTest, getHeartbeatStatus, runHeartbeatNow, startHeartbeat, stopHeartbeat } from '../heartbeat.js'
import { clearConfigCacheForTest, updateConfig, updateSchedulerConfig } from '../config.js'
import { clearWorkStateForTest, createWorkTask, loadWorkState, saveWorkState } from '../work-store.js'
import { clearWorkersForTest } from '../workers.js'
import { clearEventsForTest } from '../wakeup.js'

describe('heartbeat runtime', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-heartbeat-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  let sessionCounter = 0
  let prompts: any[] = []

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearConfigCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
    createWorkTask({ title: 'Heartbeat dispatch safety', priority: 'HIGH' }, path.join(testDir, 'gateway.db'))
    clearWorkersForTest()
    clearEventsForTest()
    clearHeartbeatForTest()
    sessionCounter = 0
    prompts = []
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    clearHeartbeatForTest()
  })

  it('skips overlapping ticks while sharing the active scheduler cycle', async () => {
    let releaseCreate!: () => void
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve })

    const first = runHeartbeatNow(client({ beforeCreate: () => createGate }), 'test')
    await flushAsync()
    const second = runHeartbeatNow(client(), 'test-overlap')

    expect(getHeartbeatStatus()).toMatchObject({ running: true, status: 'skipped', skippedTicks: 1 })
    expect(prompts).toHaveLength(0)

    releaseCreate()
    await Promise.all([first, second])

    const state = loadWorkState(path.join(testDir, 'gateway.db'))
    expect(state.runs).toHaveLength(1)
    expect(prompts).toHaveLength(1)
    const heartbeat = getHeartbeatStatus()
    expect(heartbeat).toMatchObject({ running: false, status: 'ok', skippedTicks: 1, lastSessionId: 'ses_1', lastStage: 'implement' })
    expect(heartbeat.lastSummary).toContain('Dispatched implement')
    expect(heartbeat.lastSessionUrl).toContain('/session/ses_1')
  })

  it('surfaces the latest durable scheduler session when an idle heartbeat changes no run', async () => {
    const store = path.join(testDir, 'gateway.db')
    await runHeartbeatNow(client(), 'dispatch')
    const state = loadWorkState(store)
    state.tasks[0]!.status = 'done'
    state.tasks[0]!.currentRunId = undefined
    state.tasks[0]!.currentStage = undefined
    state.runs[0]!.status = 'passed'
    state.runs[0]!.completedAt = new Date().toISOString()
    saveWorkState(state, store)
    clearHeartbeatForTest()

    await runHeartbeatNow(client(), 'idle')

    const heartbeat = getHeartbeatStatus()
    expect(heartbeat).toMatchObject({ status: 'ok', lastSessionId: 'ses_1', lastStage: 'implement' })
    expect(heartbeat.lastSummary).toContain('no change this heartbeat')
    expect(heartbeat.lastSessionUrl).toContain('/session/ses_1')

    saveWorkState({ version: 1, savedAt: new Date().toISOString(), roadmaps: [], supervisors: [], projectBindings: [], completionProposals: [], tasks: [], runs: [] }, store)
    await runHeartbeatNow(client(), 'empty')
    expect(getHeartbeatStatus().lastSessionId).toBeUndefined()
  })

  it('reschedules heartbeat cadence when scheduler pause/resume changes the effective interval', () => {
    updateConfig({ heartbeat: { intervalMs: 60000 }, scheduler: { enabled: false, intervalMs: 10000 } } as any)
    startHeartbeat()

    const paused = getHeartbeatStatus()
    expect(paused.intervalMs).toBe(60000)

    updateSchedulerConfig({ enabled: true })
    const resumed = getHeartbeatStatus()

    expect(resumed.intervalMs).toBe(10000)
    expect(Date.parse(resumed.nextDueAt!)).toBeLessThanOrEqual(Date.now() + 11000)
  })

  it('stops admission and drains an in-flight heartbeat before shutdown', async () => {
    let releaseCreate!: () => void
    const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
    startHeartbeat()
    const tick = runHeartbeatNow(client({ beforeCreate: () => createGate }), 'shutdown-test')
    await flushAsync()
    let stopped = false
    const stopping = stopHeartbeat().then(() => { stopped = true })
    await flushAsync()
    expect(stopped).toBe(false)
    releaseCreate()
    await Promise.all([tick, stopping])
    expect(getHeartbeatStatus()).toMatchObject({ enabled: false, running: false })
  })

  function client(hooks: { beforeCreate?: () => Promise<void> | void } = {}): any {
    return {
      session: {
        create: async () => {
          await hooks.beforeCreate?.()
          return { data: { id: `ses_${++sessionCounter}` } }
        },
        prompt: async (args: any) => {
          prompts.push(args)
          return { data: {} }
        },
        messages: async () => ({ data: [] }),
        get: async (args: any) => ({ data: { id: args.path.id, directory: '/tmp/project' } }),
        abort: async () => ({ data: {} }),
      },
    }
  }
})

function flushAsync(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}
