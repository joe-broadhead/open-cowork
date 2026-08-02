import test from 'node:test'
import assert from 'node:assert/strict'

import {
  acknowledgeProgressWatchdogDecision,
  classifyOpenCodeProgressEvent,
  createProgressWatchdogState,
  evaluateProgressWatchdog,
  isProgressWatchdogDecisionCurrent,
  recordProgressWatchdogObservation,
  type ProgressWatchdogObservation,
} from '@open-cowork/shared/progress-watchdog'

const thresholds = {
  suspectAfterMs: 50,
  stalledAfterMs: 200,
  maxEntries: 2,
  maxSnapshotEntries: 2,
}

function observation(
  overrides: Partial<ProgressWatchdogObservation> = {},
): ProgressWatchdogObservation {
  return {
    scopeId: 'tenant-a',
    sessionId: 'session-a',
    runId: 'run-a',
    runtimeGeneration: 1,
    executionGeneration: 1,
    leaseOwner: 'worker-a',
    leaseEpoch: 'epoch-a',
    source: 'durable_sequence',
    disposition: 'running',
    sequence: 1,
    observedAtMs: 100,
    ...overrides,
  }
}

test('progress watchdog classifies an explicit exhaustive runtime vocabulary without treating polling as progress', () => {
  for (const type of [
    'session.next.agent.switched',
    'session.next.moved',
    'session.next.synthetic',
    'session.next.shell.started',
    'session.next.shell.ended',
    'session.compacted',
  ]) {
    assert.ok(classifyOpenCodeProgressEvent({ type }), `expected ${type} to be explicit progress`)
  }
  assert.deepEqual(classifyOpenCodeProgressEvent({
    type: 'session.next.prompt.admitted',
    sequence: 10,
  }), {
    source: 'admission',
    disposition: 'running',
    sequence: 10,
    semanticKey: 'session.next.prompt.admitted',
  })
  assert.deepEqual(classifyOpenCodeProgressEvent({
    type: 'question.asked',
    sequence: 11,
  }), {
    source: 'interaction_requested',
    disposition: 'waiting',
    waitingReason: 'question',
    sequence: 11,
    semanticKey: 'question.asked',
  })
  assert.deepEqual(classifyOpenCodeProgressEvent({
    type: 'session.status',
    statusType: 'retry',
    retryAtMs: 1_000,
    sequence: 12,
  }), {
    source: 'provider_backoff',
    disposition: 'waiting',
    waitingReason: 'provider_backoff',
    resumeAtMs: 1_000,
    sequence: 12,
    semanticKey: 'session.status:retry',
  })
  assert.deepEqual(classifyOpenCodeProgressEvent({
    type: 'session.next.retried',
  }), {
    source: 'scheduled_retry',
    disposition: 'running',
    semanticKey: 'session.next.retried',
  })
  assert.deepEqual(classifyOpenCodeProgressEvent({
    type: 'session.status',
    statusType: 'retry',
  }), {
    source: 'provider_backoff',
    disposition: 'running',
    semanticKey: 'session.status:retry',
  })
  assert.equal(classifyOpenCodeProgressEvent({ type: 'session.active.poll' }), null)
  assert.equal(classifyOpenCodeProgressEvent({ type: 'health.check' }), null)
  assert.equal(
    classifyOpenCodeProgressEvent({ type: 'task.run.lease_renewed' }),
    null,
    'an owning lease heartbeat without independent work provenance is passive activity',
  )
  assert.equal(classifyOpenCodeProgressEvent({ type: 'unknown.event' }), null)
  assert.equal(
    classifyOpenCodeProgressEvent({ type: 'session.error' }),
    null,
    'generic OpenCode session errors can be followed by automatic recovery',
  )
  assert.deepEqual(classifyOpenCodeProgressEvent({
    type: 'session.next.step.failed',
    sequence: 13,
  }), {
    source: 'terminal',
    disposition: 'terminal',
    sequence: 13,
    semanticKey: 'session.next.step.failed',
  })
  assert.deepEqual(classifyOpenCodeProgressEvent({
    type: 'session.next.reasoning.delta',
    sequence: 14,
  }), {
    source: 'output_advance',
    disposition: 'running',
    sequence: 14,
    semanticKey: 'session.next.reasoning.delta',
  })
})

