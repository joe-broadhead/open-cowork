import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentCatalog, CustomAgentConfig } from '../packages/shared/src/index.ts'
import {
  agentInitials,
  applyTemplate,
  compileAgentPreview,
  computeAgentScope,
  linkedSkillNamesForTool,
  resolveMissingSkillTools,
  scopeLabel,
  validateAgentDraft,
  VALID_AGENT_NAME,
} from '../apps/desktop/src/renderer/components/agents/agent-builder-utils.ts'

// Minimal catalog shared across tests. Keeps tool ids + skill names
// stable so assertions can hardcode them.
function makeCatalog(overrides?: Partial<AgentCatalog>): AgentCatalog {
  return {
    tools: [
      { id: 'read', name: 'Read', icon: 'read', description: 'Read a file', supportsWrite: false, source: 'builtin', patterns: ['read', 'read_*'] },
      { id: 'write', name: 'Write', icon: 'write', description: 'Write a file', supportsWrite: true, source: 'builtin', patterns: ['write', 'edit'] },
      { id: 'postgres', name: 'Postgres', icon: 'db', description: 'Query Postgres', supportsWrite: false, source: 'custom', patterns: ['mcp__postgres__*'] },
      { id: 'slack', name: 'Slack', icon: 'slack', description: 'Post to Slack', supportsWrite: true, source: 'custom', patterns: ['mcp__slack__*'] },
    ],
    skills: [
      { name: 'analyst', label: 'Analyst', description: 'DB question answering', source: 'builtin', toolIds: ['postgres'] },
      { name: 'broadcaster', label: 'Broadcaster', description: 'Communicate findings', source: 'custom', toolIds: ['slack'] },
    ],
    reservedNames: ['build', 'plan', 'explore', 'general'],
    colors: ['accent', 'success', 'warning', 'info', 'secondary', 'primary'],
    ...overrides,
  }
}

function makeDraft(overrides?: Partial<CustomAgentConfig>): CustomAgentConfig {
  return {
    scope: 'machine',
    directory: null,
    name: 'test-agent',
    description: 'A test agent',
    instructions: '',
    skillNames: [],
    toolIds: [],
    enabled: true,
    color: 'accent',
    model: null,
    variant: null,
    temperature: null,
    top_p: null,
    steps: null,
    options: null,
    ...overrides,
  }
}

describe('agentInitials', () => {
  it('returns two-letter initials for multi-word names', () => {
    assert.equal(agentInitials('sales-analyst'), 'SA')
    assert.equal(agentInitials('web analyst'), 'WA')
  })
  it('falls back to the first two letters of a single word', () => {
    assert.equal(agentInitials('analyst'), 'AN')
  })
  it('handles single-char and empty names', () => {
    assert.equal(agentInitials('x'), 'X')
    assert.equal(agentInitials(''), 'A')
    assert.equal(agentInitials('   '), 'A')
  })
})

describe('computeAgentScope', () => {
  it('returns read-only when no write-capable tool is selected', () => {
    const catalog = makeCatalog()
    assert.equal(computeAgentScope(['read', 'postgres'], catalog), 'read-only')
  })
  it('returns standard when one or two write tools are selected', () => {
    const catalog = makeCatalog()
    assert.equal(computeAgentScope(['write'], catalog), 'standard')
    assert.equal(computeAgentScope(['write', 'slack'], catalog), 'standard')
  })
  it('returns powerful when three or more write tools are selected', () => {
    const catalog = makeCatalog({
      tools: [
        ...makeCatalog().tools,
        { id: 'email', name: 'Email', icon: 'mail', description: 'Send email', supportsWrite: true, source: 'custom', patterns: ['mcp__email__*'] },
      ],
    })
    assert.equal(computeAgentScope(['write', 'slack', 'email'], catalog), 'powerful')
  })
  it('ignores tool ids not present in the catalog', () => {
    const catalog = makeCatalog()
    assert.equal(computeAgentScope(['write', 'ghost-tool'], catalog), 'standard')
  })
})

describe('scopeLabel', () => {
  it('maps each scope to its display label', () => {
    assert.equal(scopeLabel('read-only'), 'Read only')
    assert.equal(scopeLabel('standard'), 'Standard')
    assert.equal(scopeLabel('powerful'), 'Powerful')
  })
})

describe('resolveMissingSkillTools', () => {
  it('returns the ids the skill requires that are not in the agent loadout', () => {
    const catalog = makeCatalog()
    assert.deepEqual(resolveMissingSkillTools('analyst', [], catalog), ['postgres'])
    assert.deepEqual(resolveMissingSkillTools('analyst', ['postgres'], catalog), [])
  })
  it('returns [] when the skill is unknown or has no tool requirements', () => {
    const catalog = makeCatalog()
    assert.deepEqual(resolveMissingSkillTools('unknown', [], catalog), [])
  })
})

