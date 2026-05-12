import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  listCustomMcps,
  listCustomAgents,
  removeCustomMcp,
  saveCustomMcp,
  saveCustomAgent,
  removeCustomAgent,
  syncCustomAgentRuntimeGuidance,
} from '../apps/desktop/src/main/native-customizations.ts'

function testTempDir(prefix: string) {
  const parent = join(process.cwd(), '.open-cowork-test')
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, prefix))
}

test('project-scoped MCP edits preserve JSONC comments and unrelated keys', () => {
  const projectRoot = testTempDir('opencowork-native-config-')
  const configPath = join(projectRoot, '.opencowork', 'config.jsonc')
  const metadataPath = join(projectRoot, '.opencowork', 'mcp.open-cowork.json')
  mkdirSync(join(projectRoot, '.opencowork'), { recursive: true })

  writeFileSync(configPath, `{
  // keep this comment
  "theme": "keep",
  "mcp": {
    "existing": {
      "type": "remote",
      "url": "https://example.test/mcp"
    }
  }
}
`)

  try {
    saveCustomMcp({
      scope: 'project',
      directory: projectRoot,
      name: 'warehouse',
      label: 'Warehouse',
      description: 'Warehouse MCP',
      type: 'http',
      url: 'https://warehouse.example.test/mcp',
      allowPrivateNetwork: true,
      permissionMode: 'allow',
    })

    let updated = readFileSync(configPath, 'utf-8')
    assert.match(updated, /keep this comment/)
    assert.match(updated, /"theme": "keep"/)
    assert.match(updated, /"existing"/)
    assert.match(updated, /"warehouse"/)
    assert.doesNotMatch(updated, /Warehouse MCP/)
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'))
    assert.equal(metadata.warehouse.description, 'Warehouse MCP')
    assert.equal(metadata.warehouse.allowPrivateNetwork, true)
    assert.equal(metadata.warehouse.permissionMode, 'allow')

    const savedMcp = listCustomMcps({ directory: projectRoot }).find((entry) => entry.name === 'warehouse')
    assert.ok(savedMcp)
    assert.equal(savedMcp.allowPrivateNetwork, true)
    assert.equal(savedMcp.permissionMode, 'allow')

    removeCustomMcp({
      scope: 'project',
      directory: projectRoot,
      name: 'warehouse',
    })

    updated = readFileSync(configPath, 'utf-8')
    assert.match(updated, /keep this comment/)
    assert.match(updated, /"theme": "keep"/)
    assert.match(updated, /"existing"/)
    assert.doesNotMatch(updated, /"warehouse"/)
    assert.equal(existsSync(metadataPath), false)
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('custom MCP auth opt-ins round-trip through managed sidecar metadata', () => {
  const projectRoot = testTempDir('opencowork-native-mcp-flags-')

  try {
    saveCustomMcp({
      scope: 'project',
      directory: projectRoot,
      name: 'workspace',
      label: 'Workspace',
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      googleAuth: true,
      permissionMode: 'allow',
    })

    const savedMcp = listCustomMcps({ directory: projectRoot }).find((entry) => entry.name === 'workspace')
    assert.ok(savedMcp)
    assert.equal(savedMcp.googleAuth, true)
    assert.equal(savedMcp.permissionMode, 'allow')

    const metadataPath = join(projectRoot, '.opencowork', 'mcp.open-cowork.json')
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'))
    assert.equal(metadata.workspace.googleAuth, true)
    assert.equal(metadata.workspace.permissionMode, 'allow')
  } finally {
    removeCustomMcp({ scope: 'project', directory: projectRoot, name: 'workspace' })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('custom MCP definitions reject unbounded renderer payloads', () => {
  const projectRoot = testTempDir('opencowork-native-mcp-limits-')

  try {
    assert.throws(
      () => saveCustomMcp({
        scope: 'project',
        directory: projectRoot,
        name: 'huge-mcp',
        label: 'Huge MCP',
        description: 'x'.repeat(3 * 1024),
        type: 'http',
        url: 'https://example.test/mcp',
      }),
      /MCP description is too large/,
    )
    assert.equal(listCustomMcps({ directory: projectRoot }).some((entry) => entry.name === 'huge-mcp'), false)
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('custom agents derive tool and skill selections from native markdown permissions without a sidecar', () => {
  const projectRoot = testTempDir('opencowork-native-agents-')
  const agentsDir = join(projectRoot, '.opencowork', 'agents')
  const configPath = join(projectRoot, '.opencowork', 'config.json')

  mkdirSync(agentsDir, { recursive: true })
  writeFileSync(configPath, JSON.stringify({
    mcp: {
      warehouse: {
        type: 'remote',
        url: 'https://warehouse.example.test/mcp',
      },
    },
  }, null, 2))
  writeFileSync(join(agentsDir, 'insights.md'), `---
description: "Investigate dashboards and chart data"
mode: subagent
permission:
  skill:
    "chart-creator": allow
  "mcp__charts__*": allow
  "mcp__warehouse__run_query": ask
  webfetch: allow
  websearch: allow
---

Work carefully.
`)

  try {
    const agent = listCustomAgents({ directory: projectRoot }).find((entry) => entry.name === 'insights')
    assert.ok(agent)
    assert.deepEqual(agent.skillNames, ['chart-creator'])
    assert.deepEqual(agent.toolIds, ['charts', 'warehouse', 'webfetch', 'websearch'])
    assert.equal(agent.color, 'accent')
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('custom agent builder selections round-trip through managed sidecar metadata', () => {
  const projectRoot = testTempDir('opencowork-native-agent-loadout-')

  try {
    saveCustomAgent(
      {
        scope: 'project',
        directory: projectRoot,
        name: 'researcher',
        description: 'Researches a topic with native web tools.',
        instructions: 'Use the selected tools and skills.',
        skillNames: ['analyst', 'chart-creator'],
        toolIds: ['websearch', 'webfetch'],
        enabled: true,
        color: 'info',
        avatar: null,
        model: 'openai/gpt-5.5',
        variant: null,
        temperature: 0.2,
        top_p: null,
        steps: 25,
        options: { reasoningEffort: 'medium' },
        deniedToolPatterns: ['mcp__github__delete_repo'],
      },
      {
        skill: {
          analyst: 'allow',
          'chart-creator': 'allow',
        },
        websearch: 'allow',
        webfetch: 'allow',
        mcp__github__delete_repo: 'deny',
      },
    )

    const agent = listCustomAgents({ directory: projectRoot }).find((entry) => entry.name === 'researcher')
    assert.ok(agent)
    assert.equal(agent.instructions, 'Use the selected tools and skills.')
    assert.deepEqual(agent.skillNames, ['analyst', 'chart-creator'])
    assert.deepEqual(agent.toolIds, ['websearch', 'webfetch'])
    assert.deepEqual(agent.deniedToolPatterns, ['mcp__github__delete_repo'])
    assert.equal(agent.model, 'openai/gpt-5.5')
    assert.equal(agent.temperature, 0.2)
    assert.equal(agent.steps, 25)
    assert.deepEqual(agent.options, { reasoningEffort: 'medium' })

    const metadataPath = join(projectRoot, '.opencowork', 'agents', 'researcher.opencowork.json')
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf-8'))
    assert.deepEqual(metadata.skillNames, ['analyst', 'chart-creator'])
    assert.deepEqual(metadata.toolIds, ['websearch', 'webfetch'])

    const markdownPath = join(projectRoot, '.opencowork', 'agents', 'researcher.md')
    const markdown = readFileSync(markdownPath, 'utf-8')
    assert.match(markdown, / {2}skill:\n {4}"\*": deny\n {4}"analyst": allow\n {4}"chart-creator": allow/)
    assert.match(markdown, /open-cowork:runtime-directive:start/)
    assert.match(markdown, /Attached skills: analyst, chart-creator/)
    assert.match(markdown, /Mandatory first action/)
    assert.match(markdown, /Call `skill` with `\{"name":"analyst"\}`\./)
    assert.match(markdown, /Use the selected tools and skills\./)
  } finally {
    removeCustomAgent({ scope: 'project', directory: projectRoot, name: 'researcher' })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('removeCustomAgent removes contained legacy names while rejecting path-like names', () => {
  const projectRoot = testTempDir('opencowork-native-agent-remove-policy-')
  const coworkDir = join(projectRoot, '.opencowork')
  const agentsDir = join(coworkDir, 'agents')
  mkdirSync(agentsDir, { recursive: true })
  const markerPath = join(coworkDir, 'outside.md')
  const legacyAgentPath = join(agentsDir, 'Legacy Agent.md')
  writeFileSync(markerPath, 'keep')
  writeFileSync(legacyAgentPath, 'remove')

  try {
    removeCustomAgent({ scope: 'project', directory: projectRoot, name: 'Legacy Agent' })
    assert.equal(existsSync(legacyAgentPath), false)

    assert.throws(() => {
      removeCustomAgent({ scope: 'project', directory: projectRoot, name: '../outside' })
    }, /Custom agent id must be a single managed file name/)

    assert.equal(existsSync(markerPath), true)
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('runtime guidance is backfilled into existing native custom agent markdown without polluting editor instructions', () => {
  const projectRoot = testTempDir('opencowork-native-agent-guidance-')
  const agentsDir = join(projectRoot, '.opencowork', 'agents')

  mkdirSync(agentsDir, { recursive: true })
  writeFileSync(join(agentsDir, 'analyst.md'), `---
description: "Answer business questions"
mode: subagent
steps: 20
permission:
  skill:
    "analyst": allow
    "chart-creator": allow
  "mcp__nova__*": ask
---

Use Nova carefully.
`)

  try {
    syncCustomAgentRuntimeGuidance({ directory: projectRoot })

    const markdown = readFileSync(join(agentsDir, 'analyst.md'), 'utf-8')
    assert.match(markdown, /steps: 20/)
    assert.match(markdown, / {2}skill:\n {4}"\*": deny\n {4}"analyst": allow\n {4}"chart-creator": allow/)
    assert.match(markdown, /open-cowork:runtime-directive:start/)
    assert.match(markdown, /Attached skills: analyst, chart-creator/)
    assert.match(markdown, /Call `skill` with `\{"name":"chart-creator"\}`\./)
    assert.match(markdown, /Use Nova carefully\./)

    const agent = listCustomAgents({ directory: projectRoot }).find((entry) => entry.name === 'analyst')
    assert.ok(agent)
    assert.equal(agent.instructions, 'Use Nova carefully.')
    assert.deepEqual(agent.skillNames, ['analyst', 'chart-creator'])
  } finally {
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('runtime guidance rewrite failures do not abort startup sync', () => {
  const projectRoot = testTempDir('opencowork-native-agent-guidance-readonly-')
  const agentsDir = join(projectRoot, '.opencowork', 'agents')
  const agentPath = join(agentsDir, 'analyst.md')

  mkdirSync(agentsDir, { recursive: true })
  writeFileSync(agentPath, `---
description: "Answer business questions"
mode: subagent
permission:
  skill:
    "analyst": allow
---

Use Nova carefully.
`)
  chmodSync(agentsDir, 0o555)

  try {
    assert.doesNotThrow(() => syncCustomAgentRuntimeGuidance({ directory: projectRoot }))
    const markdown = readFileSync(agentPath, 'utf-8')
    assert.doesNotMatch(markdown, /open-cowork:runtime-directive:start/)
  } finally {
    chmodSync(agentsDir, 0o755)
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('custom agent avatars round-trip through the managed sidecar metadata', () => {
  const projectRoot = testTempDir('opencowork-native-agent-avatar-')

  try {
    saveCustomAgent(
      {
        scope: 'project',
        directory: projectRoot,
        name: 'insights',
        description: 'Investigate dashboards and chart data',
        instructions: 'Work carefully.',
        skillNames: [],
        toolIds: [],
        enabled: true,
        color: 'accent',
        avatar: 'data:image/png;base64,FAKE',
      },
      {
        question: 'allow',
        edit: 'deny',
        bash: 'deny',
      },
    )

    const agent = listCustomAgents({ directory: projectRoot }).find((entry) => entry.name === 'insights')
    assert.ok(agent)
    assert.equal(agent?.avatar, 'data:image/png;base64,FAKE')
  } finally {
    removeCustomAgent({ scope: 'project', directory: projectRoot, name: 'insights' })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})
