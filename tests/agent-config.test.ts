import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCoworkAgentConfig } from '../apps/desktop/src/main/agent-config.ts'

test('buildCoworkAgentConfig exposes the curated Cowork specialist team', () => {
  const agents = buildCoworkAgentConfig({
    allToolPatterns: [
      'mcp__nova__*',
      'mcp__charts__*',
      'mcp__google-sheets__*',
      'mcp__google-docs__*',
      'mcp__google-drive__*',
      'mcp__google-gmail__*',
      'mcp__google-people__*',
    ],
  }) as Record<string, any>

  assert.equal(agents.cowork.mode, 'primary')
  assert.deepEqual(agents.cowork.permission.task, {
    '*': 'deny',
    analyst: 'allow',
    explore: 'allow',
    'sheets-builder': 'allow',
    'docs-writer': 'allow',
    'gmail-drafter': 'allow',
  })
  assert.equal(agents.cowork.permission['mcp__nova__*'], 'deny')
  assert.equal(agents.cowork.permission['mcp__google-sheets__*'], 'deny')
  assert.equal(agents.cowork.steps, undefined)

  assert.equal(agents.plan.permission.task.explore, 'allow')
  assert.equal(agents.plan.permission.task.analyst, 'allow')
  assert.equal(agents.plan.permission['mcp__google-sheets__*'], 'deny')
  assert.equal(agents.general.disable, true)
})

test('specialist agents are narrowed to their domain tools', () => {
  const agents = buildCoworkAgentConfig({
    allToolPatterns: [
      'mcp__nova__*',
      'mcp__charts__*',
      'mcp__google-sheets__*',
      'mcp__google-docs__*',
      'mcp__google-drive__*',
      'mcp__google-gmail__*',
      'mcp__google-people__*',
    ],
  }) as Record<string, any>

  assert.equal(agents.analyst.permission['mcp__nova__*'], 'allow')
  assert.equal(agents.analyst.permission['mcp__google-sheets__*'], 'deny')
  assert.equal(agents.analyst.steps, undefined)
  assert.equal(agents['sheets-builder'].hidden, true)
  assert.equal(agents['sheets-builder'].permission['mcp__google-sheets__*'], 'allow')
  assert.equal(agents['docs-writer'].permission['mcp__google-docs__*'], 'allow')
  assert.equal(agents['gmail-drafter'].permission['mcp__google-gmail__*'], 'allow')
  assert.equal(agents['gmail-drafter'].permission.task, 'deny')
})
