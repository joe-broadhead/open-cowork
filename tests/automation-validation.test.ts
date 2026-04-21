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
