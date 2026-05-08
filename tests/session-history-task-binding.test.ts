import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { NormalizedMessagePart } from '../apps/desktop/src/main/opencode-adapter.ts'
import {
  bindingHintsForSubtask,
  childBindingCandidates,
  timingFromChild,
} from '../apps/desktop/src/main/session-history-task-binding.ts'

function subtaskPart(fields: Partial<NormalizedMessagePart>): NormalizedMessagePart {
  return {
    type: 'subtask',
    id: 'part-1',
    text: null,
    tool: null,
    callId: null,
    title: null,
    name: null,
    agent: null,
    description: null,
    prompt: null,
    raw: null,
    auto: false,
    overflow: false,
    reason: null,
    metadata: {},
    attachments: [],
    state: {
      input: {},
      output: null,
      error: null,
      title: null,
      raw: null,
      metadata: {},
      attachments: [],
    },
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    cost: null,
    ...fields,
  }
}

test('timingFromChild carries start time and only closes terminal task runs', () => {
  const child = {
    id: 'child-1',
    time: {
      created: Date.parse('2026-01-01T10:00:00.000Z'),
      updated: Date.parse('2026-01-01T10:05:00.000Z'),
    },
  }

  assert.deepEqual(timingFromChild(child, 'running'), {
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: null,
  })
  assert.deepEqual(timingFromChild(child, 'complete'), {
    startedAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:05:00.000Z',
  })
})

test('bindingHintsForSubtask normalizes explicit agent and title metadata', () => {
  const hints = bindingHintsForSubtask(subtaskPart({
    agent: '@Build-Agent',
    description: '@Build-Agent: Fix the flaky smoke test',
    title: 'Sub-agent task',
  }))

  assert.deepEqual(hints, {
    agent: 'build-agent',
    title: 'Fix the flaky smoke test',
  })
})

test('childBindingCandidates exposes titles and normalized agent hints', () => {
  assert.deepEqual(childBindingCandidates([
    { id: 'child-1', title: '@explore: Inspect runtime startup' },
    { id: 'child-2', title: 'General follow-up' },
  ]), [
    { title: '@explore: Inspect runtime startup', agent: 'explore' },
    { title: 'General follow-up', agent: null },
  ])
})
