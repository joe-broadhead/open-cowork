import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeNextWorkflowRunAt,
  validateWorkflowSchedule,
} from '../packages/shared/src/workflow.ts'

test('workflow schedules compute the next enabled trigger', () => {
  const next = computeNextWorkflowRunAt([
    { id: 'manual', type: 'manual', enabled: true },
    {
      id: 'daily',
      type: 'schedule',
      enabled: true,
      schedule: {
        type: 'daily',
        timezone: 'UTC',
        runAtHour: 9,
        runAtMinute: 0,
      },
    },
  ], new Date('2026-05-14T09:30:00.000Z'))

  assert.equal(next, '2026-05-15T09:00:00.000Z')
})

test('workflow recurring schedules honor future startAt boundaries', () => {
  const from = new Date('2026-05-14T09:30:00.000Z')

  assert.equal(computeNextWorkflowRunAt([
    {
      id: 'daily',
      type: 'schedule',
      enabled: true,
      schedule: {
        type: 'daily',
        timezone: 'UTC',
        startAt: '2026-05-16T10:00:00.000Z',
        runAtHour: 9,
        runAtMinute: 0,
      },
    },
  ], from), '2026-05-17T09:00:00.000Z')
})

test('workflow schedule validation catches incomplete scheduled triggers', () => {
  const now = new Date('2026-05-14T09:30:00.000Z')

  assert.equal(validateWorkflowSchedule({
    type: 'one_time',
    timezone: 'UTC',
  }, now), 'One-time schedules require startAt.')
  assert.equal(validateWorkflowSchedule({
    type: 'weekly',
    timezone: 'UTC',
    runAtHour: 9,
    runAtMinute: 0,
  }), 'Weekly schedules require dayOfWeek between 0 and 6.')
  assert.equal(validateWorkflowSchedule({
    type: 'daily',
    timezone: 'Not/A_TimeZone',
    runAtHour: 9,
    runAtMinute: 0,
  }), 'Schedule timezone is invalid.')
  assert.equal(validateWorkflowSchedule({
    type: 'daily',
    timezone: 'UTC',
    runAtHour: 24,
  }), 'Schedule runAtHour must be an integer between 0 and 23.')
  assert.equal(validateWorkflowSchedule({
    type: 'daily',
    timezone: 'UTC',
    runAtMinute: 60,
  }), 'Schedule runAtMinute must be an integer between 0 and 59.')
  assert.equal(validateWorkflowSchedule({
    type: 'one_time',
    timezone: 'UTC',
    startAt: 'not-a-date',
  }, now), 'Schedule startAt must be a valid ISO timestamp.')
  assert.equal(validateWorkflowSchedule({
    type: 'one_time',
    timezone: 'UTC',
    startAt: '2026-05-14T09:00:00.000Z',
  }, now), 'Schedule startAt must be in the future.')
  assert.equal(validateWorkflowSchedule({
    type: 'one_time',
    timezone: 'UTC',
    startAt: '2026-05-14T10:00:00.000Z',
  }, now), null)
})

test('desktop workflow schedule module re-exports the shared validator', async () => {
  const desktop = await import('@open-cowork/runtime-host/workflow/workflow-schedule')

  const schedule = {
    type: 'one_time' as const,
    timezone: 'UTC',
  }
  assert.equal(desktop.validateWorkflowSchedule(schedule), validateWorkflowSchedule(schedule))
  assert.equal(desktop.computeNextWorkflowRunAt([], new Date('2026-05-14T09:30:00.000Z')), null)
})
