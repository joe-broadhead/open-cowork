import test from 'node:test'
import assert from 'node:assert/strict'
import { validateAutomationDraft } from '../apps/desktop/src/main/automation-validation.ts'
import type { AutomationDraft } from '@open-cowork/shared'

function createDraft(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    title: 'Weekly market report',
    goal: 'Build a weekly analysis and market research report.',
    kind: 'recurring',
    schedule: { type: 'weekly', timezone: 'Europe/Amsterdam', dayOfWeek: 1, runAtHour: 9, runAtMinute: 0 },
    heartbeatMinutes: 15,
    retryPolicy: {
      maxRetries: 3,
      baseDelayMinutes: 5,
      maxDelayMinutes: 60,
    },
    runPolicy: {
      dailyRunCap: 6,
      maxRunDurationMinutes: 120,
    },
    executionMode: 'planning_only',
    autonomyPolicy: 'review-first',
    projectDirectory: null,
    preferredAgentNames: [],
    ...overrides,
  }
}

test('validateAutomationDraft accepts a well-formed planning-only automation', () => {
  assert.equal(validateAutomationDraft(createDraft()), null)
})

test('validateAutomationDraft requires a project directory for scoped execution', () => {
  assert.equal(
    validateAutomationDraft(createDraft({ executionMode: 'scoped_execution', projectDirectory: null })),
    'Scoped execution automations require a project directory.',
  )

  assert.equal(
    validateAutomationDraft(createDraft({ executionMode: 'scoped_execution', projectDirectory: '/tmp/project' })),
    null,
  )
})

test('validateAutomationDraft rejects invalid automation enum values', () => {
  assert.equal(
    validateAutomationDraft(createDraft({ kind: 'unknown' as AutomationDraft['kind'] })),
    'Automation kind is invalid.',
  )
  assert.equal(
    validateAutomationDraft(createDraft({ executionMode: 'unknown' as AutomationDraft['executionMode'] })),
    'Automation execution mode is invalid.',
  )
  assert.equal(
    validateAutomationDraft(createDraft({ autonomyPolicy: 'unknown' as AutomationDraft['autonomyPolicy'] })),
    'Automation autonomy policy is invalid.',
  )
  assert.equal(
    validateAutomationDraft(createDraft({ schedule: { type: 'hourly' as AutomationDraft['schedule']['type'], timezone: 'UTC' } })),
    'Schedule type is invalid.',
  )
})

test('validateAutomationDraft rejects invalid retry policies', () => {
  assert.equal(
    validateAutomationDraft(createDraft({ retryPolicy: { maxRetries: -1, baseDelayMinutes: 5, maxDelayMinutes: 60 } })),
    'Retry count cannot be negative.',
  )
  assert.equal(
    validateAutomationDraft(createDraft({ retryPolicy: { maxRetries: 2, baseDelayMinutes: 0, maxDelayMinutes: 60 } })),
    'Retry base delay must be greater than zero.',
  )
  assert.equal(
    validateAutomationDraft(createDraft({ retryPolicy: { maxRetries: 2, baseDelayMinutes: 10, maxDelayMinutes: 5 } })),
    'Retry max delay must be greater than or equal to the base delay.',
  )
})

test('validateAutomationDraft rejects invalid run policies', () => {
  assert.equal(
    validateAutomationDraft(createDraft({ runPolicy: { dailyRunCap: 0, maxRunDurationMinutes: 120 } })),
    'Daily work-run attempt cap must be greater than zero.',
  )
  assert.equal(
    validateAutomationDraft(createDraft({ runPolicy: { dailyRunCap: 6, maxRunDurationMinutes: 0 } })),
    'Run duration cap must be greater than zero.',
  )
})

test('validateAutomationDraft rejects primary automation agents as preferred specialists', () => {
  assert.equal(
    validateAutomationDraft(createDraft({ preferredAgentNames: ['build', 'research'] })),
    'Preferred agents must be specialist agents, not the primary automation orchestrators.',
  )
})
