import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { buildOpenCoworkAgentConfig, listBuiltInAgentDetails } from '../apps/desktop/src/main/agent-config.ts'

function testTempDir(prefix: string) {
  const parent = join(process.cwd(), '.open-cowork-test')
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, prefix))
}

test('buildOpenCoworkAgentConfig exposes the generic OpenCode agent set', () => {
  const agents = buildOpenCoworkAgentConfig({
    allToolPatterns: [
      'mcp__github__*',
      'github_*',
      'mcp__perplexity__*',
      'perplexity_*',
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
  assert.match(agents.build.prompt, /Use delegation selectively/)
  assert.match(agents.build.prompt, /stay in the parent thread/)
  assert.match(agents.build.prompt, /Available delegated agents:/)
  assert.match(agents.build.prompt, /general \(builtin\): General-purpose delegated agent/)
  assert.match(agents.build.prompt, /charts \(configured\): /)
  assert.equal(agents.build.permission.skill['*'], 'deny')
  assert.equal(agents.build.permission.skill['chart-creator'], 'allow')
  assert.equal(agents.build.permission.skill['skill-creator'], 'allow')
  assert.equal(agents.build.permission['mcp__*'], 'deny')
  assert.equal(agents.build.permission['mcp__github__*'], 'deny')
  assert.equal(agents.build.permission['github_*'], 'deny')
  assert.equal(agents.build.permission.websearch, 'allow')
  assert.equal(agents.plan.permission.task.explore, 'allow')
  assert.equal(agents.plan.permission.todowrite, 'deny')
  assert.match(agents.plan.prompt, /If the user explicitly @mentions a subagent/)
  assert.match(agents.plan.prompt, /explore \(builtin\): Read-only codebase/)
  assert.equal(agents.plan.permission.skill['*'], 'deny')
  assert.equal(agents.plan.permission.skill['chart-creator'], 'allow')
  assert.equal(agents.plan.permission.task.general, undefined)
  assert.equal(agents.general.permission.websearch, 'allow')
  assert.equal(agents.general.permission.webfetch, 'allow')
  assert.equal(agents.general.permission.todowrite, 'deny')
  assert.equal(agents.general.prompt, undefined)
  assert.equal(agents.general.permission.skill['*'], 'deny')
  assert.equal(agents.research.permission['github_*'], 'deny')
  assert.equal(agents.research.permission['perplexity_*'], 'deny')
  assert.equal(agents.explore.prompt, undefined)
  assert.equal(agents.explore.permission.skill['*'], 'deny')
  assert.equal(agents.explore.description.includes('Read-only codebase'), true)
  assert.equal(agents['cowork-exec'].mode, 'primary')
  assert.match(agents['cowork-exec'].prompt, /automation executive/i)
})

test('built-in agent details expose the native OpenCode agent set plus configured built-in agents', () => {
  const builtins = listBuiltInAgentDetails()
  const names = builtins.map((agent) => agent.name)
  assert.deepEqual(names, ['build', 'plan', 'general', 'explore', 'cowork-exec', 'charts', 'skill-builder', 'research'])
  const build = builtins.find((agent) => agent.name === 'build')
  assert.equal(build?.nativeToolIds.includes('websearch'), true)
  assert.equal(build?.nativeToolIds.includes('read'), true)
  assert.equal(build?.configuredToolIds.includes('charts'), true)
  assert.equal(build?.instructions, '')
  const research = builtins.find((agent) => agent.name === 'research')
  assert.deepEqual(research?.nativeToolIds, ['websearch', 'webfetch', 'question'])
  assert.deepEqual(research?.toolAccess, ['Web Search', 'Web Fetch', 'Question'])
  const coworkExec = builtins.find((agent) => agent.name === 'cowork-exec')
  assert.equal(coworkExec?.hidden, true)
  assert.equal(coworkExec?.surface, 'automation')
})

test('custom agents are merged into the OpenCode agent config with narrowed skill and task access', () => {
  const agents = buildOpenCoworkAgentConfig({
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
  assert.equal(agents['repo-maintainer'].permission.bash, 'deny')
  assert.equal(agents['repo-maintainer'].permission.write, 'deny')
  assert.equal(agents['repo-maintainer'].permission.apply_patch, 'deny')
  assert.match(
    agents['repo-maintainer'].prompt,
    /Before substantive work, call the native OpenCode skill tool for each attached skill and follow the loaded instructions: github:github\./,
  )
  assert.match(
    agents['repo-maintainer'].prompt,
    /Do not claim a skill is unavailable unless an attempted skill-tool call fails/,
  )
})

test('custom agents only inherit native bash and file-write policy for selected native tools', () => {
  const agents = buildOpenCoworkAgentConfig({
    allToolPatterns: ['bash', 'write', 'apply_patch'],
    customAgents: [
      {
        name: 'local-editor',
        description: 'Runs local edits.',
        instructions: 'Use native tools carefully.',
        skillNames: [],
        toolNames: ['Native'],
        writeAccess: true,
        color: 'accent',
        allowPatterns: ['bash', 'write'],
        askPatterns: ['apply_patch'],
      },
      {
        name: 'mcp-writer',
        description: 'Uses write-capable MCPs only.',
        instructions: 'Use MCP tools carefully.',
        skillNames: [],
        toolNames: ['MCP'],
        writeAccess: true,
        color: 'warning',
        allowPatterns: ['mcp__github__repos_*'],
        askPatterns: [],
      },
    ],
    bash: 'ask',
    fileWrite: 'allow',
  }) as Record<string, any>

  assert.equal(agents['local-editor'].permission.bash, 'ask')
  assert.equal(agents['local-editor'].permission.edit, 'deny')
  assert.equal(agents['local-editor'].permission.write, 'allow')
  assert.equal(agents['local-editor'].permission.apply_patch, 'ask')
  assert.equal(agents['mcp-writer'].permission.bash, 'deny')
  assert.equal(agents['mcp-writer'].permission.write, 'deny')
  assert.equal(agents['mcp-writer'].permission.apply_patch, 'deny')
})

test('custom agent wildcard web tool patterns keep native web policy enabled', () => {
  const agents = buildOpenCoworkAgentConfig({
    allToolPatterns: ['webfetch', 'websearch', 'codesearch'],
    customAgents: [
      {
        name: 'web-fetcher',
        description: 'Fetch and summarize web context.',
        instructions: 'Use web tools when needed.',
        skillNames: [],
        toolNames: ['Web'],
        writeAccess: false,
        color: 'info',
        allowPatterns: ['web?etch'],
        askPatterns: [],
      },
      {
        name: 'web-searcher',
        description: 'Search and summarize web context.',
        instructions: 'Use search tools when needed.',
        skillNames: [],
        toolNames: ['Web'],
        writeAccess: false,
        color: 'info',
        allowPatterns: ['*search'],
        askPatterns: [],
      },
    ],
    web: 'allow',
    webSearch: 'allow',
  }) as Record<string, any>

  assert.equal(agents['web-fetcher'].permission.webfetch, 'allow')
  assert.equal(agents['web-fetcher'].permission.websearch, 'deny')
  assert.equal(agents['web-fetcher'].permission.codesearch, 'deny')
  assert.equal(agents['web-fetcher'].permission['web?etch'], 'allow')
  assert.equal(agents['web-searcher'].permission.websearch, 'allow')
  assert.equal(agents['web-searcher'].permission.codesearch, 'allow')
  assert.equal(agents['web-searcher'].permission.webfetch, 'deny')
  assert.equal(agents['web-searcher'].permission['*search'], 'allow')
})

test('buildOpenCoworkAgentConfig lets downstream permission policy cap native web and task tools', () => {
  const agents = buildOpenCoworkAgentConfig({
    allToolPatterns: ['websearch', 'webfetch', 'question'],
    web: 'deny',
    webSearch: 'deny',
    task: 'deny',
  }) as Record<string, any>

  assert.equal(agents.build.permission.task, 'deny')
  assert.equal(agents.build.permission.websearch, 'deny')
  assert.equal(agents.general.permission.webfetch, 'deny')
  assert.equal(agents.research.permission.websearch, 'deny')
})

test('configured agents inherit enabled native bash and file-write policy for selected native tools', () => {
  const tempRoot = testTempDir('opencowork-configured-agent-native-tools-')
  const configDir = join(tempRoot, 'downstream')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR

  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), `{
  "agents": [
    {
      "name": "ops-writer",
      "description": "Runs project maintenance commands.",
      "instructions": "Use native tools carefully.",
      "allowTools": ["bash", "write"],
      "askTools": ["apply_patch"],
      "mode": "subagent"
    },
    {
      "name": "repo-reader",
      "description": "Reviews project files without making changes.",
      "instructions": "Read only.",
      "allowTools": ["read", "grep"],
      "mode": "subagent"
    },
    {
      "name": "web-reader",
      "description": "Fetches public documentation with approval.",
      "instructions": "Read only.",
      "askTools": ["webfetch"],
      "mode": "subagent"
    },
    {
      "name": "warehouse-reader",
      "description": "Reads warehouse rows with approval.",
      "instructions": "Read only.",
      "askTools": ["mcp__warehouse__read_rows"],
      "mode": "subagent"
    },
    {
      "name": "warehouse-query-runner",
      "description": "Runs read-only warehouse queries with approval.",
      "instructions": "Read only.",
      "askTools": ["mcp__warehouse__run_query"],
      "mode": "subagent"
    },
    {
      "name": "warehouse-query-executor",
      "description": "Executes read-only warehouse queries with approval.",
      "instructions": "Read only.",
      "askTools": ["mcp__warehouse__execute_query"],
      "mode": "subagent"
    },
    {
      "name": "warehouse-wildcard-reader",
      "description": "Reads all warehouse objects through a wildcard.",
      "instructions": "Read only.",
      "toolIds": ["warehouse-read-tools"],
      "allowTools": ["mcp__warehouse__*"],
      "mode": "subagent"
    },
    {
      "name": "warehouse-writer",
      "description": "Creates warehouse rows.",
      "instructions": "Writes rows.",
      "askTools": ["mcp__warehouse__create_rows"],
      "mode": "subagent"
    },
    {
      "name": "warehouse-allow-writer",
      "description": "Updates warehouse rows without approval.",
      "instructions": "Writes rows.",
      "allowTools": ["mcp__warehouse__update_rows"],
      "mode": "subagent"
    },
    {
      "name": "warehouse-inserter",
      "description": "Inserts warehouse rows.",
      "instructions": "Writes rows.",
      "askTools": ["mcp__warehouse__insert_rows"],
      "mode": "subagent"
    },
    {
      "name": "warehouse-upserter",
      "description": "Upserts warehouse rows.",
      "instructions": "Writes rows.",
      "askTools": ["mcp__warehouse__upsert_rows"],
      "mode": "subagent"
    },
    {
      "name": "warehouse-job-runner",
      "description": "Runs mutating warehouse jobs.",
      "instructions": "Writes rows.",
      "toolIds": ["warehouse-run-job"],
      "mode": "subagent"
    },
    {
      "name": "warehouse-direct-job-runner",
      "description": "Runs mutating warehouse jobs directly.",
      "instructions": "Writes rows.",
      "askTools": ["mcp__warehouse__run_job"],
      "mode": "subagent"
    },
    {
      "name": "warehouse-direct-wildcard",
      "description": "Uses a wildcard without tool metadata.",
      "instructions": "Unknown mutability.",
      "askTools": ["mcp__warehouse__*"],
      "mode": "subagent"
    }
  ],
  "tools": [
    {
      "id": "warehouse-read-tools",
      "name": "Warehouse Read Tools",
      "description": "Reads warehouse objects.",
      "kind": "mcp",
      "writeAccess": false,
      "allowPatterns": ["mcp__warehouse__read_*"]
    },
    {
      "id": "warehouse-run-job",
      "name": "Warehouse Job Runner",
      "description": "Runs mutating warehouse jobs.",
      "kind": "mcp",
      "writeAccess": true,
      "askPatterns": ["mcp__warehouse__run_job"]
    }
  ],
  "permissions": {
    "bash": "ask",
    "fileWrite": "allow",
    "task": "allow",
    "web": "allow",
    "webSearch": true
  }
}
`)

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  clearConfigCaches()

  try {
    const agents = buildOpenCoworkAgentConfig({
      allToolPatterns: [
        'bash',
        'write',
        'apply_patch',
        'read',
        'grep',
        'webfetch',
        'mcp__warehouse__read_rows',
        'mcp__warehouse__run_query',
        'mcp__warehouse__execute_query',
        'mcp__warehouse__create_rows',
        'mcp__warehouse__update_rows',
        'mcp__warehouse__insert_rows',
        'mcp__warehouse__upsert_rows',
        'mcp__warehouse__run_job',
      ],
      bash: 'ask',
      fileWrite: 'allow',
    }) as Record<string, any>

    assert.equal(agents['ops-writer'].permission.bash, 'ask')
    assert.equal(agents['ops-writer'].permission.write, 'allow')
    assert.equal(agents['ops-writer'].permission.edit, 'deny')
    assert.equal(agents['ops-writer'].permission.apply_patch, 'ask')
    assert.equal(agents.plan.permission.task['ops-writer'], undefined)
    assert.equal(agents.plan.permission.task['repo-reader'], 'allow')
    assert.equal(agents.plan.permission.task['web-reader'], 'allow')
    assert.equal(agents.plan.permission.task['warehouse-reader'], 'allow')
    assert.equal(agents.plan.permission.task['warehouse-query-runner'], 'allow')
    assert.equal(agents.plan.permission.task['warehouse-query-executor'], 'allow')
    assert.equal(agents.plan.permission.task['warehouse-wildcard-reader'], 'allow')
    assert.equal(agents.plan.permission.task['warehouse-writer'], undefined)
    assert.equal(agents.plan.permission.task['warehouse-allow-writer'], undefined)
    assert.equal(agents.plan.permission.task['warehouse-inserter'], undefined)
    assert.equal(agents.plan.permission.task['warehouse-upserter'], undefined)
    assert.equal(agents.plan.permission.task['warehouse-job-runner'], undefined)
    assert.equal(agents.plan.permission.task['warehouse-direct-job-runner'], undefined)
    assert.equal(agents.plan.permission.task['warehouse-direct-wildcard'], undefined)
    assert.match(agents.plan.prompt, /repo-reader \(configured\): Reviews project files without making changes\./)
    assert.match(agents.plan.prompt, /web-reader \(configured\): Fetches public documentation with approval\./)
    assert.match(agents.plan.prompt, /warehouse-reader \(configured\): Reads warehouse rows with approval\./)
    assert.match(agents.plan.prompt, /warehouse-query-runner \(configured\): Runs read-only warehouse queries with approval\./)
    assert.match(agents.plan.prompt, /warehouse-query-executor \(configured\): Executes read-only warehouse queries with approval\./)
    assert.match(agents.plan.prompt, /warehouse-wildcard-reader \(configured\): Reads all warehouse objects through a wildcard\./)
    assert.doesNotMatch(agents.plan.prompt, /warehouse-writer \(configured\): Creates warehouse rows\./)
    assert.doesNotMatch(agents.plan.prompt, /warehouse-allow-writer \(configured\): Updates warehouse rows without approval\./)
    assert.doesNotMatch(agents.plan.prompt, /warehouse-inserter \(configured\): Inserts warehouse rows\./)
    assert.doesNotMatch(agents.plan.prompt, /warehouse-upserter \(configured\): Upserts warehouse rows\./)
    assert.doesNotMatch(agents.plan.prompt, /warehouse-job-runner \(configured\): Runs mutating warehouse jobs\./)
    assert.doesNotMatch(agents.plan.prompt, /warehouse-direct-job-runner \(configured\): Runs mutating warehouse jobs directly\./)
    assert.doesNotMatch(agents.plan.prompt, /warehouse-direct-wildcard \(configured\): Uses a wildcard without tool metadata\./)
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('configured built-in agent prompts instruct the model to load attached skills first', () => {
  const agents = buildOpenCoworkAgentConfig({
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
    /Before substantive work, call the native OpenCode skill tool for each attached skill and follow the loaded instructions: chart-creator\./,
  )
  assert.equal(agents.charts.permission['mcp__charts__*'], 'allow')
  assert.equal(agents.charts.permission['charts_*'], 'allow')
  assert.equal(agents.plan.permission.task.charts, 'allow')
  assert.match(
    agents['skill-builder'].prompt,
    /Before substantive work, call the native OpenCode skill tool for each attached skill and follow the loaded instructions: skill-creator\./,
  )
  assert.equal(
    agents.charts.permission.external_directory['/tmp/chart-project/.opencowork/skill-bundles/chart-creator/*'],
    undefined,
  )
})

test('configured charts agent gets explicit external-directory access to the runtime chart skill bundle', () => {
  const agents = buildOpenCoworkAgentConfig({
    allToolPatterns: ['mcp__charts__*'],
    projectDirectory: '/tmp/chart-project',
  }) as Record<string, any>

  assert.equal(
    agents.charts.permission.external_directory['/tmp/chart-project/.opencowork/skill-bundles/chart-creator/*'],
    'allow',
  )
})

test('plan prompt lists readonly custom specialists and build prompt favors them before generic work', () => {
  const agents = buildOpenCoworkAgentConfig({
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
  assert.equal(agents.build.permission.skill['chart-creator'], 'allow')
  assert.equal(agents.plan.permission.skill.analyst, undefined)
  assert.equal(agents['data-analyst'].permission.skill.analyst, 'allow')
  assert.equal(agents['data-analyst'].permission.skill['chart-creator'], 'allow')
  assert.match(
    agents['data-analyst'].prompt,
    /Do not claim a skill is unavailable unless an attempted skill-tool call fails/,
  )
})
