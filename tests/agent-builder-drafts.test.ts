import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type {
  BuiltInAgentDetail,
  CustomAgentSummary,
  RuntimeAgentDescriptor,
} from '../packages/shared/src/index.ts'
import {
  blankAgentDraft,
  buildInitialAgentDraft,
  draftFromBuiltInAgent,
  draftFromCustomAgent,
  draftFromRuntimeAgent,
} from '../apps/desktop/src/renderer/components/agents/agent-builder-drafts.ts'

function makeCustomAgent(overrides?: Partial<CustomAgentSummary>): CustomAgentSummary {
  return {
    scope: 'project',
    directory: '/project',
    name: 'custom-agent',
    description: 'Custom description',
    instructions: 'Do the custom work',
    skillNames: ['analysis'],
    toolIds: ['postgres'],
    enabled: true,
    color: 'info',
    avatar: 'CA',
    model: 'provider/model',
    variant: 'large',
    temperature: 0.2,
    top_p: 0.9,
    steps: 25,
    options: { reasoning: 'medium' },
    deniedToolPatterns: ['mcp__postgres__write'],
    writeAccess: false,
    valid: true,
    issues: [],
    ...overrides,
  }
}

function makeBuiltInAgent(overrides?: Partial<BuiltInAgentDetail>): BuiltInAgentDetail {
  return {
    name: 'plan',
    label: 'Plan',
    source: 'open-cowork',
    mode: 'primary',
    hidden: false,
    disabled: false,
    color: 'accent',
    description: 'Plan work',
    instructions: 'Plan carefully',
    skills: ['planning'],
    toolAccess: ['read'],
    nativeToolIds: ['read', 'bash'],
    configuredToolIds: ['charts', 'read'],
    avatar: null,
    model: null,
    variant: null,
    temperature: null,
    top_p: null,
    steps: null,
    options: null,
    ...overrides,
  }
}

function makeRuntimeAgent(overrides?: Partial<RuntimeAgentDescriptor>): RuntimeAgentDescriptor {
  return {
    name: 'runtime-agent',
    description: 'Registered by runtime',
    model: 'runtime/model',
    color: 'success',
    disabled: false,
    ...overrides,
  }
}

describe('blankAgentDraft', () => {
  it('dedupes seeded references and keeps project directories only for project scope', () => {
    const draft = blankAgentDraft({
      scope: 'project',
      directory: '/repo',
      skillNames: ['charts', 'charts'],
      toolIds: ['read', 'read'],
      deniedToolPatterns: ['mcp__x__write', 'mcp__x__write'],
    })

    assert.equal(draft.scope, 'project')
    assert.equal(draft.directory, '/repo')
    assert.deepEqual(draft.skillNames, ['charts'])
    assert.deepEqual(draft.toolIds, ['read'])
    assert.deepEqual(draft.deniedToolPatterns, ['mcp__x__write'])

    assert.equal(blankAgentDraft({ scope: 'machine', directory: '/ignored' }).directory, null)
  })
})

describe('draftFromCustomAgent', () => {
  it('copies persisted custom-agent fields into an editable draft', () => {
    const draft = draftFromCustomAgent(makeCustomAgent())

    assert.equal(draft.name, 'custom-agent')
    assert.equal(draft.scope, 'project')
    assert.equal(draft.directory, '/project')
    assert.deepEqual(draft.skillNames, ['analysis'])
    assert.deepEqual(draft.toolIds, ['postgres'])
    assert.deepEqual(draft.deniedToolPatterns, ['mcp__postgres__write'])
    assert.equal(draft.model, 'provider/model')
  })
})

describe('draftFromBuiltInAgent', () => {
  it('merges native and configured tools without duplicates', () => {
    const draft = draftFromBuiltInAgent(makeBuiltInAgent())

    assert.deepEqual(draft.toolIds, ['read', 'bash', 'charts'])
    assert.deepEqual(draft.skillNames, ['planning'])
    assert.equal(draft.enabled, true)
  })

  it('describes OpenCode-owned prompts when native built-ins expose no instructions', () => {
    const draft = draftFromBuiltInAgent(makeBuiltInAgent({
      source: 'opencode',
      instructions: '',
      name: 'build',
    }))

    assert.match(draft.instructions, /OpenCode's native built-in prompt/)
    assert.match(draft.instructions, /Open Cowork/)
  })
})

describe('draftFromRuntimeAgent', () => {
  it('normalizes runtime descriptors into read-only draft shape', () => {
    const draft = draftFromRuntimeAgent(makeRuntimeAgent({ disabled: true, description: null }))

    assert.equal(draft.name, 'runtime-agent')
    assert.equal(draft.description, '')
    assert.equal(draft.enabled, false)
    assert.equal(draft.model, 'runtime/model')
    assert.deepEqual(draft.skillNames, [])
    assert.deepEqual(draft.toolIds, [])
  })
})

describe('buildInitialAgentDraft', () => {
  it('dispatches draft creation by target kind', () => {
    assert.equal(buildInitialAgentDraft({ kind: 'new', seed: { name: 'seeded' } }).name, 'seeded')
    assert.equal(buildInitialAgentDraft({ kind: 'custom', agent: makeCustomAgent({ name: 'custom' }) }).name, 'custom')
    assert.equal(buildInitialAgentDraft({ kind: 'builtin', agent: makeBuiltInAgent({ name: 'builtin' }) }).name, 'builtin')
    assert.equal(buildInitialAgentDraft({ kind: 'runtime', agent: makeRuntimeAgent({ name: 'runtime' }) }).name, 'runtime')
  })
})
