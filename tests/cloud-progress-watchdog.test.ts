import test from 'node:test'
import assert from 'node:assert/strict'

import type { ProgressWatchdogObservation } from '@open-cowork/shared/progress-watchdog'
import {
  createCloudProgressWatchdog,
  emptyCloudProgressWatchdogSnapshot,
  resolveCloudProgressWatchdogConfig,
  type CloudProgressWatchdogDecisionEvent,
} from '../packages/cloud-server/src/progress-watchdog.ts'

function observation(
  overrides: Partial<ProgressWatchdogObservation> = {},
): ProgressWatchdogObservation {
  return {
    scopeId: 'tenant-secret',
    sessionId: 'session-secret',
    runId: 'run-secret',
    runtimeGeneration: 3,
    executionGeneration: 2,
    leaseOwner: 'worker-secret',
    leaseEpoch: 'epoch-secret',
    source: 'durable_sequence',
    disposition: 'running',
    sequence: 1,
    observedAtMs: 100,
    ...overrides,
  }
}

test('cloud progress watchdog configuration fails closed and gates enforcement on rollout evidence', () => {
  assert.deepEqual(resolveCloudProgressWatchdogConfig({}), {
    mode: 'off',
    requestedMode: 'off',
    configStatus: 'valid',
    configReason: 'default_off',
    suspectAfterMs: 120_000,
    stalledAfterMs: 300_000,
    sweepIntervalMs: 5_000,
    maxEntries: 100,
    maxSnapshotEntries: 50,
  })
  assert.equal(resolveCloudProgressWatchdogConfig({
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'sometimes',
  }).mode, 'off')
  assert.equal(resolveCloudProgressWatchdogConfig({
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'observe',
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_SUSPECT_MS: '500',
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_STALLED_MS: '100',
  }).configStatus, 'invalid')
  for (const belowSafeMinimum of [
    { OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_SUSPECT_MS: '999' },
    { OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_STALLED_MS: '1999' },
    { OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_SWEEP_MS: '249' },
  ]) {
    assert.equal(resolveCloudProgressWatchdogConfig({
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'observe',
      ...belowSafeMinimum,
    }).configStatus, 'invalid')
  }
  for (const oversized of [
    { OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MAX_ENTRIES: '10001' },
    { OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MAX_SNAPSHOT_ENTRIES: '101' },
    { OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_SWEEP_MS: '86400001' },
    { OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_STALLED_MS: '86400001' },
  ]) {
    assert.equal(resolveCloudProgressWatchdogConfig({
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'observe',
      ...oversized,
    }).configStatus, 'invalid')
  }

  const gated = resolveCloudProgressWatchdogConfig({
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'enforce',
  })
  assert.equal(gated.mode, 'off')
  assert.equal(gated.requestedMode, 'enforce')
  assert.equal(gated.configStatus, 'gated')

  const enabled = resolveCloudProgressWatchdogConfig({
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'enforce',
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_OBSERVE_EVIDENCE_REF: 'canary-2026-08',
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_OPERATOR_OWNER: 'runtime-oncall',
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_ROLLBACK_MODE: 'observe',
  })
  assert.equal(enabled.mode, 'enforce')
  assert.equal(enabled.configStatus, 'valid')
})

test('off mode allocates no watchdog timer and reports an empty privacy-safe snapshot', async () => {
  let timers = 0
  const watchdog = createCloudProgressWatchdog({
    config: resolveCloudProgressWatchdogConfig({}),
    setInterval() {
      timers += 1
      throw new Error('off mode must not schedule')
    },
  })

  assert.equal(timers, 0)
  assert.deepEqual(emptyCloudProgressWatchdogSnapshot(), watchdog.snapshot())
  assert.equal(watchdog.observe(observation()), false)
  await watchdog.sweep()
  assert.deepEqual(watchdog.snapshot(), {
    mode: 'off',
    requestedMode: 'off',
    configStatus: 'valid',
    configReason: 'default_off',
    counts: { healthy: 0, waiting: 0, suspect: 0, stalled: 0 },
    samples: [],
    truncated: false,
  })
  await watchdog.close()
})

