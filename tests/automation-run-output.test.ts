import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractExecutionBriefFromMessages,
  extractHeartbeatDecisionFromMessages,
  summarizeAutomationMessages,
} from '../apps/desktop/src/main/automation-run-output.ts'

test('summarizeAutomationMessages returns the latest assistant text payload', () => {
  const summary = summarizeAutomationMessages('session-1', [
    {
      id: 'msg-1',
      role: 'assistant',
      time: {},
      info: {
        id: 'msg-1',
        title: null,
        role: 'assistant',
        parentID: null,
        sessionID: 'session-1',
        time: {},
        model: { providerId: null, modelId: null },
        summary: null,
        revertedMessageId: null,
      },
      parts: [{ type: 'text', id: 'part-1', text: 'Automation complete.', tool: null, callId: null, title: null, name: null, agent: null, description: null, prompt: null, raw: null, auto: false, overflow: false, reason: null, metadata: {}, attachments: [], state: { input: {}, args: {}, attachments: [], metadata: {}, title: null, raw: null, status: null }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: null }],
    },
  ])

  assert.equal(summary, 'Automation complete.')
})

test('extractExecutionBriefFromMessages prefers structured output over assistant text', () => {
  const brief = extractExecutionBriefFromMessages([
    {
      id: 'msg-1',
      role: 'assistant',
      time: {},
      structured: {
        type: 'open_cowork.execution_brief',
        version: 1,
        goal: 'Build report',
        deliverables: ['Markdown'],
        assumptions: [],
        missingContext: [],
        successCriteria: ['Done'],
        recommendedAgents: ['research'],
        approvalBoundary: 'Approve.',
        workItems: [],
      },
      info: {
        id: 'msg-1',
        title: null,
        role: 'assistant',
        parentID: null,
        sessionID: 'session-1',
        time: {},
        model: { providerId: null, modelId: null },
        summary: null,
        revertedMessageId: null,
      },
      parts: [{ type: 'text', id: 'part-1', text: 'not trusted', tool: null, callId: null, title: null, name: null, agent: null, description: null, prompt: null, raw: null, auto: false, overflow: false, reason: null, metadata: {}, attachments: [], state: { input: {}, args: {}, attachments: [], metadata: {}, title: null, raw: null, status: null }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: null }],
    },
  ])

  assert.equal(brief?.goal, 'Build report')
})

test('extractHeartbeatDecisionFromMessages prefers structured output over assistant text', () => {
  const decision = extractHeartbeatDecisionFromMessages([
    {
      id: 'msg-1',
      role: 'assistant',
      time: {},
      structured: {
        type: 'open_cowork.heartbeat_decision',
        version: 1,
        summary: 'Run now',
        action: 'run_execution',
        reason: 'Ready',
        userMessage: null,
      },
      info: {
        id: 'msg-1',
        title: null,
        role: 'assistant',
        parentID: null,
        sessionID: 'session-1',
        time: {},
        model: { providerId: null, modelId: null },
        summary: null,
        revertedMessageId: null,
      },
      parts: [{ type: 'text', id: 'part-1', text: 'not trusted', tool: null, callId: null, title: null, name: null, agent: null, description: null, prompt: null, raw: null, auto: false, overflow: false, reason: null, metadata: {}, attachments: [], state: { input: {}, args: {}, attachments: [], metadata: {}, title: null, raw: null, status: null }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: null }],
    },
  ])

  assert.equal(decision?.action, 'run_execution')
})
