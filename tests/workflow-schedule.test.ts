import test from 'node:test'
import assert from 'node:assert/strict'
import { computeNextWorkflowRunAt, validateWorkflowSchedule } from '../apps/desktop/src/main/workflow/workflow-schedule.ts'

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

test('workflow schedule validation catches incomplete scheduled triggers', () => {
  assert.equal(validateWorkflowSchedule({
    type: 'one_time',
    timezone: 'UTC',
  }), 'One-time schedules require startAt.')
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
})
