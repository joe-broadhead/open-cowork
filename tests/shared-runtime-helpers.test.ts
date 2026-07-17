import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TOOL_TRACE_RULES,
  credentialFieldIsVisible,
  validateCustomAgentDraft,
  validateOpenCodeSkillBundle,
  writeSkillNameIntoFrontmatter,
} from '../packages/shared/dist/index.js'

test('validateCustomAgentDraft reports missing references and duplicate names', () => {
  const issues = validateCustomAgentDraft({
    name: 'researcher',
    description: 'Researches product signals.',
    scope: 'machine',
    siblingNames: ['researcher'],
    availableToolIds: ['time-keep'],
    availableSkillNames: ['time-keep'],
    toolIds: ['missing-tool'],
    skillNames: ['missing-skill'],
  })

  assert.deepEqual(issues.map((issue) => issue.code), [
    'duplicate_name',
    'missing_tool',
    'missing_skill',
  ])
})

test('credentialFieldIsVisible honors eq and neq conditions', () => {
  assert.equal(
    credentialFieldIsVisible({ when: { key: 'mode', op: 'eq', value: 'api' } }, { mode: 'api' }),
    true,
  )
  assert.equal(
    credentialFieldIsVisible({ when: { key: 'mode', op: 'eq', value: 'api' } }, { mode: 'oauth' }),
    false,
  )
  assert.equal(
    credentialFieldIsVisible({ when: { key: 'mode', op: 'neq', value: 'none' } }, { mode: 'api' }),
    true,
  )
})

test('default tool trace rules keep configurable core categories', () => {
  const rulesById = new Map(DEFAULT_TOOL_TRACE_RULES.map((rule) => [rule.id, rule]))

  assert.equal(rulesById.get('skill')?.match[0]?.exact?.includes('skill'), true)
  assert.equal(rulesById.get('task')?.pluralLabel, 'delegations')
  assert.equal(rulesById.get('chart')?.match.some((matcher) => matcher.prefixes?.includes('mcp__charts__')), true)
  assert.equal(rulesById.get('time')?.match.some((matcher) => matcher.prefixes?.includes('time-keep_')), true)
})

test('shared OpenCode skill validation canonicalizes and rejects drift', () => {
  const canonical = writeSkillNameIntoFrontmatter('---\nname: old-name\ndescription: Test skill\n---\nBody', 'new-name')

  assert.match(canonical, /^---\nname: new-name\n/)
  assert.deepEqual(validateOpenCodeSkillBundle({
    name: 'new-name',
    content: canonical,
  }), [])
  assert.match(
    validateOpenCodeSkillBundle({
      name: 'other-name',
      content: canonical,
    })[0] || '',
    /exactly match/,
  )
})
