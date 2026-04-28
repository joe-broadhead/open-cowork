import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCustomAgentCatalog, buildRuntimeCustomAgents, summarizeCustomAgents } from '../apps/desktop/src/main/custom-agents-utils.ts'

const builtinTools = [
  {
    id: 'github',
    name: 'GitHub',
    icon: 'github',
    description: 'Repository and pull request workflows.',
    kind: 'mcp' as const,
    allowPatterns: ['mcp__github__repos_*', 'mcp__github__pull_request_read'],
    askPatterns: ['mcp__github__create_pull_request', 'mcp__github__add_issue_comment'],
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    icon: 'perplexity',
    description: 'External web research.',
    kind: 'mcp' as const,
    allowPatterns: ['mcp__perplexity__perplexity_ask', 'mcp__perplexity__perplexity_search'],
  },
] as const

const builtinSkills = [
  {
    name: 'GitHub',
    description: 'Triage repository work.',
    badge: 'Skill' as const,
    sourceName: 'github:github',
    toolIds: ['github'],
  },
] as const

const baseSettings = {
  customMcps: [],
  customSkills: [],
  customAgents: [],
  integrationCredentials: {},
}

test('custom agent catalog exposes configured built-in tools and skills', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    customMcps: [],
    customSkills: [],
    state: baseSettings,
  })

  assert.deepEqual(catalog.tools.map((tool) => tool.id), ['github', 'perplexity'])
  assert.equal(catalog.tools[0]?.supportsWrite, true)
  assert.equal(catalog.skills.some((skill) => skill.name === 'github:github'), true)
  assert.equal(catalog.reservedNames.includes('build'), true)
})

test('custom agent catalog includes custom skills alongside bundled skills', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    customMcps: [],
    customSkills: [{ name: 'sales-review', content: '---\ndescription: "Review quarterly sales"\n---\n# Sales Review' }],
    state: baseSettings,
  })

  assert.equal(catalog.skills.some((skill) => skill.name === 'sales-review' && skill.source === 'custom'), true)
})

test('custom agent catalog includes native runtime tools with native permissions', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    runtimeTools: [
      { id: 'websearch', description: 'Search the web.' },
      { id: 'bash', description: 'Execute shell commands.' },
    ],
    customMcps: [],
    customSkills: [],
    state: baseSettings,
  })

  const websearch = catalog.tools.find((tool) => tool.id === 'websearch')
  const bash = catalog.tools.find((tool) => tool.id === 'bash')

  assert.equal(websearch?.name, 'Web Search')
  assert.deepEqual(websearch?.allowPatterns, ['websearch'])
  assert.deepEqual(websearch?.askPatterns, [])
  assert.equal(websearch?.supportsWrite, false)

  assert.equal(bash?.name, 'Bash')
  assert.deepEqual(bash?.allowPatterns, [])
  assert.deepEqual(bash?.askPatterns, ['bash'])
  assert.equal(bash?.supportsWrite, true)
})

test('custom agent catalog accepts the effective Cowork-only skill catalog', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    availableSkills: [
      {
        name: 'analyst',
        label: 'Analyst',
        description: 'Analyze metrics and compare trends.',
        source: 'custom',
        origin: 'custom',
        scope: 'project',
        location: '/tmp/project/.opencowork/skills/analyst/SKILL.md',
      },
    ],
    customMcps: [],
    customSkills: [],
    state: baseSettings,
  })

  assert.equal(catalog.skills.some((skill) => skill.name === 'analyst'), true)
})

test('custom agents become invalid when they collide with reserved names or lose dependencies', () => {
  const settings = {
    ...baseSettings,
    customSkills: [{ name: 'sales-review', content: '---\ndescription: "Review quarterly sales"\n---\n# Sales Review' }],
    customAgents: [
      {
        name: 'build',
        description: 'Should fail',
        instructions: '',
        skillNames: ['sales-review'],
        toolIds: ['github'],
        enabled: true,
        color: 'accent' as const,
      },
      {
        name: 'repo-maintainer',
        description: 'Handle repository work',
        instructions: '',
        skillNames: ['missing-skill'],
        toolIds: ['github'],
        enabled: true,
        color: 'accent' as const,
      },
    ],
  }

  const summaries = summarizeCustomAgents({
    state: settings,
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
  })

  assert.equal(summaries[0]?.valid, false)
  assert.equal(summaries[0]?.issues.some((issue) => issue.code === 'reserved_name'), true)
  assert.equal(summaries[1]?.valid, false)
  assert.equal(summaries[1]?.issues.some((issue) => issue.code === 'missing_skill'), true)
})

