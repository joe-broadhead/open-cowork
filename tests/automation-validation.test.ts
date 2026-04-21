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
    executionMode: 'planning_only',
    autonomyPolicy: 'review-first',
    projectDirectory: null,
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
