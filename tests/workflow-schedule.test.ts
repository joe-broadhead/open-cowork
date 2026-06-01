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

test('desktop workflow schedule module re-exports the shared validator', async () => {
  const desktop = await import('../apps/desktop/src/main/workflow/workflow-schedule.ts')

  const schedule = {
    type: 'one_time' as const,
    timezone: 'UTC',
  }
  assert.equal(desktop.validateWorkflowSchedule(schedule), validateWorkflowSchedule(schedule))
  assert.equal(desktop.computeNextWorkflowRunAt([], new Date('2026-05-14T09:30:00.000Z')), null)
})
