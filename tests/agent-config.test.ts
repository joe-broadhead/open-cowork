import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCoworkAgentConfig, listBuiltInAgentDetails } from '../apps/desktop/src/main/agent-config.ts'

test('buildCoworkAgentConfig exposes the generic OpenCode agent set', () => {
  const agents = buildCoworkAgentConfig({
    allToolPatterns: [
      'mcp__github__*',
      'mcp__perplexity__*',
    ],
  }) as Record<string, any>

  assert.equal(agents.build.mode, 'primary')
  assert.equal('cowork' in agents, false)
  assert.deepEqual(agents.build.permission.task, {
    '*': 'deny',
    charts: 'allow',
    'skill-builder': 'allow',
    research: 'allow',
    general: 'allow',
    explore: 'allow',
  })
  assert.equal(agents.build.permission.todowrite, 'allow')
  assert.equal(agents.build.prompt, undefined)
  assert.equal(agents.build.permission['mcp__github__*'], 'deny')
  assert.equal(agents.build.permission.websearch, 'allow')
  assert.equal(agents.plan.permission.task.explore, 'allow')
  assert.equal(agents.plan.permission.todowrite, 'deny')
  assert.equal(agents.plan.prompt, undefined)
  assert.equal(agents.plan.permission.task.general, undefined)
  assert.equal(agents.general.permission.websearch, 'allow')
  assert.equal(agents.general.permission.webfetch, 'allow')
  assert.equal(agents.general.permission.todowrite, 'deny')
  assert.equal(agents.general.prompt, undefined)
  assert.equal(agents.explore.prompt, undefined)
  assert.equal(agents.explore.description.includes('Read-only codebase'), true)
})

test('built-in agent details expose the native OpenCode agent set plus configured built-in agents', () => {
  const builtins = listBuiltInAgentDetails()
  const names = builtins.map((agent) => agent.name)
  assert.deepEqual(names, ['build', 'plan', 'general', 'explore', 'charts', 'skill-builder', 'research'])
  const build = builtins.find((agent) => agent.name === 'build')
  assert.equal(build?.nativeToolIds.includes('websearch'), true)
  assert.equal(build?.nativeToolIds.includes('read'), true)
  assert.equal(build?.configuredToolIds.includes('charts'), true)
  assert.equal(build?.instructions, '')
  const research = builtins.find((agent) => agent.name === 'research')
  assert.deepEqual(research?.nativeToolIds, ['websearch', 'webfetch', 'question'])
  assert.deepEqual(research?.toolAccess, ['Web Search', 'Web Fetch', 'Question'])
})

test('custom agents are merged into the OpenCode agent config with narrowed skill and task access', () => {
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
        toolNames: ['GitHub'],
        writeAccess: true,
        color: 'accent',
        allowPatterns: ['mcp__github__repos_*'],
        askPatterns: ['mcp__github__create_pull_request'],
      },
    ],
  }) as Record<string, any>

  assert.equal(agents.build.permission.task['repo-maintainer'], 'allow')
  assert.equal(agents.plan.permission.task['repo-maintainer'], undefined)
  assert.equal(agents['repo-maintainer'].mode, 'subagent')
  assert.equal(agents['repo-maintainer'].permission.skill['github:github'], 'allow')
  assert.equal(agents['repo-maintainer'].permission['mcp__github__repos_*'], 'allow')
  assert.equal(agents['repo-maintainer'].permission['mcp__github__create_pull_request'], 'ask')
  assert.equal(agents['repo-maintainer'].permission.task, 'deny')
})
