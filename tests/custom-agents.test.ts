import test from 'node:test'
import assert from 'node:assert/strict'
import { BUILTIN_INTEGRATION_BUNDLES } from '../apps/desktop/src/main/integration-bundles.ts'
import { buildCustomAgentCatalog, buildRuntimeCustomAgents, summarizeCustomAgents } from '../apps/desktop/src/main/custom-agents-utils.ts'

const baseSettings = {
  provider: 'databricks' as const,
  defaultModel: 'databricks-claude-sonnet-4',
  gcpProjectId: null,
  gcpRegion: 'global',
  databricksHost: null,
  databricksToken: null,
  githubToken: null,
  perplexityApiKey: null,
  customMcps: [],
  customSkills: [],
  customAgents: [],
  enableBash: false,
  enableFileWrite: false,
}

test('custom agent catalog includes enabled integrations with valid access profiles', () => {
  const catalog = buildCustomAgentCatalog({
    enabledBundles: BUILTIN_INTEGRATION_BUNDLES.filter((bundle) => ['nova-analytics', 'google-workspace', 'github'].includes(bundle.id)),
    customSkills: [],
    settings: {
      ...baseSettings,
      githubToken: 'github_pat_test',
    },
  })

  assert.ok(catalog.integrations.find((integration) => integration.id === 'nova-analytics'))
  assert.ok(catalog.integrations.find((integration) => integration.id === 'google-workspace')?.supportsWrite)
  assert.equal(catalog.integrations.find((integration) => integration.id === 'github')?.supportsWrite, true)
  assert.ok(catalog.skills.find((skill) => skill.name === 'analyst'))
  assert.ok(catalog.reservedNames.includes('cowork'))
})

test('custom agent catalog honors env-backed MCP credentials for local built-in bundles', () => {
  const bundles = BUILTIN_INTEGRATION_BUNDLES.filter((bundle) => bundle.id === 'perplexity')

  const withoutKey = buildCustomAgentCatalog({
    enabledBundles: bundles,
    customSkills: [],
    settings: {
      ...baseSettings,
      perplexityApiKey: null,
    },
  })
  assert.equal(withoutKey.integrations.some((integration) => integration.id === 'perplexity'), false)

  const withKey = buildCustomAgentCatalog({
    enabledBundles: bundles,
    customSkills: [],
    settings: {
      ...baseSettings,
      perplexityApiKey: 'pplx_test_key',
    },
  })
  assert.equal(withKey.integrations.some((integration) => integration.id === 'perplexity'), true)
})

test('custom agents become invalid when they collide with reserved names or lose dependencies', () => {
  const settings = {
    ...baseSettings,
    customSkills: [{ name: 'sales-review', content: '---\ndescription: "Review quarterly sales"\n---\n# Sales Review' }],
    customAgents: [
      {
        name: 'cowork',
        description: 'Should fail',
        instructions: '',
        skillNames: ['sales-review'],
        integrationIds: ['nova-analytics'],
        enabled: true,
        color: 'accent' as const,
      },
      {
        name: 'sales-analyst',
        description: 'Analyze sales',
        instructions: '',
        skillNames: ['missing-skill'],
        integrationIds: ['nova-analytics'],
        enabled: true,
        color: 'accent' as const,
      },
    ],
  }

  const summaries = summarizeCustomAgents({
    settings,
    enabledBundles: BUILTIN_INTEGRATION_BUNDLES.filter((bundle) => bundle.id === 'nova-analytics'),
  })

  assert.equal(summaries[0]?.valid, false)
  assert.equal(summaries[0]?.issues.some((issue) => issue.code === 'reserved_name'), true)
  assert.equal(summaries[1]?.valid, false)
  assert.equal(summaries[1]?.issues.some((issue) => issue.code === 'missing_skill'), true)
})

test('runtime custom agents compile selected skills and curated tool patterns', () => {
  const runtimeAgents = buildRuntimeCustomAgents({
    settings: {
      ...baseSettings,
      customSkills: [{ name: 'sales-review', content: '---\ndescription: "Review quarterly sales"\n---\n# Sales Review' }],
      customAgents: [
        {
          name: 'sales-analyst',
          description: 'Analyze sales trends',
          instructions: 'Focus on YoY comparisons.',
          skillNames: ['sales-review'],
          integrationIds: ['nova-analytics'],
          enabled: true,
          color: 'accent' as const,
        },
      ],
    },
    enabledBundles: BUILTIN_INTEGRATION_BUNDLES.filter((bundle) => bundle.id === 'nova-analytics'),
  })

  assert.equal(runtimeAgents.length, 1)
  assert.equal(runtimeAgents[0]?.name, 'sales-analyst')
  assert.deepEqual(runtimeAgents[0]?.skillNames, ['sales-review'])
  assert.equal(runtimeAgents[0]?.allowPatterns.includes('mcp__nova__*'), true)
  assert.equal(runtimeAgents[0]?.allowPatterns.includes('mcp__charts__*'), true)
  assert.deepEqual(runtimeAgents[0]?.askPatterns, [])
})

test('selected integrations imply full curated access and derived write capability', () => {
  const runtimeAgents = buildRuntimeCustomAgents({
    settings: {
      ...baseSettings,
      githubToken: 'github_pat_test',
      customAgents: [
        {
          name: 'repo-maintainer',
          description: 'Handle repository work',
          instructions: 'Work carefully.',
          skillNames: [],
          integrationIds: ['github'],
          enabled: true,
          color: 'accent' as const,
        },
      ],
    },
    enabledBundles: BUILTIN_INTEGRATION_BUNDLES.filter((bundle) => bundle.id === 'github'),
  })

  assert.equal(runtimeAgents[0]?.writeAccess, true)
  assert.equal(runtimeAgents[0]?.allowPatterns.some((pattern) => pattern.startsWith('mcp__github__')), true)
  assert.equal(runtimeAgents[0]?.askPatterns.includes('mcp__github__*'), true)
})
