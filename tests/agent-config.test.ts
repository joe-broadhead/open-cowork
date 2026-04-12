import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCoworkAgentConfig } from '../apps/desktop/src/main/agent-config.ts'

test('buildCoworkAgentConfig exposes the curated Cowork sub-agent team', () => {
  const agents = buildCoworkAgentConfig({
    allToolPatterns: [
      'mcp__nova__*',
      'mcp__charts__*',
      'mcp__google-sheets__*',
      'mcp__google-docs__*',
      'mcp__google-drive__*',
      'mcp__google-gmail__*',
      'mcp__google-people__*',
      'mcp__github__*',
      'mcp__perplexity__*',
    ],
  }) as Record<string, any>

  assert.equal(agents.cowork.mode, 'primary')
  assert.deepEqual(agents.cowork.permission.task, {
    '*': 'deny',
    analyst: 'allow',
    research: 'allow',
    explore: 'allow',
    'sheets-builder': 'allow',
    'docs-writer': 'allow',
    'gmail-drafter': 'allow',
  })
  assert.equal(agents.cowork.permission['mcp__nova__*'], 'deny')
  assert.equal(agents.cowork.permission['mcp__google-sheets__*'], 'deny')
  assert.equal(agents.cowork.permission['mcp__github__*'], 'allow')
  assert.equal(agents.cowork.steps, undefined)
  assert.match(
    agents.cowork.prompt,
    /When the user names 2-3 independent topics, questions, or audit dimensions, spawn one child task per branch in the same step instead of serializing them\./,
  )
  assert.match(
    agents.cowork.prompt,
    /Do not wait for one independent research branch to finish before launching the others\./,
  )
  assert.match(
    agents.cowork.prompt,
    /Do not tell the user you launched multiple parallel tasks unless at least two child tasks are actually in flight\./,
  )
  assert.match(
    agents.cowork.prompt,
    /When several branches use the same sub-agent, create separate child tasks anyway instead of collapsing them into one broad task\./,
  )
  assert.match(
    agents.cowork.prompt,
    /Use todowrite to track meaningful multi-step work in the parent thread\./,
  )
  assert.match(
    agents.cowork.prompt,
    /Create a todo list before starting any task with multiple meaningful steps, multiple deliverables, or parallel branches\./,
  )

  assert.equal(agents.plan.permission.task.explore, 'allow')
  assert.equal(agents.plan.permission.task.analyst, 'allow')
  assert.equal(agents.plan.permission.task.research, 'allow')
  assert.equal(agents.plan.permission['mcp__google-sheets__*'], 'deny')
  assert.equal(agents.general.disable, true)
})

test('sub-agents are narrowed to their domain tools', () => {
  const agents = buildCoworkAgentConfig({
    allToolPatterns: [
      'mcp__nova__*',
      'mcp__charts__*',
      'mcp__google-sheets__*',
      'mcp__google-docs__*',
      'mcp__google-drive__*',
      'mcp__google-gmail__*',
      'mcp__google-people__*',
      'mcp__github__*',
      'mcp__perplexity__*',
    ],
  }) as Record<string, any>

  assert.equal(agents.analyst.permission['mcp__nova__*'], 'allow')
  assert.equal(agents.analyst.permission['mcp__google-sheets__*'], 'deny')
  assert.equal(agents.analyst.permission.skill.analyst, 'allow')
  assert.equal(agents.analyst.steps, undefined)
  assert.equal(agents.research.permission.websearch, 'allow')
  assert.equal(agents.research.permission.webfetch, 'allow')
  assert.equal(agents.research.permission['mcp__perplexity__*'], 'allow')
  assert.equal(agents.research.permission['mcp__nova__*'], 'deny')
  assert.equal(agents.research.permission.skill['*'], 'deny')
  assert.equal(agents['sheets-builder'].hidden, true)
  assert.equal(agents['sheets-builder'].permission['mcp__google-sheets__*'], 'allow')
  assert.equal(agents['sheets-builder'].permission.skill['sheets-reporting'], 'allow')
  assert.equal(agents['docs-writer'].permission['mcp__google-docs__*'], 'allow')
  assert.equal(agents['docs-writer'].permission.skill['docs-writing'], 'allow')
  assert.equal(agents['gmail-drafter'].permission['mcp__google-gmail__*'], 'allow')
  assert.equal(agents['gmail-drafter'].permission.skill['gmail-management'], 'allow')
  assert.equal(agents['gmail-drafter'].permission.task, 'deny')
})

test('custom subagents are merged into the OpenCode agent config with narrowed skills and task access', () => {
  const agents = buildCoworkAgentConfig({
    allToolPatterns: [
      'mcp__nova__*',
      'mcp__charts__*',
      'mcp__google-sheets__*',
    ],
    customAgents: [
      {
        name: 'sales-analyst',
        description: 'Analyze sales trends',
        instructions: 'Focus on YoY.',
        skillNames: ['analyst'],
        integrationNames: ['Nova Analytics'],
        writeAccess: false,
        color: 'accent',
        allowPatterns: ['mcp__nova__*', 'mcp__charts__*'],
      },
    ],
  }) as Record<string, any>

  assert.equal(agents.cowork.permission.task['sales-analyst'], 'allow')
  assert.equal(agents.plan.permission.task['sales-analyst'], 'allow')
  assert.equal(agents['sales-analyst'].mode, 'subagent')
  assert.equal(agents['sales-analyst'].permission.skill.analyst, 'allow')
  assert.equal(agents['sales-analyst'].permission['mcp__nova__*'], 'allow')
  assert.equal(agents['sales-analyst'].permission['mcp__google-sheets__*'], 'deny')
  assert.equal(agents['sales-analyst'].permission.task, 'deny')
})
