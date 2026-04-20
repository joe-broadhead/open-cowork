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
  assert.match(agents.build.prompt, /Use delegation proactively/)
  assert.match(agents.build.prompt, /Available delegated agents:/)
  assert.match(agents.build.prompt, /general \(builtin\): General-purpose delegated agent/)
  assert.match(agents.build.prompt, /charts \(configured\): /)
  assert.equal(agents.build.permission.skill['*'], 'deny')
  assert.equal(agents.build.permission.skill['chart-creator'], undefined)
  assert.equal(agents.build.permission.skill['skill-creator'], undefined)
  assert.equal(agents.build.permission['mcp__*'], 'deny')
  assert.equal(agents.build.permission['mcp__github__*'], 'deny')
  assert.equal(agents.build.permission.websearch, 'allow')
  assert.equal(agents.plan.permission.task.explore, 'allow')
  assert.equal(agents.plan.permission.todowrite, 'deny')
  assert.match(agents.plan.prompt, /If the user explicitly @mentions a subagent/)
  assert.match(agents.plan.prompt, /explore \(builtin\): Read-only codebase/)
  assert.equal(agents.plan.permission.skill['*'], 'deny')
  assert.equal(agents.plan.permission.skill['chart-creator'], undefined)
  assert.equal(agents.plan.permission.task.general, undefined)
  assert.equal(agents.general.permission.websearch, 'allow')
  assert.equal(agents.general.permission.webfetch, 'allow')
  assert.equal(agents.general.permission.todowrite, 'deny')
  assert.equal(agents.general.prompt, undefined)
  assert.equal(agents.general.permission.skill['*'], 'deny')
  assert.equal(agents.explore.prompt, undefined)
  assert.equal(agents.explore.permission.skill['*'], 'deny')
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
  assert.match(agents.build.prompt, /repo-maintainer \(custom\): Handle repository work/)
  assert.doesNotMatch(agents.plan.prompt, /repo-maintainer \(custom\): Handle repository work/)
  assert.equal(agents.build.permission.skill['github:github'], undefined)
  assert.equal(agents['repo-maintainer'].mode, 'subagent')
  assert.equal(agents['repo-maintainer'].permission.skill['github:github'], 'allow')
  assert.equal(agents['repo-maintainer'].permission['mcp__github__repos_*'], 'allow')
  assert.equal(agents['repo-maintainer'].permission['mcp__github__create_pull_request'], 'ask')
  assert.equal(agents['repo-maintainer'].permission.task, 'deny')
  assert.match(
    agents['repo-maintainer'].prompt,
    /Before substantive work, load and follow these attached skills via the skill tool: github:github\./,
  )
})

test('configured built-in agent prompts instruct the model to load attached skills first', () => {
  const agents = buildCoworkAgentConfig({
    allToolPatterns: [
      'mcp__charts__*',
      'mcp__skills__*',
      'websearch',
      'webfetch',
      'question',
    ],
  }) as Record<string, any>

  assert.match(
    agents.charts.prompt,
    /Before substantive work, load and follow these attached skills via the skill tool: chart-creator\./,
  )
  assert.match(
    agents['skill-builder'].prompt,
    /Before substantive work, load and follow these attached skills via the skill tool: skill-creator\./,
  )
  assert.equal(
    agents.charts.permission.external_directory['/tmp/chart-project/.opencowork/skill-bundles/chart-creator/*'],
    undefined,
  )
})

test('configured charts agent gets explicit external-directory access to the runtime chart skill bundle', () => {
  const agents = buildCoworkAgentConfig({
    allToolPatterns: ['mcp__charts__*'],
    projectDirectory: '/tmp/chart-project',
  }) as Record<string, any>

  assert.equal(
    agents.charts.permission.external_directory['/tmp/chart-project/.opencowork/skill-bundles/chart-creator/*'],
    'allow',
  )
})

test('plan prompt lists readonly custom specialists and build prompt favors them before generic work', () => {
  const agents = buildCoworkAgentConfig({
    allToolPatterns: [
      'mcp__nova__*',
      'mcp__charts__*',
    ],
    customAgents: [
      {
        name: 'data-analyst',
        description: 'Analyze metrics, answer business questions, and create charts.',
        instructions: 'Use Nova carefully.',
        skillNames: ['analyst', 'chart-creator'],
        toolNames: ['Nova', 'Charts'],
        writeAccess: false,
        color: 'info',
        allowPatterns: ['mcp__nova__*', 'mcp__charts__*'],
        askPatterns: [],
      },
    ],
  }) as Record<string, any>

  assert.match(agents.build.prompt, /Prefer custom user-defined specialist agents over generic agents/)
  assert.match(agents.build.prompt, /data-analyst \(custom\): Analyze metrics, answer business questions, and create charts\./)
  assert.match(agents.plan.prompt, /data-analyst \(custom\): Analyze metrics, answer business questions, and create charts\./)
  assert.equal(agents.build.permission.skill.analyst, undefined)
  assert.equal(agents.build.permission.skill['chart-creator'], undefined)
  assert.equal(agents.plan.permission.skill.analyst, undefined)
  assert.equal(agents['data-analyst'].permission.skill.analyst, 'allow')
  assert.equal(agents['data-analyst'].permission.skill['chart-creator'], 'allow')
})
