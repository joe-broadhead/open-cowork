import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { buildAgentPermission, buildOpenCoworkAgentConfig } from '../apps/desktop/src/main/agent-config.ts'
import { listBuiltInAgentDetails } from '../apps/desktop/src/main/built-in-agent-details.ts'
import { clearSettingsCache } from '../apps/desktop/src/main/settings.ts'

function testTempDir(prefix: string) {
  const parent = join(process.cwd(), '.open-cowork-test')
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, prefix))
}

function withIsolatedSettings<T>(name: string, run: () => T): T {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = testTempDir(name)
  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
    clearConfigCaches()
    clearSettingsCache()
    return run()
  } finally {
    clearSettingsCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
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
    general: 'allow',
    explore: 'allow',
    autoresearch: 'allow',
    charts: 'allow',
    'skill-builder': 'allow',
    'agent-builder': 'allow',
    'workflow-designer': 'allow',
    research: 'allow',
  })
  assert.equal(agents.build.permission.todowrite, 'allow')
  assert.match(agents.build.prompt, /Use delegation selectively/)
  assert.match(agents.build.prompt, /stay in the parent thread/)
  assert.match(agents.build.prompt, /Do not launch multiple subagents with materially identical goals/)
  assert.match(agents.build.prompt, /Available delegated agents:/)
  assert.match(agents.build.prompt, /general \(builtin\): General-purpose delegated agent/)
  assert.match(agents.build.prompt, /charts \(configured\): /)
  assert.equal(agents.build.permission.skill, 'allow')
  assert.equal(agents.build.permission['mcp__*'], 'deny')
  assert.equal(agents.build.permission['mcp__github__*'], 'deny')
  assert.equal(agents.build.permission['github_*'], 'deny')
  assert.equal(agents.build.permission.websearch, 'allow')
  assert.equal(agents.plan.permission.task.explore, 'allow')
  assert.equal(agents.plan.permission.todowrite, 'deny')
  assert.match(agents.plan.prompt, /If the user explicitly @mentions a subagent/)
  assert.match(agents.plan.prompt, /explore \(builtin\): Read-only codebase/)
  assert.equal(agents.plan.permission.skill, 'allow')
  assert.equal(agents.plan.permission.task.general, undefined)
  assert.equal(agents.general.permission.websearch, 'allow')
  assert.equal(agents.general.permission.webfetch, 'allow')
  assert.equal(agents.general.permission.todowrite, 'deny')
  assert.equal(agents.general.prompt, undefined)
  assert.equal(agents.general.permission.skill, 'allow')
  assert.equal(agents.research.permission['github_*'], 'deny')
  assert.equal(agents.research.permission['perplexity_*'], 'deny')
  assert.equal(agents.explore.prompt, undefined)
  assert.equal(agents.explore.permission.skill, 'allow')
  assert.equal(agents.explore.description.includes('Read-only codebase'), true)
  assert.equal(agents['executive-assistant'].mode, 'primary')
  assert.match(agents['executive-assistant'].prompt, /Executive Assistant/i)
  assert.equal(agents.autoresearch.permission.skill.autoresearch, 'allow')
  assert.equal(agents.autoresearch.permission.skill['skill-creator'], 'allow')
  assert.equal(agents.autoresearch.permission.skill['agent-creator'], 'allow')
  assert.equal(agents.autoresearch.permission.bash, 'deny')
  assert.equal(agents.autoresearch.permission.write, 'deny')
  assert.equal(agents.autoresearch.permission['mcp__skills__save_skill_bundle'], 'ask')
  assert.equal(agents.autoresearch.permission['mcp__agents__preview_agent'], 'allow')
  assert.equal(agents.autoresearch.permission['mcp__agents__save_agent'], 'ask')
  assert.match(agents.autoresearch.prompt, /Load the autoresearch skill first/i)
  assert.match(agents.autoresearch.prompt, /Open Cowork Autoresearch agent/i)
  assert.equal(agents['agent-builder'].permission.skill['agent-creator'], 'allow')
  assert.equal(agents['agent-builder'].permission['mcp__agents__preview_agent'], 'allow')
  assert.equal(agents['agent-builder'].permission['mcp__agents__save_agent'], 'ask')
  assert.equal(agents['workflow-designer'].permission.skill['workflow-creator'], 'allow')
  assert.equal(agents['workflow-designer'].permission['mcp__workflows__preview_workflow'], 'allow')
  assert.equal(agents['workflow-designer'].permission['mcp__workflows__create_workflow'], 'ask')
  assert.match(agents['workflow-designer'].prompt, /workflow designer/i)
})

