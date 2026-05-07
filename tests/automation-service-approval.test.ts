import test from 'node:test'
import assert from 'node:assert/strict'
import type { AutomationDetail, ExecutionBrief } from '@open-cowork/shared'
import {
  buildAutomationApprovalBody,
  requiresManualApproval,
} from '../apps/desktop/src/main/automation-service-approval.ts'

function automationWithPolicy(autonomyPolicy: AutomationDetail['autonomyPolicy']) {
  return { autonomyPolicy } as AutomationDetail
}

function brief(overrides: Partial<ExecutionBrief> = {}): ExecutionBrief {
  return {
    summary: 'Prepare the weekly brief.',
    reasoning: 'The workflow has enough context.',
    deliverables: ['Market summary', 'Action list'],
    workItems: [],
    recommendedAgents: ['researcher', 'writer'],
    missingContext: [],
    approvalBoundary: 'Approve before sending externally.',
    ...overrides,
  }
}

test('requiresManualApproval only gates review-first automations', () => {
  assert.equal(requiresManualApproval(automationWithPolicy('review-first')), true)
  assert.equal(requiresManualApproval(automationWithPolicy('autonomous')), false)
})

test('buildAutomationApprovalBody summarizes deliverables, agents, and approval boundary', () => {
  assert.equal(
    buildAutomationApprovalBody(brief()),
    [
      'The execution brief is ready.',
      '',
      'Deliverables: Market summary, Action list',
      'Recommended agents: researcher, writer',
      'Approval boundary: Approve before sending externally.',
    ].join('\n'),
  )
})

test('buildAutomationApprovalBody uses fallbacks and includes missing context', () => {
  assert.equal(
    buildAutomationApprovalBody(brief({
      deliverables: [],
      recommendedAgents: [],
      missingContext: ['Confirm launch date.', 'Attach final budget.'],
    })),
    [
      'The execution brief is ready.',
      '',
      'Deliverables: None specified.',
      'Recommended agents: Use standard plan/build routing.',
      'Approval boundary: Approve before sending externally.',
      '',
      'Missing context:',
      'Confirm launch date.',
      'Attach final budget.',
    ].join('\n'),
  )
})
