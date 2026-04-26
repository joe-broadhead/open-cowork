import test from 'node:test'
import assert from 'node:assert/strict'
import { computeNextAutomationRunAt, isAutomationDue, validateAutomationSchedule } from '../apps/desktop/src/main/automation-schedule.ts'

test('weekly schedules compute the next run after the current instant', () => {
  const next = computeNextAutomationRunAt({
    type: 'weekly',
    timezone: 'Europe/Amsterdam',
    dayOfWeek: 1,
    runAtHour: 9,
    runAtMinute: 0,
  }, new Date('2026-04-20T07:30:00.000Z'))

  assert.equal(next, '2026-04-27T07:00:00.000Z')
})

test('daily schedules roll to the next day after the local run time has passed', () => {
  const next = computeNextAutomationRunAt({
    type: 'daily',
    timezone: 'UTC',
    runAtHour: 9,
    runAtMinute: 0,
  }, new Date('2026-04-20T09:30:00.000Z'))

  assert.equal(next, '2026-04-21T09:00:00.000Z')
})

test('monthly schedules clamp impossible dates to the last day of the month', () => {
  const next = computeNextAutomationRunAt({
    type: 'monthly',
    timezone: 'UTC',
    dayOfMonth: 31,
    runAtHour: 8,
    runAtMinute: 15,
  }, new Date('2026-04-01T00:00:00.000Z'))

  assert.equal(next, '2026-04-30T08:15:00.000Z')
})

test('schedule validation catches missing one-time startAt values', () => {
  assert.equal(validateAutomationSchedule({
    type: 'one_time',
    timezone: 'UTC',
  }), 'One-time schedules require startAt.')
})

test('isAutomationDue compares timestamps safely', () => {
  assert.equal(isAutomationDue('2026-04-20T10:00:00.000Z', new Date('2026-04-20T10:00:00.000Z')), true)
  assert.equal(isAutomationDue('2026-04-20T11:00:00.000Z', new Date('2026-04-20T10:00:00.000Z')), false)
})
