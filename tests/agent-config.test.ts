import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCoworkAgentConfig, listBuiltInAgentDetails } from '../apps/desktop/src/main/agent-config.ts'

test('buildCoworkAgentConfig exposes the generic open core agent team', () => {
  const agents = buildCoworkAgentConfig({
    allToolPatterns: [
      'mcp__github__*',
      'mcp__perplexity__*',
    ],
  }) as Record<string, any>

  assert.equal(agents.assistant.mode, 'primary')
  assert.equal('cowork' in agents, false)
  assert.deepEqual(agents.assistant.permission.task, {
    '*': 'deny',
    research: 'allow',
    explore: 'allow',
  })
  assert.equal(agents.assistant.permission.todowrite, 'allow')
  assert.equal(agents.assistant.permission['mcp__github__*'], 'deny')
  assert.equal(agents.plan.permission.task.research, 'allow')
  assert.equal(agents.plan.permission.task.explore, 'allow')
  assert.equal(agents.plan.permission.todowrite, 'deny')
  assert.equal(agents.general.disable, true)
  assert.equal(agents.research.permission.websearch, 'allow')
  assert.equal(agents.research.permission.webfetch, 'allow')
  assert.equal(agents.research.permission.todowrite, 'deny')
  assert.equal(agents.explore.description.includes('Read-only codebase'), true)
})

test('built-in agent details only expose the generic assistant team', () => {
  const names = listBuiltInAgentDetails().map((agent) => agent.name)
  assert.deepEqual(names, ['assistant', 'plan', 'research', 'explore'])
})

test('custom sub-agents are merged into the OpenCode agent config with narrowed skill and task access', () => {
  const agents = buildCoworkAgentConfig({
    allToolPatterns: [
      'mcp__github__*',
      'mcp__perplexity__*',
    ],
    customAgents: [
      {
        name: 'repo-maintainer',
        description: 'Handle repository work',
        instructions: 'Work carefully.',
        skillNames: ['github:github'],
        integrationNames: ['GitHub'],
        writeAccess: true,
        color: 'accent',
        allowPatterns: ['mcp__github__repos_*'],
        askPatterns: ['mcp__github__create_pull_request'],
      },
    ],
  }) as Record<string, any>

  assert.equal(agents.assistant.permission.task['repo-maintainer'], 'allow')
  assert.equal(agents.plan.permission.task['repo-maintainer'], undefined)
  assert.equal(agents['repo-maintainer'].mode, 'subagent')
  assert.equal(agents['repo-maintainer'].permission.skill['github:github'], 'allow')
  assert.equal(agents['repo-maintainer'].permission['mcp__github__repos_*'], 'allow')
  assert.equal(agents['repo-maintainer'].permission['mcp__github__create_pull_request'], 'ask')
  assert.equal(agents['repo-maintainer'].permission.task, 'deny')
})