describe('linkedSkillNamesForTool', () => {
  it('returns the skills that reference a given tool id', () => {
    const catalog = makeCatalog()
    assert.deepEqual(linkedSkillNamesForTool(catalog, 'postgres'), ['analyst'])
    assert.deepEqual(linkedSkillNamesForTool(catalog, 'slack'), ['broadcaster'])
    assert.deepEqual(linkedSkillNamesForTool(catalog, 'read'), [])
  })
})

describe('validateAgentDraft', () => {
  const catalog = makeCatalog()
  const baseParams = {
    isExisting: false,
    reservedNames: catalog.reservedNames,
    existingNames: [] as string[],
    projectTargetDirectory: null,
    missingToolCount: 0,
    missingSkillCount: 0,
  }

  it('accepts a well-formed draft', () => {
    assert.equal(validateAgentDraft({ ...baseParams, draft: makeDraft() }).length, 0)
  })

  it('flags missing name, invalid name format, and missing description', () => {
    const issues = validateAgentDraft({
      ...baseParams,
      draft: makeDraft({ name: '', description: '' }),
    })
    const codes = issues.map((issue) => issue.code)
    assert.ok(codes.includes('name-missing'))
    assert.ok(codes.includes('description-missing'))
  })

  it('flags invalid name format', () => {
    const issues = validateAgentDraft({
      ...baseParams,
      draft: makeDraft({ name: 'BAD NAME' }),
    })
    assert.ok(issues.map((issue) => issue.code).includes('name-invalid'))
  })

  it('flags reserved names', () => {
    const issues = validateAgentDraft({
      ...baseParams,
      draft: makeDraft({ name: 'build' }),
    })
    assert.ok(issues.map((issue) => issue.code).includes('name-reserved'))
  })

  it('flags duplicate names only on create', () => {
    const onCreate = validateAgentDraft({
      ...baseParams,
      draft: makeDraft({ name: 'analyst' }),
      existingNames: ['analyst'],
    })
    assert.ok(onCreate.map((issue) => issue.code).includes('name-conflict'))
    const onEdit = validateAgentDraft({
      ...baseParams,
      draft: makeDraft({ name: 'analyst' }),
      existingNames: ['analyst'],
      isExisting: true,
    })
    assert.ok(!onEdit.map((issue) => issue.code).includes('name-conflict'))
  })

  it('flags project scope with no directory selected', () => {
    const issues = validateAgentDraft({
      ...baseParams,
      draft: makeDraft({ scope: 'project', directory: null }),
      projectTargetDirectory: null,
    })
    assert.ok(issues.map((issue) => issue.code).includes('project-directory-missing'))
  })

  it('flags missing refs when the draft still references unavailable tools or skills', () => {
    const issues = validateAgentDraft({
      ...baseParams,
      draft: makeDraft(),
      missingToolCount: 1,
    })
    assert.ok(issues.map((issue) => issue.code).includes('missing-refs'))
  })
})

describe('applyTemplate', () => {
  it('filters template tool/skill references against the live catalog', () => {
    const catalog = makeCatalog()
    const patch = applyTemplate({
      id: 'data-analyst',
      label: 'Data Analyst',
      description: 'Answer data questions',
      color: 'info',
      instructions: 'Be specific',
      toolIds: ['postgres', 'ghost-tool'],
      skillNames: ['analyst', 'unknown-skill'],
      temperature: 0.2,
      steps: 30,
    }, catalog)
    assert.deepEqual(patch.toolIds, ['postgres'])
    assert.deepEqual(patch.skillNames, ['analyst'])
    assert.equal(patch.temperature, 0.2)
    assert.equal(patch.steps, 30)
    assert.equal(patch.instructions, 'Be specific')
  })
})

describe('compileAgentPreview', () => {
  it('resolves selected tools / skills and surfaces missing refs', () => {
    const catalog = makeCatalog()
    const preview = compileAgentPreview(
      makeDraft({ toolIds: ['postgres', 'ghost'], skillNames: ['analyst', 'gone'] }),
      catalog,
    )
    assert.equal(preview.selectedTools.length, 1)
    assert.equal(preview.selectedTools[0].id, 'postgres')
    assert.deepEqual(preview.missingTools, ['ghost'])
    assert.deepEqual(preview.missingSkills, ['gone'])
    assert.equal(preview.mentionAs, '@test-agent')
    assert.equal(preview.scope, 'read-only')
  })
})

describe('VALID_AGENT_NAME regex', () => {
  it('accepts lowercase-hyphen names and rejects anything else', () => {
    assert.match('sales-analyst', VALID_AGENT_NAME)
    assert.match('a', VALID_AGENT_NAME)
    assert.match('v1-name-2', VALID_AGENT_NAME)
    assert.doesNotMatch('Sales-Analyst', VALID_AGENT_NAME)
    assert.doesNotMatch('sales_analyst', VALID_AGENT_NAME)
    assert.doesNotMatch('-leading', VALID_AGENT_NAME)
    assert.doesNotMatch('trailing-', VALID_AGENT_NAME)
  })
})