test('buildAgentPermission derives native access from selected tool patterns', () => {
  const permission = buildAgentPermission({
    allToolPatterns: ['bash', 'webfetch', 'websearch', 'write', 'apply_patch'],
    allowPatterns: ['webfetch', 'bash', 'write'],
    web: 'allow',
    webSearch: 'allow',
    bash: 'ask',
    fileWrite: 'allow',
    nativeToolPatterns: ['webfetch', 'bash', 'write'],
    nativeWriteAccess: false,
    requireNativeToolPattern: true,
  }) as Record<string, any>

  assert.equal(permission.webfetch, 'allow')
  assert.equal(permission.websearch, 'deny')
  assert.equal(permission.bash, 'deny')
  assert.equal(permission.write, 'deny')
  assert.equal(permission.apply_patch, 'deny')
})

test('generated permission config enforces app-level bash deny after broad allow patterns', () => {
  const permission = buildAgentPermission({
    allToolPatterns: ['bash', 'webfetch', 'mcp__safe__read'],
    allowPatterns: ['*'],
    web: 'allow',
    webSearch: 'allow',
    bash: 'deny',
    fileWrite: 'deny',
    nativeToolPatterns: ['bash', 'webfetch'],
    nativeWriteAccess: true,
    requireNativeToolPattern: true,
  }) as Record<string, unknown>

  assert.equal(permission['*'], 'allow')
  assert.equal(permission.webfetch, 'allow')
  assert.equal(permission.bash, 'deny')
  assert.equal(permission.write, 'deny')
  assert.equal(permission.apply_patch, 'deny')
})

test('built-in agent details expose the native OpenCode agent set plus configured built-in agents', () => withIsolatedSettings('agent-details-', () => {
  const builtins = listBuiltInAgentDetails()
  const names = builtins.map((agent) => agent.name)
  assert.deepEqual(names, ['build', 'plan', 'general', 'explore', 'autoresearch', 'executive-assistant', 'charts', 'skill-builder', 'agent-builder', 'workflow-designer', 'research'])
  const build = builtins.find((agent) => agent.name === 'build')
  assert.equal(build?.nativeToolIds.includes('websearch'), true)
  assert.equal(build?.nativeToolIds.includes('read'), true)
  assert.equal(build?.configuredToolIds.includes('charts'), true)
  assert.equal(build?.instructions, '')
  const research = builtins.find((agent) => agent.name === 'research')
  assert.deepEqual(research?.nativeToolIds, ['websearch', 'webfetch', 'question'])
  assert.deepEqual(research?.toolAccess, ['Web Search', 'Web Fetch', 'Question'])
  const executiveAssistant = builtins.find((agent) => agent.name === 'executive-assistant')
  assert.equal(executiveAssistant?.hidden, true)
  assert.equal(executiveAssistant?.surface, 'workflow')
  assert.equal(executiveAssistant?.label, 'Executive Assistant')
  const autoresearch = builtins.find((agent) => agent.name === 'autoresearch')
  assert.deepEqual(autoresearch?.skills, ['autoresearch', 'skill-creator', 'agent-creator'])
  assert.deepEqual(autoresearch?.configuredToolIds, ['charts', 'skills', 'agents'])
  assert.deepEqual(autoresearch?.nativeToolIds, ['read', 'grep', 'glob', 'list', 'websearch', 'webfetch', 'bash', 'edit', 'write', 'apply_patch', 'question'])
  const agentBuilder = builtins.find((agent) => agent.name === 'agent-builder')
  assert.deepEqual(agentBuilder?.skills, ['agent-creator'])
  assert.deepEqual(agentBuilder?.configuredToolIds, ['agents'])
  const workflowDesigner = builtins.find((agent) => agent.name === 'workflow-designer')
  assert.deepEqual(workflowDesigner?.skills, ['workflow-creator'])
  assert.deepEqual(workflowDesigner?.configuredToolIds, ['workflows'])
}))