test('custom agent summaries preserve avatar metadata for renderer cards', () => {
  const summaries = summarizeCustomAgents({
    state: {
      ...baseSettings,
      customAgents: [
        {
          name: 'insights',
          description: 'Investigate dashboards',
          instructions: 'Work carefully.',
          skillNames: [],
          toolIds: ['github'],
          enabled: true,
          color: 'accent' as const,
          avatar: 'data:image/png;base64,FAKE',
        },
      ],
    },
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
  })

  assert.equal(summaries[0]?.avatar, 'data:image/png;base64,FAKE')
})

test('runtime custom agents derive allow and ask patterns from selected tools', () => {
  const runtimeAgents = buildRuntimeCustomAgents({
    state: {
      ...baseSettings,
      customSkills: [{ name: 'sales-review', content: '# Sales Review' }],
      customAgents: [
        {
          name: 'repo-maintainer',
          description: 'Handle repository work',
          instructions: 'Work carefully.',
          skillNames: ['sales-review'],
          toolIds: ['github'],
          enabled: true,
          color: 'accent' as const,
        },
      ],
    },
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
  })

  assert.equal(runtimeAgents.length, 1)
  assert.equal(runtimeAgents[0]?.name, 'repo-maintainer')
  assert.deepEqual(runtimeAgents[0]?.skillNames, ['sales-review'])
  assert.equal(runtimeAgents[0]?.writeAccess, true)
  assert.equal(runtimeAgents[0]?.allowPatterns.includes('mcp__github__repos_*'), true)
  assert.equal(runtimeAgents[0]?.askPatterns.includes('mcp__github__create_pull_request'), true)
})

test('runtime custom agents carry deniedToolPatterns through to the SDK payload', () => {
  const runtimeAgents = buildRuntimeCustomAgents({
    state: {
      ...baseSettings,
      customAgents: [
        {
          name: 'scoped-maintainer',
          description: 'Narrowly scoped repo maintainer',
          instructions: 'Do not delete anything.',
          skillNames: [],
          toolIds: ['github'],
          enabled: true,
          color: 'accent' as const,
          deniedToolPatterns: ['mcp__github__delete_repo', '  ', 'mcp__github__delete_repo'],
        },
      ],
    },
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
  })

  assert.equal(runtimeAgents.length, 1)
  // Entries should be de-duped, trimmed, and expanded to both known
  // OpenCode MCP permission spellings so the SDK gets a clean list.
  assert.deepEqual(runtimeAgents[0]?.deniedPatterns, ['mcp__github__delete_repo', 'github_delete_repo'])
  // The parent MCP's allow stays intact — only the specific method is denied.
  assert.equal(runtimeAgents[0]?.allowPatterns.includes('mcp__github__repos_*'), true)
})

test('custom MCP tools default to ask-only access', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    customMcps: [
      {
        name: 'warehouse',
        label: 'Warehouse',
        description: 'Custom warehouse MCP',
      },
    ],
    customSkills: [],
    state: baseSettings,
  })

  const warehouse = catalog.tools.find((tool) => tool.id === 'warehouse')
  assert.deepEqual(warehouse?.allowPatterns, [])
  assert.deepEqual(warehouse?.askPatterns, ['mcp__warehouse__*', 'warehouse_*'])
})

test('trusted custom MCP tools become allow access', () => {
  const catalog = buildCustomAgentCatalog({
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
    customMcps: [
      {
        name: 'warehouse',
        label: 'Warehouse',
        description: 'Custom warehouse MCP',
        permissionMode: 'allow',
      },
    ],
    customSkills: [],
    state: baseSettings,
  })

  const warehouse = catalog.tools.find((tool) => tool.id === 'warehouse')
  assert.deepEqual(warehouse?.allowPatterns, ['mcp__warehouse__*', 'warehouse_*'])
  assert.deepEqual(warehouse?.askPatterns, [])
})

test('runtime custom agents inherit trusted custom MCP allow patterns', () => {
  const runtimeAgents = buildRuntimeCustomAgents({
    state: {
      ...baseSettings,
      customMcps: [
        {
          name: 'nova',
          label: 'Nova',
          description: 'Data analysis MCP',
          permissionMode: 'allow',
        },
      ],
      customAgents: [
        {
          name: 'data-analyst',
          description: 'Analyze business metrics',
          instructions: 'Use Nova for metric lookup.',
          skillNames: [],
          toolIds: ['nova'],
          enabled: true,
          color: 'accent' as const,
        },
      ],
    },
    builtinTools: builtinTools as any,
    builtinSkills: builtinSkills as any,
  })

  assert.equal(runtimeAgents.length, 1)
  assert.deepEqual(runtimeAgents[0]?.allowPatterns, ['mcp__nova__*', 'nova_*'])
  assert.deepEqual(runtimeAgents[0]?.askPatterns, [])
})
