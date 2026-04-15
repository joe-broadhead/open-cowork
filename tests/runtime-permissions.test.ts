import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCoworkRuntimePermissionConfig } from '../apps/desktop/src/main/runtime-permissions.ts'

test('runtime permission config allowlists only Cowork-managed skills and configured MCP patterns', () => {
  const permission = buildCoworkRuntimePermissionConfig({
    managedSkillNames: ['chart-creator', 'skill-creator', 'nova-analyst'],
    allowPatterns: ['mcp__charts__read_chart'],
    askPatterns: ['mcp__skills__save_skill_bundle', 'mcp__nova__*'],
    allowBash: false,
    allowEdits: true,
  }) as Record<string, any>

  assert.deepEqual(permission.skill, {
    '*': 'deny',
    'chart-creator': 'allow',
    'nova-analyst': 'allow',
    'skill-creator': 'allow',
  })
  assert.equal(permission['mcp__*'], 'deny')
  assert.equal(permission['mcp__charts__read_chart'], 'allow')
  assert.equal(permission['mcp__skills__save_skill_bundle'], 'ask')
  assert.equal(permission['mcp__nova__*'], 'ask')
  assert.equal(permission.websearch, 'allow')
  assert.equal(permission.bash, 'deny')
  assert.equal(permission.write, 'allow')
})
