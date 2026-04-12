import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCustomAgentCatalog, buildRuntimeCustomAgents, summarizeCustomAgents } from '../apps/desktop/src/main/custom-agents-utils.ts'

const fixtureBundles = [
  {
    id: 'github',
    name: 'GitHub',
    icon: 'github',
    description: 'Repository and pull request workflows.',
    skills: [
      { name: 'GitHub', description: 'Triage repository work.', sourceName: 'github:github' },
    ],
    credentials: [
      { key: 'token', required: true },
    ],
    mcps: [
      { headerSettings: [{ key: 'token' }] },
    ],
    agentAccess: {
      readToolPatterns: ['mcp__github__repos_*', 'mcp__github__pull_request_read'],
      writeToolPatterns: ['mcp__github__create_pull_request', 'mcp__github__add_issue_comment'],
    },
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    icon: 'perplexity',
    description: 'External web research.',
    skills: [],
    credentials: [
      { key: 'apiKey', required: true },
    ],
    mcps: [
      { envSettings: [{ key: 'apiKey' }] },
    ],
    agentAccess: {
      readToolPatterns: ['mcp__perplexity__perplexity_ask', 'mcp__perplexity__perplexity_search'],
    },
  },
] as const

const baseSettings = {
  customMcps: [],
  customSkills: [],
  customAgents: [],
  integrationCredentials: {},
}

test('custom agent catalog only exposes integrations with configured credentials', () => {
  const catalog = buildCustomAgentCatalog({
    enabledBundles: fixtureBundles as any,
    customSkills: [],
    settings: {
      ...baseSettings,
      integrationCredentials: {
        github: { token: 'github_pat_test' },
      },
    },
  })

  assert.deepEqual(catalog.integrations.map((integration) => integration.id), ['github'])
  assert.equal(catalog.integrations[0]?.supportsWrite, true)
  assert.equal(catalog.skills.some((skill) => skill.name === 'github:github'), true)
  assert.equal(catalog.reservedNames.includes('assistant'), true)
})

test('custom agent catalog includes custom skills alongside configured bundle skills', () => {
  const catalog = buildCustomAgentCatalog({
    enabledBundles: fixtureBundles as any,
    customSkills: [{ name: 'sales-review', content: '---\ndescription: "Review quarterly sales"\n---\n# Sales Review' }],
    settings: {
      ...baseSettings,
      integrationCredentials: {
        github: { token: 'github_pat_test' },
      },
    },
  })

  assert.equal(catalog.skills.some((skill) => skill.name === 'sales-review' && skill.source === 'custom'), true)
})

test('custom agents become invalid when they collide with reserved names or lose dependencies', () => {
  const settings = {
    ...baseSettings,
    customSkills: [{ name: 'sales-review', content: '---\ndescription: "Review quarterly sales"\n---\n# Sales Review' }],
    customAgents: [
      {
        name: 'assistant',
        description: 'Should fail',
        instructions: '',
        skillNames: ['sales-review'],
        integrationIds: ['github'],
        enabled: true,
        color: 'accent' as const,
      },
      {
        name: 'repo-maintainer',
        description: 'Handle repository work',
        instructions: '',
        skillNames: ['missing-skill'],
        integrationIds: ['github'],
        enabled: true,
        color: 'accent' as const,
      },
    ],
    integrationCredentials: {
      github: { token: 'github_pat_test' },
    },
  }

  const summaries = summarizeCustomAgents({
    settings,
    enabledBundles: fixtureBundles as any,
  })

  assert.equal(summaries[0]?.valid, false)
  assert.equal(summaries[0]?.issues.some((issue) => issue.code === 'reserved_name'), true)
  assert.equal(summaries[1]?.valid, false)
  assert.equal(summaries[1]?.issues.some((issue) => issue.code === 'missing_skill'), true)
})

test('runtime custom agents derive allow and ask patterns from selected integrations', () => {
  const runtimeAgents = buildRuntimeCustomAgents({
    settings: {
      ...baseSettings,
      customSkills: [{ name: 'sales-review', content: '# Sales Review' }],
      customAgents: [
        {
          name: 'repo-maintainer',
          description: 'Handle repository work',
          instructions: 'Work carefully.',
          skillNames: ['sales-review'],
          integrationIds: ['github'],
          enabled: true,
          color: 'accent' as const,
        },
      ],
      integrationCredentials: {
        github: { token: 'github_pat_test' },
      },
    },
    enabledBundles: fixtureBundles as any,
  })

  assert.equal(runtimeAgents.length, 1)
  assert.equal(runtimeAgents[0]?.name, 'repo-maintainer')
  assert.deepEqual(runtimeAgents[0]?.skillNames, ['sales-review'])
  assert.equal(runtimeAgents[0]?.writeAccess, true)
  assert.equal(runtimeAgents[0]?.allowPatterns.includes('mcp__github__repos_*'), true)
  assert.equal(runtimeAgents[0]?.askPatterns.includes('mcp__github__create_pull_request'), true)
})
