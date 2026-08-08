import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  createGatewayProgressWatchdog,
  disabledGatewayProgressWatchdogSnapshot,
  recoverGatewayStalledRun,
  resolveGatewayProgressWatchdogConfig,
  type GatewayProgressWatchdogConfig,
} from '../progress-watchdog.js'
import { parseSseFrame } from '../live.js'

describe('Gateway progress watchdog', () => {
  it('defaults and invalidates fail-closed, and gates enforce mode on operational evidence', () => {
    expect(resolveGatewayProgressWatchdogConfig({})).toMatchObject({
      requestedMode: 'off',
      mode: 'off',
      status: 'disabled',
      reason: 'mode_off',
    })
    expect(resolveGatewayProgressWatchdogConfig({
      OPENCODE_GATEWAY_PROGRESS_WATCHDOG_MODE: 'surprise',
    })).toMatchObject({ mode: 'off', status: 'invalid', reason: 'mode_invalid' })
    expect(resolveGatewayProgressWatchdogConfig({
      OPENCODE_GATEWAY_PROGRESS_WATCHDOG_MODE: 'observe',
      OPENCODE_GATEWAY_PROGRESS_WATCHDOG_SUSPECT_MS: '2000',
      OPENCODE_GATEWAY_PROGRESS_WATCHDOG_STALLED_MS: '1000',
    })).toMatchObject({ requestedMode: 'observe', mode: 'off', status: 'invalid', reason: 'bounds_invalid' })
    expect(resolveGatewayProgressWatchdogConfig({
      OPENCODE_GATEWAY_PROGRESS_WATCHDOG_MODE: 'enforce',
    })).toMatchObject({ requestedMode: 'enforce', mode: 'off', status: 'gated', reason: 'enforce_gate_incomplete' })
    expect(resolveGatewayProgressWatchdogConfig(enforceEnv())).toMatchObject({
      requestedMode: 'enforce',
      mode: 'enforce',
      status: 'valid',
      suspectAfterMs: 1_000,
      stalledAfterMs: 2_000,
    })
  })

  it('allocates no watchdog timer or recovery surface while off', () => {
    const setIntervalFn = vi.fn() as unknown as typeof setInterval
    const controller = createGatewayProgressWatchdog({
      config: resolveGatewayProgressWatchdogConfig({}),
      findRunBySessionId: () => undefined,
      findRunsBySessionIds: () => [],
      recover: vi.fn(),
      setIntervalFn,
    })

    expect(controller).toBeNull()
    expect(setIntervalFn).not.toHaveBeenCalled()
    expect(disabledGatewayProgressWatchdogSnapshot()).toEqual({
      mode: 'off',
      status: 'disabled',
      generation: 0,
      counts: { healthy: 0, waiting: 0, suspect: 0, stalled: 0 },
      samples: [],
      truncated: false,
    })
  })

  it('does not let duplicate, out-of-order, poll, read, health, or passive lease activity reset progress', async () => {
    let now = 0
    const metrics: string[] = []
    const recover = vi.fn()
    const run = activeRun('run_one', 'ses_one')
    const controller = createGatewayProgressWatchdog({
      config: observeConfig(),
      findRunBySessionId: sessionId => sessionId === run.sessionId ? run : undefined,
      findRunsBySessionIds: () => [run],
      recover,
      now: () => now,
      runtimeGeneration: 7,
      onMetric: outcome => metrics.push(outcome),
      ...fakeTimers(),
    })!

    controller.observe(progressEvent('session.next.prompt.admitted', run.sessionId, { sequence: 10 }))
    now = 900
    controller.observe(progressEvent('session.next.prompt.admitted', run.sessionId, { sequence: 10 }))
    controller.observe(progressEvent('message.part.delta', run.sessionId, { sequence: 9, delta: 'stale' }))
    controller.observe(progressEvent('session_update', run.sessionId))
    controller.observe(progressEvent('session.list', run.sessionId))
    controller.observe(progressEvent('global.health', run.sessionId))
    controller.observe(progressEvent('task.run.lease_renewed', run.sessionId, {
      runId: run.id,
      leaseOwner: run.leaseOwner,
      leaseExpiresAt: run.leaseExpiresAt,
    }))
    now = 1_001
    await controller.sweep()

    expect(controller.snapshot()).toMatchObject({
      mode: 'observe',
      generation: 7,
      counts: { healthy: 0, waiting: 0, suspect: 1, stalled: 0 },
    })
    expect(metrics).toEqual(['suspect'])
    expect(recover).not.toHaveBeenCalled()

    now = 2_001
    await controller.sweep()
    expect(metrics).toEqual(['suspect', 'stalled'])
    expect(recover).not.toHaveBeenCalled()
    controller.stop()
  })

  it('keeps a run tracked across recoverable OpenCode session errors', async () => {
    let now = 0
    const run = activeRun('run_recoverable_error', 'ses_recoverable_error')
    const controller = createGatewayProgressWatchdog({
      config: observeConfig(),
      findRunBySessionId: () => run,
      findRunsBySessionIds: () => [run],
      recover: vi.fn(),
      now: () => now,
      ...fakeTimers(),
    })!

    controller.observe(progressEvent('session.next.prompt.admitted', run.sessionId))
    now = 900
    controller.observe(progressEvent('session.error', run.sessionId, {
      error: { message: 'context overflow; compacting' },
    }))
    now = 1_001
    expect(controller.snapshot().counts.suspect).toBe(1)

    controller.observe(progressEvent('session.next.compaction.started', run.sessionId))
    now = 1_100
    expect(controller.snapshot().counts.healthy).toBe(1)
    expect(controller.snapshot().samples[0]?.ageMs).toBe(99)
    controller.stop()
  })

  it('rejects a replayed durable terminal below the current prompt admission sequence', () => {
    let now = 0
    const run = activeRun('run_replayed_terminal', 'ses_replayed_terminal')
    const findRunBySessionId = vi.fn().mockReturnValue(run)
    const controller = createGatewayProgressWatchdog({
      config: observeConfig(),
      findRunBySessionId,
      findRunsBySessionIds: () => [run],
      recover: vi.fn(),
      now: () => now,
      ...fakeTimers(),
    })!

    controller.observe(progressEvent('session.next.prompt.admitted', run.sessionId, { sequence: 7 }))
    now = 500
    controller.observe(progressEvent('session.next.step.failed', run.sessionId, { sequence: 6 }))
    now = 2_001
    expect(controller.snapshot().counts.stalled).toBe(1)

    controller.observe(progressEvent('session.next.step.failed', run.sessionId, { sequence: 8 }))
    expect(controller.snapshot().counts).toEqual({ healthy: 0, waiting: 0, suspect: 0, stalled: 0 })
    expect(findRunBySessionId).toHaveBeenCalledOnce()
    controller.stop()
  })

  it('filters non-progress traffic before storage and caches bounded run ownership for deltas', () => {
    const run = activeRun('run_hot', 'ses_hot')
    const findRunBySessionId = vi.fn().mockReturnValue(run)
    const controller = createGatewayProgressWatchdog({
      config: observeConfig({ sweepMs: 10_000 }),
      findRunBySessionId,
      findRunsBySessionIds: () => [run],
      recover: vi.fn(),
      now: () => 100,
      ...fakeTimers(),
    })!

    controller.observe(progressEvent('session.list', run.sessionId))
    controller.observe(progressEvent('global.health', run.sessionId))
    expect(findRunBySessionId).not.toHaveBeenCalled()
    for (let index = 0; index < 100; index++) {
      controller.observe(progressEvent('message.part.delta', run.sessionId, { sequence: index, delta: String(index) }))
    }

    expect(findRunBySessionId).toHaveBeenCalledOnce()
    expect(controller.snapshot().counts.healthy).toBe(1)
    controller.stop()
  })

  it('reads the pinned OpenCode GlobalEvent wire envelope emitted by /global/event', () => {
    let now = 0
    const run = activeRun('run_global_event', 'ses_global_event')
    const controller = createGatewayProgressWatchdog({
      config: observeConfig(),
      findRunBySessionId: () => run,
      findRunsBySessionIds: () => [run],
      recover: vi.fn(),
      now: () => now,
      ...fakeTimers(),
    })!
    const wireEvent = (completed: number) => parseSseFrame(`data: ${JSON.stringify({
      directory: '/private/customer/project',
      project: 'project-secret',
      workspace: 'workspace-secret',
      payload: {
        id: `event-${completed}`,
        type: 'session.next.tool.progress',
        properties: {
          sessionID: run.sessionId,
          assistantMessageID: 'assistant-1',
          callID: 'call-1',
          content: [{ type: 'text', text: `processed ${completed} of 3` }],
          structured: { completed, total: 3 },
        },
      },
    })}`)!

    const first = wireEvent(1)
    expect(first?.type).toBe('message')
    controller.observe(first)
    now = 900
    controller.observe(wireEvent(2))
    now = 1_100

    expect(controller.snapshot().counts.healthy).toBe(1)
    expect(controller.snapshot().samples[0]?.ageMs).toBe(200)
    expect(JSON.stringify(controller.snapshot())).not.toContain('customer')
    controller.stop()
  })

  it('treats distinct native calls, shells, and assistant phases as progress without accepting exact replays', async () => {
    let now = 0
    const run = activeRun('run_native_identity', 'ses_native_identity')
    const controller = createGatewayProgressWatchdog({
      config: observeConfig(),
      findRunBySessionId: () => run,
      findRunsBySessionIds: () => [run],
      recover: vi.fn(),
      now: () => now,
      ...fakeTimers(),
    })!

    controller.observe(progressEvent('session.next.tool.called', run.sessionId, {
      assistantMessageID: 'assistant-1',
      callID: 'call-1',
      tool: 'read',
    }))
    now = 900
    controller.observe(progressEvent('session.next.tool.called', run.sessionId, {
      assistantMessageID: 'assistant-1',
      callID: 'call-2',
      tool: 'read',
    }))
    now = 1_100
    expect(controller.snapshot().counts.healthy).toBe(1)
    expect(controller.snapshot().samples[0]?.ageMs).toBe(200)

    controller.observe(progressEvent('session.next.shell.started', run.sessionId, {
      assistantMessageID: 'assistant-2',
      callID: 'shell-1',
      command: 'pnpm test',
    }))
    now = 2_000
    controller.observe(progressEvent('session.next.shell.started', run.sessionId, {
      assistantMessageID: 'assistant-2',
      callID: 'shell-2',
      command: 'pnpm test',
    }))
    now = 2_200
    expect(controller.snapshot().samples[0]?.ageMs).toBe(200)

    controller.observe(progressEvent('session.next.step.started', run.sessionId, {
      assistantMessageID: 'assistant-3',
    }))
    now = 3_100
    controller.observe(progressEvent('session.next.step.started', run.sessionId, {
      assistantMessageID: 'assistant-4',
    }))
    now = 3_300
    expect(controller.snapshot().samples[0]?.ageMs).toBe(200)
    now = 3_900
    controller.observe(progressEvent('session.next.step.started', run.sessionId, {
      assistantMessageID: 'assistant-4',
    }))
    now = 4_101
    await controller.sweep()

    expect(controller.snapshot().counts.suspect).toBe(1)
    expect(controller.snapshot().samples[0]?.ageMs).toBe(1_001)
    controller.stop()
  })

  it('advances evolving tool progress content and structured state but ignores an identical replay', async () => {
    let now = 0
    const run = activeRun('run_tool_progress', 'ses_tool_progress')
    const controller = createGatewayProgressWatchdog({
      config: observeConfig(),
      findRunBySessionId: () => run,
      findRunsBySessionIds: () => [run],
      recover: vi.fn(),
      now: () => now,
      ...fakeTimers(),
    })!
    const first = {
      assistantMessageID: 'assistant-1',
      callID: 'call-1',
      content: [{ type: 'text', text: 'processed 1 of 3' }],
      structured: { completed: 1, total: 3 },
    }

    controller.observe(progressEvent('session.next.tool.progress', run.sessionId, first))
    now = 900
    controller.observe(progressEvent('session.next.tool.progress', run.sessionId, {
      ...first,
      content: [{ type: 'text', text: 'processed 2 of 3' }],
      structured: { completed: 2, total: 3 },
    }))
    now = 1_100
    expect(controller.snapshot().samples[0]?.ageMs).toBe(200)

    const second = {
      ...first,
      content: [{ type: 'text', text: 'processed 2 of 3' }],
      structured: { completed: 2, total: 3 },
    }
    now = 1_500
    controller.observe(progressEvent('session.next.tool.progress', run.sessionId, second))
    now = 1_901
    expect(controller.snapshot().counts.suspect).toBe(1)
    expect(controller.snapshot().samples[0]?.ageMs).toBe(1_001)
    controller.stop()
  })

  it('advances changed output deltas while rejecting an exact delta replay', () => {
    let now = 0
    const run = activeRun('run_output_delta', 'ses_output_delta')
    const controller = createGatewayProgressWatchdog({
      config: observeConfig(),
      findRunBySessionId: () => run,
      findRunsBySessionIds: () => [run],
      recover: vi.fn(),
      now: () => now,
      ...fakeTimers(),
    })!
    const first = {
      messageID: 'assistant-1',
      partID: 'text-1',
      field: 'text',
      delta: 'alpha',
    }

    controller.observe(progressEvent('message.part.delta', run.sessionId, first))
    now = 900
    controller.observe(progressEvent('message.part.delta', run.sessionId, { ...first, delta: 'bravo' }))
    now = 1_100
    expect(controller.snapshot().samples[0]?.ageMs).toBe(200)
    now = 1_500
    controller.observe(progressEvent('message.part.delta', run.sessionId, { ...first, delta: 'bravo' }))
    now = 1_901
    expect(controller.snapshot().counts.suspect).toBe(1)
    expect(controller.snapshot().samples[0]?.ageMs).toBe(1_001)
    controller.stop()
  })

  it('uses the pinned GlobalEvent id to distinguish identical output chunks from an exact replay', () => {
    let now = 0
    const run = activeRun('run_native_event_id', 'ses_native_event_id')
    const controller = createGatewayProgressWatchdog({
      config: observeConfig(),
      findRunBySessionId: () => run,
      findRunsBySessionIds: () => [run],
      recover: vi.fn(),
      now: () => now,
      ...fakeTimers(),
    })!
    const wireDelta = (id: string) => parseSseFrame(`data: ${JSON.stringify({
      directory: '/workspace',
      payload: {
        id,
        type: 'message.part.delta',
        properties: {
          sessionID: run.sessionId,
          messageID: 'assistant-1',
          partID: 'text-1',
          field: 'text',
          delta: ' ',
        },
      },
    })}`)!

    controller.observe(wireDelta('event-1'))
    now = 900
    controller.observe(wireDelta('event-2'))
    now = 1_100
    expect(controller.snapshot().samples[0]?.ageMs).toBe(200)

    now = 1_500
    controller.observe(wireDelta('event-2'))
    now = 1_901
    expect(controller.snapshot().counts.suspect).toBe(1)
    expect(controller.snapshot().samples[0]?.ageMs).toBe(1_001)
    controller.stop()
  })

  it('reconciles the full bounded tracked set through one batch lookup per sweep', async () => {
    let now = 0
    const runs = Array.from({ length: 10 }, (_, index) => activeRun(`run_batch_${index}`, `ses_batch_${index}`))
    const findRunBySessionId = vi.fn()
    const findRunsBySessionIds = vi.fn((sessionIds: readonly string[]) =>
      runs.filter(run => sessionIds.includes(run.sessionId)))
    const controller = createGatewayProgressWatchdog({
      config: observeConfig({ maxEntries: runs.length }),
      findRunBySessionId,
      findRunsBySessionIds,
      recover: vi.fn(),
      now: () => now,
      ...fakeTimers(),
    })!
    for (const run of runs) controller.admit(run)

    now = 500
    await controller.sweep()

    expect(findRunsBySessionIds).toHaveBeenCalledOnce()
    expect(findRunsBySessionIds.mock.calls[0]?.[0]).toHaveLength(runs.length)
    expect(findRunBySessionId).not.toHaveBeenCalled()
    expect(controller.snapshot().counts.healthy).toBe(runs.length)
    controller.stop()
  })

  it.each(['passed', 'failed', 'errored'] as const)(
    'evicts a tracked run when durable work reaches missed terminal status %s',
    async status => {
      let now = 0
      const observedRun = activeRun(`run_missed_${status}`, `ses_missed_${status}`)
      let durableRun = { ...observedRun, status: observedRun.status as typeof observedRun.status | typeof status }
      const recover = vi.fn()
      const controller = createGatewayProgressWatchdog({
        config: enforceConfig(),
        findRunBySessionId: () => durableRun,
        findRunsBySessionIds: () => [durableRun],
        recover,
        now: () => now,
        ...fakeTimers(),
      })!

      controller.observe(progressEvent('session.next.prompt.admitted', observedRun.sessionId))
      durableRun = { ...observedRun, status }
      now = 2_001
      await controller.sweep()

      expect(controller.snapshot().counts).toEqual({ healthy: 0, waiting: 0, suspect: 0, stalled: 0 })
      expect(recover).not.toHaveBeenCalled()
      controller.stop()
    },
  )

  it('evicts a replaced durable run before it can surface a stale stalled decision', async () => {
    let now = 0
    const observedRun = activeRun('run_replaced_old', 'ses_replaced')
    let durableRun = observedRun
    const recover = vi.fn()
    const controller = createGatewayProgressWatchdog({
      config: enforceConfig(),
      findRunBySessionId: () => durableRun,
      findRunsBySessionIds: () => [durableRun],
      recover,
      now: () => now,
      ...fakeTimers(),
    })!

    controller.observe(progressEvent('session.next.prompt.admitted', observedRun.sessionId))
    durableRun = {
      ...activeRun('run_replaced_new', observedRun.sessionId),
      attempt: observedRun.attempt + 1,
      schedulerGeneration: 'replacement-generation',
    }
    now = 2_001
    await controller.sweep()

    expect(controller.snapshot().counts.stalled).toBe(0)
    expect(recover).not.toHaveBeenCalled()
    controller.stop()
  })

  it('keeps explicit waits non-stalled and isolates terminal state by run', () => {
    let now = 0
    const runs = new Map([
      ['ses_waiting', activeRun('run_waiting', 'ses_waiting')],
      ['ses_working', activeRun('run_working', 'ses_working')],
    ])
    const controller = createGatewayProgressWatchdog({
      config: observeConfig({ maxSnapshotEntries: 1 }),
      findRunBySessionId: sessionId => runs.get(sessionId),
      findRunsBySessionIds: sessionIds => sessionIds.flatMap(sessionId => runs.get(sessionId) || []),
      recover: vi.fn(),
      now: () => now,
      runtimeGeneration: 11,
      ...fakeTimers(),
    })!

    controller.observe(progressEvent('question.asked', 'ses_waiting'))
    controller.observe(progressEvent('session.next.prompt.admitted', 'ses_working'))
    now = 20_000
    expect(controller.snapshot()).toMatchObject({
      counts: { healthy: 0, waiting: 1, suspect: 0, stalled: 1 },
      samples: [expect.objectContaining({ state: 'stalled', generation: 11 })],
      truncated: true,
    })

    controller.observe(progressEvent('session.idle', 'ses_working'))
    expect(controller.snapshot().counts).toEqual({ healthy: 0, waiting: 1, suspect: 0, stalled: 0 })
    controller.observe(progressEvent('question.replied', 'ses_waiting'))
    expect(controller.snapshot().counts).toEqual({ healthy: 1, waiting: 0, suspect: 0, stalled: 0 })
    controller.stop()
  })

  it('uses a monotonic clock for retry waits despite wall-clock jumps', () => {
    let monotonicNow = 100
    let wallNow = Date.parse('2026-08-02T12:00:00.000Z')
    const run = activeRun('run_retry_clock', 'ses_retry_clock')
    const controller = createGatewayProgressWatchdog({
      config: observeConfig(),
      findRunBySessionId: () => run,
      findRunsBySessionIds: () => [run],
      recover: vi.fn(),
      now: () => monotonicNow,
      wallNow: () => wallNow,
      ...fakeTimers(),
    })!

    controller.observe(progressEvent('session.status', run.sessionId, {
      status: { type: 'retry', next: wallNow + 5_000 },
    }))
    wallNow += 60 * 60_000
    monotonicNow = 5_099
    expect(controller.snapshot().counts.waiting).toBe(1)

    monotonicNow = 5_100
    expect(controller.snapshot().counts.healthy).toBe(1)
    monotonicNow = 7_101
    expect(controller.snapshot().counts.stalled).toBe(1)
    controller.stop()
  })

  it('enforces only stalled decisions and publishes a bounded identity-free snapshot', async () => {
    let now = 0
    const metrics: string[] = []
    const audits: Array<Record<string, unknown>> = []
    const secretRun = activeRun('run_secret_customer', 'ses_secret_customer')
    const recover = vi.fn().mockResolvedValue('recovered')
    const controller = createGatewayProgressWatchdog({
      config: enforceConfig(),
      findRunBySessionId: sessionId => sessionId === secretRun.sessionId ? secretRun : undefined,
      findRunsBySessionIds: () => [secretRun],
      recover,
      now: () => now,
      runtimeGeneration: 19,
      onMetric: outcome => metrics.push(outcome),
      onDecision: input => audits.push(input),
      ...fakeTimers(),
    })!

    controller.observe(progressEvent('message.part.delta', secretRun.sessionId, { delta: 'token=do-not-expose' }))
    now = 2_001
    await controller.sweep()

    expect(recover).toHaveBeenCalledOnce()
    expect(metrics).toEqual(['stalled', 'enforced', 'recovered'])
    expect(audits.map(row => row['outcome'])).toEqual(['stalled', 'enforced', 'recovered'])
    expect(controller.snapshot().counts).toEqual({ healthy: 0, waiting: 0, suspect: 0, stalled: 0 })
    const serialized = JSON.stringify(controller.snapshot())
    expect(serialized).not.toContain('run_secret_customer')
    expect(serialized).not.toContain('ses_secret_customer')
    expect(serialized).not.toContain('owner-secret')
    expect(serialized).not.toContain('generation-secret')
    expect(serialized).not.toContain('do-not-expose')
    controller.stop()
  })

  it('seeds an active run once after restart without treating repeated inventory as progress', async () => {
    let now = 0
    const run = activeRun('run_restart', 'ses_restart')
    const recover = vi.fn().mockResolvedValue('recovered')
    const controller = createGatewayProgressWatchdog({
      config: enforceConfig(),
      findRunBySessionId: vi.fn().mockReturnValue(run),
      findRunsBySessionIds: () => [run],
      recover,
      now: () => now,
      ...fakeTimers(),
    })!

    controller.admit(run)
    now = 1_500
    controller.admit(run)
    now = 2_001
    await controller.sweep()

    expect(recover).toHaveBeenCalledOnce()
    controller.stop()
  })

  it('retires a fenced-stale decision when the next durable sweep sees replacement ownership', async () => {
    let now = 0
    const metrics: string[] = []
    const observedRun = activeRun('run_stale', 'ses_stale')
    let currentRun = { ...observedRun }
    const recoverStalledRun = vi.fn()
    const abortSession = vi.fn()
    const recover = vi.fn(decision => recoverGatewayStalledRun(decision, {
      canWrite: () => true,
      findRunById: () => currentRun,
      recoverStalledRun,
      abortSession,
    }))
    const controller = createGatewayProgressWatchdog({
      config: enforceConfig(),
      findRunBySessionId: () => observedRun,
      findRunsBySessionIds: vi.fn()
        .mockReturnValueOnce([observedRun])
        .mockImplementation(() => [currentRun]),
      recover,
      now: () => now,
      onMetric: outcome => metrics.push(outcome),
      ...fakeTimers(),
    })!

    controller.observe(progressEvent('session.next.prompt.admitted', observedRun.sessionId))
    currentRun = { ...observedRun, leaseOwner: 'transferred-owner', schedulerGeneration: 'transferred-generation' }
    now = 2_001
    await controller.sweep()
    await controller.sweep()

    expect(recover).toHaveBeenCalledOnce()
    expect(recoverStalledRun).not.toHaveBeenCalled()
    expect(abortSession).not.toHaveBeenCalled()
    expect(metrics).toEqual(['stalled', 'enforced', 'fenced_stale'])
    expect(controller.snapshot().counts).toEqual({ healthy: 1, waiting: 0, suspect: 0, stalled: 0 })
    controller.stop()
  })

  it('retries the same fenced decision after transient leadership loss and removes recovered state immediately', async () => {
    let now = 0
    let canWrite = false
    let durableActive = true
    const run = activeRun('run_writer_retry', 'ses_writer_retry')
    const recoverStalledRun = vi.fn().mockImplementation(() => {
      durableActive = false
      return { applied: true, abortedSessionId: run.sessionId }
    })
    const abortSession = vi.fn().mockResolvedValue(undefined)
    const recover = vi.fn(decision => recoverGatewayStalledRun(decision, {
      canWrite: () => canWrite,
      findRunById: () => run,
      recoverStalledRun,
      abortSession,
    }))
    const controller = createGatewayProgressWatchdog({
      config: enforceConfig(),
      findRunBySessionId: () => run,
      findRunsBySessionIds: () => durableActive ? [run] : [],
      recover,
      now: () => now,
      ...fakeTimers(),
    })!

    controller.observe(progressEvent('session.next.prompt.admitted', run.sessionId))
    now = 2_001
    await controller.sweep()
    expect(recover).toHaveBeenCalledOnce()
    expect(abortSession).not.toHaveBeenCalled()

    canWrite = true
    now = 3_001
    await controller.sweep()

    expect(recover).toHaveBeenCalledTimes(2)
    expect(abortSession).toHaveBeenCalledOnce()
    expect(recoverStalledRun).toHaveBeenCalledOnce()
    expect(controller.snapshot().counts).toEqual({ healthy: 0, waiting: 0, suspect: 0, stalled: 0 })
    controller.stop()
  })

  it('does not let an awaited recovery delete newer progress from the same execution generation', async () => {
    let now = 0
    let durableActive = true
    let resolveRecovery!: (outcome: 'recovered') => void
    const recoveryResult = new Promise<'recovered'>(resolve => { resolveRecovery = resolve })
    const run = activeRun('run_recovery_race', 'ses_recovery_race')
    const recover = vi.fn(() => recoveryResult)
    const controller = createGatewayProgressWatchdog({
      config: enforceConfig(),
      findRunBySessionId: () => run,
      findRunsBySessionIds: () => durableActive ? [run] : [],
      recover,
      now: () => now,
      ...fakeTimers(),
    })!

    controller.observe(progressEvent('session.next.prompt.admitted', run.sessionId))
    now = 2_001
    const sweep = controller.sweep()
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())

    now = 2_100
    controller.observe(progressEvent('message.part.delta', run.sessionId, { delta: 'new output' }))
    durableActive = false
    resolveRecovery('recovered')
    await sweep

    expect(controller.snapshot().counts.healthy).toBe(1)
    await controller.sweep()
    expect(controller.snapshot().counts).toEqual({ healthy: 0, waiting: 0, suspect: 0, stalled: 0 })
    expect(recover).toHaveBeenCalledOnce()
    controller.stop()
  })

  it('keeps failed enforcement retryable with exponential backoff capped at five minutes', async () => {
    let now = 0
    const run = activeRun('run_retry_bound', 'ses_retry_bound')
    const recover = vi.fn().mockResolvedValue('failed')
    const controller = createGatewayProgressWatchdog({
      config: enforceConfig(),
      findRunBySessionId: () => run,
      findRunsBySessionIds: () => [run],
      recover,
      now: () => now,
      ...fakeTimers(),
    })!

    controller.observe(progressEvent('session.next.prompt.admitted', run.sessionId))
    for (const dueAt of [2_001, 3_001, 5_001, 9_001, 17_001, 33_001, 65_001, 129_001, 257_001, 513_001]) {
      now = dueAt
      await controller.sweep()
    }
    expect(recover).toHaveBeenCalledTimes(10)

    now = 813_000
    await controller.sweep()
    expect(recover).toHaveBeenCalledTimes(10)
    now = 813_001
    await controller.sweep()
    expect(recover).toHaveBeenCalledTimes(11)
    expect(controller.snapshot().counts.stalled).toBe(1)
    controller.stop()
  })

  it('aborts only the exact fenced Session before making durable work dispatchable', async () => {
    const run = activeRun('run_exact', 'ses_exact')
    const recoverStalledRun = vi.fn().mockReturnValue({ applied: true, abortedSessionId: run.sessionId })
    const abortSession = vi.fn().mockResolvedValue(undefined)
    const decision = stalledDecision(run)

    await expect(recoverGatewayStalledRun(decision, {
      canWrite: () => true,
      findRunById: () => run,
      recoverStalledRun,
      abortSession,
    })).resolves.toBe('recovered')
    expect(abortSession).toHaveBeenCalledOnce()
    expect(abortSession).toHaveBeenCalledWith(run.sessionId)
    expect(recoverStalledRun).toHaveBeenCalledWith({
      runId: run.id,
      leaseOwner: run.leaseOwner,
      schedulerGeneration: run.schedulerGeneration,
    })
    expect(abortSession.mock.invocationCallOrder[0]).toBeLessThan(recoverStalledRun.mock.invocationCallOrder[0]!)

    let decisionCurrent = true
    abortSession.mockReset().mockImplementationOnce(async () => { decisionCurrent = false })
    recoverStalledRun.mockClear()
    await expect(recoverGatewayStalledRun(decision, {
      canWrite: () => true,
      isDecisionCurrent: () => decisionCurrent,
      findRunById: () => run,
      recoverStalledRun,
      abortSession,
    })).resolves.toBe('fenced_stale')
    expect(recoverStalledRun).not.toHaveBeenCalled()

    abortSession.mockReset().mockRejectedValueOnce(new Error('transport unavailable'))
    recoverStalledRun.mockClear()
    await expect(recoverGatewayStalledRun(decision, {
      canWrite: () => true,
      findRunById: () => run,
      recoverStalledRun,
      abortSession,
    })).resolves.toBe('failed')
    expect(recoverStalledRun).not.toHaveBeenCalled()
  })

  it('never aborts when writer, lease owner, generation, or lease freshness is stale', async () => {
    const run = activeRun('run_fence', 'ses_fence')
    const decision = stalledDecision(run)
    const abortSession = vi.fn()
    const recoverStalledRun = vi.fn()
    const staleRuns = [
      { ...run, leaseOwner: 'owner-transferred' },
      { ...run, schedulerGeneration: 'generation-transferred' },
      { ...run, leaseExpiresAt: '2000-01-01T00:00:00.000Z' },
    ]

    for (const current of staleRuns) {
      await expect(recoverGatewayStalledRun(decision, {
        canWrite: () => true,
        findRunById: () => current,
        recoverStalledRun,
        abortSession,
        now: () => Date.parse('2026-01-01T00:00:00.000Z'),
      })).resolves.toBe('fenced_stale')
    }
    let checks = 0
    await expect(recoverGatewayStalledRun(decision, {
      canWrite: () => ++checks === 1,
      findRunById: () => run,
      recoverStalledRun,
      abortSession,
    })).resolves.toBe('fenced_stale')
    expect(abortSession).not.toHaveBeenCalled()
    expect(recoverStalledRun).not.toHaveBeenCalled()
  })
})