test('output progress advances only when its bounded cursor or length increases', () => {
  const first = classifyOpenCodeProgressEvent({
    type: 'message.part.updated',
    outputLength: 10,
  })!
  const advanced = classifyOpenCodeProgressEvent({
    type: 'message.part.updated',
    outputLength: 11,
  })!
  assert.equal(first.progressCursor, 10)
  assert.equal(first.semanticKey, 'message.part.updated:10')

  let state = recordProgressWatchdogObservation(
    createProgressWatchdogState(),
    observation({
      sequence: undefined,
      semanticKey: first.semanticKey,
      progressCursor: first.progressCursor,
      observedAtMs: 100,
    }),
    2,
  )
  state = recordProgressWatchdogObservation(state, observation({
    sequence: undefined,
    semanticKey: advanced.semanticKey,
    progressCursor: advanced.progressCursor,
    observedAtMs: 120,
  }), 2)
  state = recordProgressWatchdogObservation(state, observation({
    sequence: undefined,
    semanticKey: 'message.part.updated:11',
    progressCursor: 11,
    observedAtMs: 140,
  }), 2)
  state = recordProgressWatchdogObservation(state, observation({
    sequence: undefined,
    semanticKey: 'message.part.updated:9',
    progressCursor: 9,
    observedAtMs: 150,
  }), 2)

  assert.equal(evaluateProgressWatchdog(state, 170, thresholds).decisions[0]?.ageMs, 50)
})

test('progress watchdog uses monotonic threshold edges and emits each unchanged decision once', () => {
  let state = recordProgressWatchdogObservation(
    createProgressWatchdogState(),
    observation(),
    thresholds.maxEntries,
  )

  assert.deepEqual(evaluateProgressWatchdog(state, 149, thresholds).snapshot.counts, {
    healthy: 1,
    waiting: 0,
    suspect: 0,
    stalled: 0,
  })

  const suspect = evaluateProgressWatchdog(state, 150, thresholds).decisions[0]
  assert.equal(suspect?.state, 'suspect')
  assert.equal(suspect?.ageMs, 50)
  assert.equal(isProgressWatchdogDecisionCurrent(state, suspect!), true)
  state = acknowledgeProgressWatchdogDecision(state, suspect!)
  assert.deepEqual(evaluateProgressWatchdog(state, 151, thresholds).decisions, [])

  const stalled = evaluateProgressWatchdog(state, 300, thresholds).decisions[0]
  assert.equal(stalled?.state, 'stalled')
  state = acknowledgeProgressWatchdogDecision(state, stalled!)
  assert.deepEqual(evaluateProgressWatchdog(state, 500, thresholds).decisions, [])
})

test('progress watchdog ignores duplicate, out-of-order, stale-generation, and repeated semantic events', () => {
  let state = recordProgressWatchdogObservation(createProgressWatchdogState(), observation(), 2)
  state = recordProgressWatchdogObservation(state, observation({ sequence: 1, observedAtMs: 150 }), 2)
  state = recordProgressWatchdogObservation(state, observation({ sequence: 0, observedAtMs: 160 }), 2)
  state = recordProgressWatchdogObservation(state, observation({
    sequence: undefined,
    semanticKey: 'same-phase',
    observedAtMs: 170,
  }), 2)
  state = recordProgressWatchdogObservation(state, observation({
    sequence: undefined,
    semanticKey: 'same-phase',
    observedAtMs: 180,
  }), 2)

  assert.equal(evaluateProgressWatchdog(state, 220, thresholds).decisions[0]?.ageMs, 50)

  state = recordProgressWatchdogObservation(state, observation({
    runtimeGeneration: 2,
    executionGeneration: 1,
    runId: 'run-b',
    sequence: 1,
    observedAtMs: 220,
  }), 2)
  const staleDecision = evaluateProgressWatchdog(state, 270, thresholds).decisions[0]!
  state = recordProgressWatchdogObservation(state, observation({
    runtimeGeneration: 1,
    executionGeneration: 99,
    runId: 'stale-run',
    sequence: 99,
    observedAtMs: 300,
  }), 2)
  assert.equal(evaluateProgressWatchdog(state, 270, thresholds).decisions[0]?.ageMs, 50)
  assert.equal(isProgressWatchdogDecisionCurrent(state, staleDecision), true)
})

test('durable terminals obey sequence ordering while sequence-less authoritative terminals clear', () => {
  let state = recordProgressWatchdogObservation(createProgressWatchdogState(), observation({
    sequence: 9,
    progressCursor: 20,
  }), 2)
  state = recordProgressWatchdogObservation(state, observation({
    source: 'terminal',
    disposition: 'terminal',
    sequence: 9,
    progressCursor: 20,
    observedAtMs: 110,
  }), 2)

  assert.equal(evaluateProgressWatchdog(state, 1_000, thresholds).snapshot.counts.stalled, 1)

  state = recordProgressWatchdogObservation(state, observation({
    source: 'terminal',
    disposition: 'terminal',
    sequence: 10,
    progressCursor: 20,
    observedAtMs: 120,
  }), 2)

  assert.deepEqual(evaluateProgressWatchdog(state, 1_000, thresholds).snapshot.counts, {
    healthy: 0,
    waiting: 0,
    suspect: 0,
    stalled: 0,
  })

  state = recordProgressWatchdogObservation(createProgressWatchdogState(), observation({
    sequence: 9,
    progressCursor: 20,
  }), 2)
  state = recordProgressWatchdogObservation(state, observation({
    source: 'terminal',
    disposition: 'terminal',
    sequence: undefined,
    progressCursor: 20,
    observedAtMs: 110,
  }), 2)
  assert.equal(evaluateProgressWatchdog(state, 1_000, thresholds).snapshot.counts.stalled, 0)

  state = recordProgressWatchdogObservation(createProgressWatchdogState(), observation({
    runtimeGeneration: 2,
    runId: 'replacement-run',
    sequence: 1,
  }), 2)
  state = recordProgressWatchdogObservation(state, observation({
    source: 'terminal',
    disposition: 'terminal',
    sequence: 99,
    observedAtMs: 200,
  }), 2)
  assert.equal(evaluateProgressWatchdog(state, 1_000, thresholds).snapshot.counts.stalled, 1)
})

