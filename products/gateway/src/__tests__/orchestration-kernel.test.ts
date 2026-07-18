import { describe, expect, it } from 'vitest'
import { planCapacityHold, planRuntimeFailureTimeline, retryBackoffMs } from '../orchestration-kernel.js'

describe('orchestration kernel timeline calculations', () => {
  const nowMs = Date.parse('2026-06-21T10:00:00.000Z')

  it('plans non-global capacity holds with an explicit retry timeline', () => {
    const plan = planCapacityHold({
      task: {
        title: 'Second delivery task',
        note: 'Existing context\nCapacity wait: old:value 1/1 (stale)',
        earliestStartAt: '2026-06-21T09:59:00.000Z',
      },
      admission: {
        allowed: false,
        dimension: 'team',
        key: 'delivery',
        reason: 'capacity.team_full: delivery 1/1',
        used: 1,
        limit: 1,
      },
      schedulerIntervalMs: 5000,
      nowMs,
    })

    expect(plan).toMatchObject({
      eventType: 'capacity.admission.delayed',
      eventPayload: {
        dimension: 'team',
        key: 'delivery',
        used: 1,
        limit: 1,
        reason: 'capacity.team_full: delivery 1/1',
        retryAt: '2026-06-21T10:00:05.000Z',
      },
      taskPatch: {
        earliestStartAt: '2026-06-21T10:00:05.000Z',
        note: 'Existing context\nCapacity wait: team:delivery 1/1 (capacity.team_full: delivery 1/1)',
      },
      queueMessage: 'Capacity waiting for Second delivery task: capacity.team_full: delivery 1/1',
    })
  })

  it('keeps global capacity holds queued without advancing earliestStartAt', () => {
    const plan = planCapacityHold({
      task: { title: 'Queued task' },
      admission: {
        allowed: false,
        dimension: 'global',
        key: 'scheduler',
        reason: 'capacity.global_full: scheduler 1/1',
        used: 1,
        limit: 1,
      },
      schedulerIntervalMs: 5000,
      nowMs,
    })

    expect(plan.eventType).toBe('capacity.admission.queued')
    expect(plan.eventPayload).not.toHaveProperty('retryAt')
    expect(plan.taskPatch).toEqual({
      note: 'Capacity wait: global:scheduler 1/1 (capacity.global_full: scheduler 1/1)',
    })
  })

  it('plans transient runtime retries from explicit attempt and clock data', () => {
    const firstRetry = planRuntimeFailureTimeline({
      taskTitle: 'Ship reviewed work',
      runStage: 'implement',
      runAttempt: 1,
      failureSummary: 'Transient OpenCode transport failure: fetch failed',
      retryStage: 'implement',
      taskStatus: 'pending',
      nowMs,
    })

    expect(firstRetry).toEqual({
      action: 'retry',
      retryAt: '2026-06-21T10:01:00.000Z',
      taskPatch: {
        earliestStartAt: '2026-06-21T10:01:00.000Z',
        note: 'Transient OpenCode transport failure: fetch failed; retry after 2026-06-21T10:01:00.000Z',
      },
      queueMessage: 'Scheduler retry backoff for Ship reviewed work: 1m',
    })

    expect(retryBackoffMs(10)).toBe(30 * 60_000)
  })

  it('plans retry exhaustion as a blocked timeline result', () => {
    const blocked = planRuntimeFailureTimeline({
      taskTitle: 'Ship reviewed work',
      runStage: 'implement',
      runAttempt: 3,
      failureSummary: 'Transient OpenCode transport failure: fetch failed',
      taskStatus: 'blocked',
      nowMs,
    })

    expect(blocked).toEqual({
      action: 'blocked',
      queueMessage: 'Scheduler blocked Ship reviewed work after 3 implement attempt(s): Transient OpenCode transport failure: fetch failed',
    })
  })
})