function activeRun(id: string, sessionId: string) {
  return {
    id,
    sessionId,
    status: 'running' as const,
    attempt: 1,
    leaseOwner: 'owner-secret',
    leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    schedulerGeneration: 'generation-secret',
  }
}

function progressEvent(type: string, sessionID: string, properties: Record<string, unknown> = {}) {
  return { type, payload: { properties: { sessionID, ...properties } } }
}

function stalledDecision(run: ReturnType<typeof activeRun>) {
  return {
    scopeId: run.id,
    sessionId: run.sessionId,
    runId: run.id,
    runtimeGeneration: 1,
    executionGeneration: 1,
    leaseOwner: run.leaseOwner,
    leaseEpoch: createHash('sha256').update(run.schedulerGeneration).digest('hex'),
    state: 'stalled' as const,
    source: 'output_advance' as const,
    ageMs: 2_001,
    revision: 1,
  }
}

function observeConfig(overrides: Partial<GatewayProgressWatchdogConfig> = {}): GatewayProgressWatchdogConfig {
  return {
    requestedMode: 'observe',
    mode: 'observe',
    status: 'valid',
    reason: 'configured',
    suspectAfterMs: 1_000,
    stalledAfterMs: 2_000,
    sweepMs: 250,
    maxEntries: 10,
    maxSnapshotEntries: 10,
    ...overrides,
  }
}

function enforceConfig(): GatewayProgressWatchdogConfig {
  return { ...observeConfig(), requestedMode: 'enforce', mode: 'enforce' }
}

function enforceEnv(): NodeJS.ProcessEnv {
  return {
    OPENCODE_GATEWAY_PROGRESS_WATCHDOG_MODE: 'enforce',
    OPENCODE_GATEWAY_PROGRESS_WATCHDOG_SUSPECT_MS: '1000',
    OPENCODE_GATEWAY_PROGRESS_WATCHDOG_STALLED_MS: '2000',
    OPENCODE_GATEWAY_PROGRESS_WATCHDOG_SWEEP_MS: '250',
    OPENCODE_GATEWAY_PROGRESS_WATCHDOG_OBSERVE_EVIDENCE_REF: 'evidence:observe-window',
    OPENCODE_GATEWAY_PROGRESS_WATCHDOG_OPERATOR_OWNER: 'gateway-operations',
    OPENCODE_GATEWAY_PROGRESS_WATCHDOG_ROLLBACK_MODE: 'observe',
  }
}

function fakeTimers() {
  return {
    setIntervalFn: ((callback: () => void) => ({ unref() {}, callback })) as unknown as typeof setInterval,
    clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
  }
}
