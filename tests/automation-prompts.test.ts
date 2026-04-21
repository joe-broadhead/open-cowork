import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createAutomationHeartbeatPrompt,
  extractHeartbeatDecisionFromAssistantText,
} from '../apps/desktop/src/main/automation-prompts.ts'
import type { AutomationDetail } from '@open-cowork/shared'

function createAutomation(overrides: Partial<AutomationDetail> = {}): AutomationDetail {
  return {
    id: 'auto-1',
    title: 'Weekly market report',
    goal: 'Build a weekly market research and performance report.',
    kind: 'recurring',
    status: 'ready',
    schedule: { type: 'weekly', timezone: 'Europe/Amsterdam', dayOfWeek: 1, runAtHour: 9, runAtMinute: 0 },
    heartbeatMinutes: 15,
    executionMode: 'planning_only',
    autonomyPolicy: 'review-first',
    projectDirectory: null,
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
    nextRunAt: '2026-04-21T07:00:00.000Z',
    lastRunAt: null,
    nextHeartbeatAt: '2026-04-20T10:15:00.000Z',
    lastHeartbeatAt: null,
    latestRunStatus: null,
    latestRunId: null,
    brief: {
      version: 1,
      status: 'ready',
      goal: 'Build a weekly market research and performance report.',
      deliverables: ['Markdown report'],
      assumptions: [],
      missingContext: [],
      successCriteria: ['Report is ready for review'],
      recommendedAgents: ['research', 'charts'],
      workItems: [],
      approvalBoundary: 'Approve before delivery.',
      generatedAt: '2026-04-20T10:00:00.000Z',
      approvedAt: '2026-04-20T10:05:00.000Z',
    },
    latestSessionId: null,
    deliveries: [],
    ...overrides,
  }
}

test('heartbeat prompt includes automation state, inbox, and recent runs', () => {
  const prompt = createAutomationHeartbeatPrompt({
    automation: createAutomation(),
    openInbox: [
      {
        id: 'inbox-1',
        automationId: 'auto-1',
        runId: null,
        sessionId: null,
        questionId: null,
        type: 'approval',
        status: 'open',
        title: 'Execution brief ready',
        body: 'Please approve.',
        createdAt: '2026-04-20T10:10:00.000Z',
        updatedAt: '2026-04-20T10:10:00.000Z',
      },
    ],
    recentRuns: [
      {
        id: 'run-1',
        automationId: 'auto-1',
        sessionId: null,
        kind: 'execution',
        status: 'completed',
        title: 'Execute weekly market report',
        summary: 'Done.',
        error: null,
        createdAt: '2026-04-20T09:00:00.000Z',
        startedAt: '2026-04-20T09:00:10.000Z',
        finishedAt: '2026-04-20T09:05:00.000Z',
      },
    ],
  })

  assert.match(prompt, /Weekly market report/)
  assert.match(prompt, /Open inbox items:/)
  assert.match(prompt, /Recent runs:/)
  assert.match(prompt, /run_execution/)
})

test('extractHeartbeatDecisionFromAssistantText parses fenced JSON', () => {
  const decision = extractHeartbeatDecisionFromAssistantText([
    '```json',
    JSON.stringify({
      summary: 'The brief is approved and the automation should run now.',
      action: 'run_execution',
      reason: 'Everything needed for execution is already in place.',
      userMessage: null,
    }),
    '```',
  ].join('\n'))

  assert.deepEqual(decision, {
    summary: 'The brief is approved and the automation should run now.',
    action: 'run_execution',
    reason: 'Everything needed for execution is already in place.',
    userMessage: null,
  })
})

test('extractHeartbeatDecisionFromAssistantText falls back to reason when summary is missing', () => {
  const decision = extractHeartbeatDecisionFromAssistantText(JSON.stringify({
    action: 'request_user',
    reason: 'The automation needs a destination email address before it can deliver anything.',
    userMessage: 'Reply with the recipient email address for this report.',
  }))

  assert.deepEqual(decision, {
    summary: 'The automation needs a destination email address before it can deliver anything.',
    action: 'request_user',
    reason: 'The automation needs a destination email address before it can deliver anything.',
    userMessage: 'Reply with the recipient email address for this report.',
  })
})
