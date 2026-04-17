import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCoworkRuntimePermissionConfig } from '../apps/desktop/src/main/runtime-permissions.ts'
import { buildPermissionConfig } from '../apps/desktop/src/main/permission-config.ts'

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

test('buildPermissionConfig per-tool denies coexist with the parent MCP wildcard allow', () => {
  const permission = buildPermissionConfig({
    allowAllSkills: true,
    toolPatternsToDeny: ['mcp__github__*'],
    allowPatterns: ['mcp__github__*'],
    deniedPatterns: ['mcp__github__delete_repo'],
  }) as Record<string, any>

  // The MCP's wildcard stays allowed so the rest of the methods work.
  assert.equal(permission['mcp__github__*'], 'allow')
  // The specific method is a separate key, denied — OpenCode resolves by
  // specificity, so this narrows the agent without dropping the MCP.
  assert.equal(permission['mcp__github__delete_repo'], 'deny')
})