test('observe mode uses one unref timer, emits decisions once, and never mutates runtime state', async () => {
  let nowMs = 100
  let timerCount = 0
  let unrefCount = 0
  let clearCount = 0
  let recoveries = 0
  const decisions: CloudProgressWatchdogDecisionEvent[] = []
  const watchdog = createCloudProgressWatchdog({
    config: {
      ...resolveCloudProgressWatchdogConfig({
        OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'observe',
      }),
      suspectAfterMs: 50,
      stalledAfterMs: 100,
      sweepIntervalMs: 10,
    },
    now: () => nowMs,
    setInterval() {
      timerCount += 1
      return { unref() { unrefCount += 1 } } as ReturnType<typeof setInterval>
    },
    clearInterval() { clearCount += 1 },
    onDecision(event) { decisions.push(event) },
    async recover() {
      recoveries += 1
      return 'recovered'
    },
  })

  assert.equal(timerCount, 1)
  assert.equal(unrefCount, 1)
  assert.equal(watchdog.observe(observation()), true)
  nowMs = 150
  await watchdog.sweep()
  await watchdog.sweep()
  nowMs = 200
  await watchdog.sweep()

  assert.deepEqual(decisions.map((event) => [event.decision.state, event.outcome]), [
    ['suspect', 'observed'],
    ['stalled', 'observed'],
  ])
  assert.equal(recoveries, 0)
  assert.doesNotMatch(JSON.stringify(watchdog.snapshot()), /tenant-secret|session-secret|run-secret|worker-secret|epoch-secret/)
  await watchdog.close()
  assert.equal(clearCount, 1)
})

test('enforce mode recovers one unchanged stalled revision and reports the fenced outcome', async () => {
  let nowMs = 100
  let recoveries = 0
  const outcomes: string[] = []
  const config = resolveCloudProgressWatchdogConfig({
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'enforce',
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_OBSERVE_EVIDENCE_REF: 'canary-2026-08',
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_OPERATOR_OWNER: 'runtime-oncall',
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_ROLLBACK_MODE: 'off',
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_SUSPECT_MS: '1000',
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_STALLED_MS: '2000',
    OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_SWEEP_MS: '250',
  })
  const watchdog = createCloudProgressWatchdog({
    config,
    now: () => nowMs,
    setInterval: (() => ({ unref() {} })) as typeof setInterval,
    clearInterval() {},
    onDecision(event) { outcomes.push(event.outcome) },
    async recover(decision, isCurrent) {
      recoveries += 1
      assert.equal(isCurrent(), true)
      assert.equal(decision.runtimeGeneration, 3)
      return 'fenced-stale'
    },
  })
  watchdog.observe(observation())
  nowMs = 2_100
  await watchdog.sweep()
  await watchdog.sweep()

  assert.equal(recoveries, 1)
  assert.deepEqual(outcomes, ['enforced', 'fenced-stale'])
  assert.deepEqual(watchdog.snapshot().counts, { healthy: 0, waiting: 0, suspect: 0, stalled: 0 })
  await watchdog.close()
})

test('enforce mode retries a failed exact recovery after bounded backoff', async () => {
  let nowMs = 100
  let recoveries = 0
  const outcomes: string[] = []
  const watchdog = createCloudProgressWatchdog({
    config: resolveCloudProgressWatchdogConfig({
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE: 'enforce',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_OBSERVE_EVIDENCE_REF: 'canary-2026-08',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_OPERATOR_OWNER: 'runtime-oncall',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_ROLLBACK_MODE: 'observe',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_SUSPECT_MS: '1000',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_STALLED_MS: '2000',
      OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_SWEEP_MS: '250',
    }),
    now: () => nowMs,
    setInterval: (() => ({ unref() {} })) as typeof setInterval,
    clearInterval() {},
    onDecision(event) { outcomes.push(event.outcome) },
    async recover(_decision, isCurrent) {
      recoveries += 1
      assert.equal(isCurrent(), true)
      return recoveries === 1 ? 'failed' : 'recovered'
    },
  })
  watchdog.observe(observation())
  nowMs = 2_100
  await watchdog.sweep()
  await watchdog.sweep()
  assert.equal(recoveries, 1, 'manual/timer sweeps must not hot-loop a failed recovery')

  nowMs = 3_100
  await watchdog.sweep()
  await watchdog.sweep()
  assert.equal(recoveries, 2)
  assert.deepEqual(outcomes, ['enforced', 'failed', 'enforced', 'recovered'])
  assert.deepEqual(watchdog.snapshot().counts, { healthy: 0, waiting: 0, suspect: 0, stalled: 0 })
  await watchdog.close()
})