test('every modeled interaction, pause, retry, and backoff remains waiting instead of becoming stalled', () => {
  let state = createProgressWatchdogState()
  const waiting = [
    ['approval', 'interaction_requested'],
    ['question', 'interaction_requested'],
    ['explicit_pause', 'explicit_pause'],
    ['scheduled_retry', 'scheduled_retry'],
    ['provider_backoff', 'provider_backoff'],
  ] as const
  for (const [index, [waitingReason, source]] of waiting.entries()) {
    state = recordProgressWatchdogObservation(state, observation({
      sessionId: `session-waiting-${index}`,
      runId: `run-waiting-${index}`,
      source,
      disposition: 'waiting',
      waitingReason,
      resumeAtMs: waitingReason === 'scheduled_retry' || waitingReason === 'provider_backoff' ? 10_000 : null,
      observedAtMs: 100,
    }), 10)
  }

  assert.deepEqual(evaluateProgressWatchdog(state, 9_999, {
    ...thresholds,
    maxEntries: 10,
    maxSnapshotEntries: 10,
  }).snapshot.counts, {
    healthy: 0,
    waiting: 5,
    suspect: 0,
    stalled: 0,
  })
})

test('scheduled retry and provider backoff require a finite deadline to remain waiting', () => {
  let state = createProgressWatchdogState()
  for (const [index, waitingReason] of ['scheduled_retry', 'provider_backoff'].entries()) {
    state = recordProgressWatchdogObservation(state, observation({
      sessionId: `session-unbounded-${index}`,
      runId: `run-unbounded-${index}`,
      source: waitingReason as 'scheduled_retry' | 'provider_backoff',
      disposition: 'waiting',
      waitingReason: waitingReason as 'scheduled_retry' | 'provider_backoff',
      resumeAtMs: null,
    }), 10)
  }

  assert.deepEqual(evaluateProgressWatchdog(state, 301, {
    ...thresholds,
    maxEntries: 10,
    maxSnapshotEntries: 10,
  }).snapshot.counts, {
    healthy: 0,
    waiting: 0,
    suspect: 0,
    stalled: 2,
  })
})

test('progress watchdog models waiting/retry/terminal states and returns a bounded privacy-safe snapshot', () => {
  let state = createProgressWatchdogState()
  state = recordProgressWatchdogObservation(state, observation({
    disposition: 'waiting',
    source: 'interaction_requested',
    waitingReason: 'approval',
    sequence: 2,
  }), 2)
  state = recordProgressWatchdogObservation(state, observation({
    sessionId: 'session-b',
    runId: 'run-b',
    disposition: 'waiting',
    source: 'scheduled_retry',
    waitingReason: 'scheduled_retry',
    resumeAtMs: 250,
    sequence: 1,
  }), 2)

  const waiting = evaluateProgressWatchdog(state, 200, thresholds)
  assert.deepEqual(waiting.snapshot.counts, {
    healthy: 0,
    waiting: 2,
    suspect: 0,
    stalled: 0,
  })
  assert.deepEqual(waiting.decisions, [])

  const resumed = evaluateProgressWatchdog(state, 300, thresholds)
  assert.equal(resumed.snapshot.counts.suspect, 1)
  assert.equal(resumed.decisions[0]?.ageMs, 50)
  const serialized = JSON.stringify(resumed.snapshot)
  assert.doesNotMatch(serialized, /tenant-a|session-a|session-b|run-a|run-b|worker-a|epoch-a/)
  assert.equal(resumed.snapshot.samples.length, 2)

  state = recordProgressWatchdogObservation(state, observation({
    disposition: 'terminal',
    source: 'terminal',
    sequence: 3,
    observedAtMs: 310,
  }), 2)
  assert.equal(evaluateProgressWatchdog(state, 400, thresholds).snapshot.counts.waiting, 0)
})
