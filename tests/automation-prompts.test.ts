import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createAutomationEnrichmentFormat,
  createAutomationHeartbeatFormat,
  createAutomationHeartbeatPrompt,
  extractBriefFromAssistantText,
  extractBriefFromStructured,
  extractHeartbeatDecisionFromAssistantText,
  extractHeartbeatDecisionFromStructured,
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
  assert.match(prompt, /dailyRunCap/)
  assert.match(prompt, /structured JSON schema/)
  assert.doesNotMatch(prompt, /```json/)
})

test('automation prompts include preferred specialists when configured', async () => {
  const { createAutomationEnrichmentPrompt, createAutomationExecutionPrompt } = await import('../apps/desktop/src/main/automation-prompts.ts')
  const automation = createAutomation({ preferredAgentNames: ['data-analyst', 'charts'] })

  const enrichment = createAutomationEnrichmentPrompt(automation)
  const execution = createAutomationExecutionPrompt(automation, automation.brief!)

  assert.match(enrichment, /preferredAgentNames/)
  assert.match(enrichment, /runPolicy/)
  assert.match(enrichment, /data-analyst/)
  assert.match(execution, /user-selected agent team/i)
  assert.match(execution, /6 non-heartbeat work-run attempts per day, counting retries/)
  assert.match(execution, /charts/)
})

test('automation structured output formats request validated json_schema payloads', () => {
  const enrichmentFormat = createAutomationEnrichmentFormat()
  const heartbeatFormat = createAutomationHeartbeatFormat()

  assert.equal(enrichmentFormat.type, 'json_schema')
  assert.equal(heartbeatFormat.type, 'json_schema')
  assert.equal(enrichmentFormat.retryCount, 2)
  assert.equal(heartbeatFormat.retryCount, 2)
  assert.equal((enrichmentFormat.schema as { properties: { type: { const: string } } }).properties.type.const, 'open_cowork.execution_brief')
  assert.equal((heartbeatFormat.schema as { properties: { type: { const: string } } }).properties.type.const, 'open_cowork.heartbeat_decision')
})

test('extractHeartbeatDecisionFromAssistantText parses fenced JSON', () => {
  const decision = extractHeartbeatDecisionFromAssistantText([
    '```json',
    JSON.stringify({
      type: 'open_cowork.heartbeat_decision',
      version: 1,
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
    type: 'open_cowork.heartbeat_decision',
    version: 1,
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

test('extractBriefFromAssistantText parses the versioned execution brief contract', () => {
  const brief = extractBriefFromAssistantText([
    '```json',
    JSON.stringify({
      type: 'open_cowork.execution_brief',
      version: 1,
      goal: 'Build a weekly report',
      deliverables: ['Markdown report'],
      assumptions: ['Analytics sources are available'],
      missingContext: [],
      successCriteria: ['The report is ready for review'],
      recommendedAgents: ['research', 'charts'],
      approvalBoundary: 'Approve before sending.',
      workItems: [
        {
          id: 'collect-data',
          title: 'Collect data',
          description: 'Gather the latest weekly metrics.',
          ownerAgent: 'research',
          dependsOn: [],
        },
      ],
    }),
    '```',
  ].join('\n'))

  assert.ok(brief)
  assert.equal(brief?.goal, 'Build a weekly report')
  assert.equal(brief?.status, 'ready')
  assert.deepEqual(brief?.recommendedAgents, ['research', 'charts'])
  assert.equal(brief?.workItems[0]?.id, 'collect-data')
})

test('extractBriefFromStructured parses a structured execution brief payload', () => {
  const brief = extractBriefFromStructured({
    type: 'open_cowork.execution_brief',
    version: 1,
    goal: 'Build a weekly report',
    deliverables: ['Markdown report'],
    assumptions: ['Analytics sources are available'],
    missingContext: [],
    successCriteria: ['The report is ready for review'],
    recommendedAgents: ['research', 'charts'],
    approvalBoundary: 'Approve before sending.',
    workItems: [
      {
        id: 'collect-data',
        title: 'Collect data',
        description: 'Gather the latest weekly metrics.',
        ownerAgent: 'research',
        dependsOn: [],
      },
    ],
  })

  assert.ok(brief)
  assert.equal(brief?.goal, 'Build a weekly report')
  assert.equal(brief?.status, 'ready')
})

test('extractBriefFromStructured preserves unique capped work item ids and dependency references', () => {
  const sharedPrefix = 'x'.repeat(128)
  const firstRawId = `${sharedPrefix}-first`
  const secondRawId = `${sharedPrefix}-second`
  const brief = extractBriefFromStructured({
    type: 'open_cowork.execution_brief',
    version: 1,
    goal: 'Build a weekly report',
    deliverables: ['Markdown report'],
    assumptions: [],
    missingContext: [],
    successCriteria: [],
    recommendedAgents: ['research'],
    approvalBoundary: 'Approve before sending.',
    workItems: [
      {
        id: firstRawId,
        title: 'Collect data',
        description: 'Gather the latest weekly metrics.',
        ownerAgent: 'research',
        dependsOn: [],
      },
      {
        id: secondRawId,
        title: 'Write report',
        description: 'Draft the report after data collection.',
        ownerAgent: 'writer',
        dependsOn: [firstRawId],
      },
    ],
  })

  const firstId = brief?.workItems[0]?.id
  const secondId = brief?.workItems[1]?.id
  assert.ok(firstId)
  assert.ok(secondId)
  assert.notEqual(firstId, secondId)
  assert.ok(firstId.length <= 128)
  assert.ok(secondId.length <= 128)
  assert.deepEqual(brief?.workItems[1]?.dependsOn, [firstId])
})

test('extractBriefFromStructured caps automation brief volume before persistence', () => {
  const brief = extractBriefFromStructured({
    type: 'open_cowork.execution_brief',
    version: 1,
    goal: 'x'.repeat(9 * 1024),
    deliverables: Array.from({ length: 40 }, (_, index) => `deliverable-${index}`),
    assumptions: [],
    missingContext: [],
    successCriteria: [],
    recommendedAgents: [],
    approvalBoundary: 'Approve before sending.',
    workItems: Array.from({ length: 140 }, (_, index) => ({
      id: `item-${index}`,
      title: 'x'.repeat(600),
      description: 'x'.repeat(5 * 1024),
      ownerAgent: 'research',
      dependsOn: Array.from({ length: 40 }, (_entry, depIndex) => `dep-${depIndex}`),
    })),
  })

  assert.ok(brief)
  assert.equal(brief?.goal.length, 8 * 1024)
  assert.equal(brief?.deliverables.length, 32)
  assert.equal(brief?.workItems.length, 128)
  assert.equal(brief?.workItems[0]?.title.length, 512)
  assert.equal(brief?.workItems[0]?.description.length, 4 * 1024)
  assert.equal(brief?.workItems[0]?.dependsOn.length, 32)
})

test('extractHeartbeatDecisionFromAssistantText rejects unknown contract envelopes', () => {
  const decision = extractHeartbeatDecisionFromAssistantText(JSON.stringify({
    type: 'unexpected.contract',
    version: 1,
    action: 'noop',
    summary: 'Ignore me',
    reason: 'Wrong type',
    userMessage: null,
  }))

  assert.equal(decision, null)
})

test('extractHeartbeatDecisionFromStructured parses a structured heartbeat decision payload', () => {
  const decision = extractHeartbeatDecisionFromStructured({
    type: 'open_cowork.heartbeat_decision',
    version: 1,
    summary: 'The brief is approved and the automation should run now.',
    action: 'run_execution',
    reason: 'Everything needed for execution is already in place.',
    userMessage: null,
  })

  assert.deepEqual(decision, {
    summary: 'The brief is approved and the automation should run now.',
    action: 'run_execution',
    reason: 'Everything needed for execution is already in place.',
    userMessage: null,
  })
})