test('custom agents are native files and only shape built-in delegation config', () => {
  const agents = buildOpenCoworkAgentConfig({
    allToolPatterns: [
      'mcp__github__*',
      'mcp__perplexity__*',
    ],
    customDelegationAgents: [
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
  assert.equal(agents['repo-maintainer'], undefined)
})

test('disabled custom agents are not injected into config.agent or delegated to', () => {
  const agents = buildOpenCoworkAgentConfig({
    allToolPatterns: ['mcp__github__*'],
    customDelegationAgents: [
      {
        name: 'parked-specialist',
        description: 'Valid but disabled by the user.',
        instructions: 'Stay parked.',
        skillNames: [],
        toolNames: ['GitHub'],
        writeAccess: true,
        color: 'warning',
        allowPatterns: ['mcp__github__repos_*'],
        askPatterns: [],
        deniedPatterns: [],
        disabled: true,
      },
    ],
  }) as Record<string, any>

  assert.equal(agents['parked-specialist'], undefined)
  assert.equal(agents.build.permission.task['parked-specialist'], undefined)
  assert.doesNotMatch(agents.build.prompt, /parked-specialist \(custom\)/)
})

test('custom delegation agents do not add duplicate native agent configs for selected tools', () => {
  const agents = buildOpenCoworkAgentConfig({
    allToolPatterns: ['bash', 'write', 'apply_patch'],
    customDelegationAgents: [
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

  assert.equal(agents.build.permission.task['local-editor'], 'allow')
  assert.equal(agents.build.permission.task['mcp-writer'], 'allow')
  assert.equal(agents['local-editor'], undefined)
  assert.equal(agents['mcp-writer'], undefined)
})

test('custom delegation agents only affect task access and prompts', () => {
  const agents = buildOpenCoworkAgentConfig({
    allToolPatterns: ['webfetch', 'websearch', 'codesearch'],
    customDelegationAgents: [
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

  assert.equal(agents.build.permission.task['web-fetcher'], 'allow')
  assert.equal(agents.build.permission.task['web-searcher'], 'allow')
  assert.equal(agents.plan.permission.task['web-fetcher'], 'allow')
  assert.equal(agents.plan.permission.task['web-searcher'], 'allow')
  assert.match(agents.build.prompt, /web-fetcher \(custom\): Fetch and summarize web context\./)
  assert.match(agents.plan.prompt, /web-searcher \(custom\): Search and summarize web context\./)
  assert.equal(agents['web-fetcher'], undefined)
  assert.equal(agents['web-searcher'], undefined)
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
      'bash',
      'write',
      'apply_patch',
      'websearch',
      'webfetch',
      'question',
    ],
    bash: 'ask',
    fileWrite: 'allow',
  }) as Record<string, any>

  assert.match(
    agents.charts.prompt,
    /Call `skill` with `\{"name":"chart-creator"\}`\./,
  )
  assert.equal(agents.charts.permission['mcp__charts__*'], 'allow')
  assert.equal(agents.charts.permission['charts_*'], 'allow')
  assert.equal(agents.plan.permission.task.charts, 'allow')
  assert.match(
    agents['skill-builder'].prompt,
    /Call `skill` with `\{"name":"skill-creator"\}`\./,
  )
  assert.match(
    agents['agent-builder'].prompt,
    /Call `skill` with `\{"name":"agent-creator"\}`\./,
  )
  assert.equal(agents['agent-builder'].permission['mcp__agents__preview_agent'], 'allow')
  assert.equal(agents['agent-builder'].permission['mcp__agents__save_agent'], 'ask')
  assert.match(
    agents['workflow-designer'].prompt,
    /Call `skill` with `\{"name":"workflow-creator"\}`\./,
  )
  assert.equal(agents['workflow-designer'].permission['mcp__workflows__preview_workflow'], 'allow')
  assert.equal(agents['workflow-designer'].permission['mcp__workflows__create_workflow'], 'ask')
  assert.match(
    agents.autoresearch.prompt,
    /Load the autoresearch skill first/i,
  )
  assert.equal(agents.autoresearch.permission.bash, 'ask')
  assert.equal(agents.autoresearch.permission.write, 'ask')
  assert.equal(agents.autoresearch.permission.apply_patch, 'ask')
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
    agents.charts.permission.external_directory['/tmp/chart-project/.opencowork/skill-bundles/*'],
    'allow',
  )
})

test('plan prompt lists readonly custom specialists and build prompt favors them before generic work', () => {
  const agents = buildOpenCoworkAgentConfig({
    allToolPatterns: [
      'mcp__nova__*',
      'mcp__charts__*',
    ],
    customDelegationAgents: [
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
  assert.equal(agents.build.permission.skill, 'allow')
  assert.equal(agents.plan.permission.skill, 'allow')
  assert.equal(agents.build.permission.task['data-analyst'], 'allow')
  assert.equal(agents.plan.permission.task['data-analyst'], 'allow')
  assert.equal(agents['data-analyst'], undefined)
})
