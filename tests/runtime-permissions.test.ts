import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCoworkRuntimePermissionConfig } from '../apps/desktop/src/main/runtime-permissions.ts'
import { buildPermissionConfig } from '../apps/desktop/src/main/permission-config.ts'
import {
  getMachineSkillsDir,
  getRuntimeHomeDir,
  getRuntimeSkillCatalogDir,
} from '../apps/desktop/src/main/runtime-paths.ts'

test('runtime permission config allowlists only Cowork-managed skills and configured MCP patterns', () => {
  const permission = buildCoworkRuntimePermissionConfig({
    managedSkillNames: ['chart-creator', 'skill-creator', 'nova-analyst'],
    allowPatterns: ['mcp__charts__read_chart'],
    askPatterns: ['mcp__skills__save_skill_bundle', 'mcp__nova__*'],
    bash: 'deny',
    fileWrite: 'allow',
    task: 'allow',
    web: 'allow',
    webSearch: 'allow',
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
  assert.equal(permission.external_directory['*'], 'deny')
  assert.equal(
    permission.external_directory[`${getRuntimeSkillCatalogDir()}/chart-creator/*`],
    'allow',
  )
  assert.equal(permission.doom_loop, 'ask')
  assert.equal(Object.prototype.hasOwnProperty.call(permission, 'todoread'), false)
  assert.equal(permission.lsp, 'allow')
  assert.equal(permission.websearch, 'allow')
  assert.equal(permission.bash, 'deny')
  assert.equal(permission.write, 'allow')
})

test('runtime permission config allowlists managed runtime skill directories explicitly', () => {
  const permission = buildCoworkRuntimePermissionConfig({
    managedSkillNames: ['chart-creator', 'skill-creator'],
    allowPatterns: [],
    askPatterns: [],
    bash: 'deny',
    fileWrite: 'deny',
    task: 'deny',
    web: 'allow',
    webSearch: 'allow',
    projectDirectory: '/tmp/open-cowork-project',
  }) as Record<string, any>

  assert.equal(
    permission.external_directory['/tmp/open-cowork-project/.opencowork/skill-bundles/chart-creator/*'],
    'allow',
  )
  assert.equal(
    permission.external_directory[`${getRuntimeSkillCatalogDir()}/chart-creator/*`],
    'allow',
  )
  assert.equal(
    permission.external_directory[`${getMachineSkillsDir()}/skill-creator/*`],
    'allow',
  )
  assert.equal(
    permission.external_directory[`${getRuntimeHomeDir()}/.opencowork/skill-bundles/skill-creator/*`],
    'allow',
  )
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

test('buildPermissionConfig app-level native policies are trailing rules after broad wildcards', () => {
  const permission = buildPermissionConfig({
    allowAllSkills: true,
    allowPatterns: ['*', '*search'],
    web: 'deny',
    webSearch: 'deny',
    bash: 'deny',
    edit: 'deny',
  }) as Record<string, any>
  const keys = Object.keys(permission)

  assert.equal(permission['*'], 'allow')
  assert.equal(permission['*search'], 'allow')
  assert.equal(permission.codesearch, 'deny')
  assert.equal(permission.webfetch, 'deny')
  assert.equal(permission.websearch, 'deny')
  assert.equal(permission.bash, 'deny')
  assert.equal(permission.write, 'deny')
  assert.equal(permission.apply_patch, 'deny')
  assert.ok(keys.indexOf('codesearch') > keys.indexOf('*search'))
  assert.ok(keys.indexOf('websearch') > keys.indexOf('*search'))
  assert.ok(keys.indexOf('webfetch') > keys.indexOf('*'))
  assert.ok(keys.indexOf('bash') > keys.indexOf('*'))
  assert.ok(keys.indexOf('write') > keys.indexOf('*'))
  assert.ok(keys.indexOf('apply_patch') > keys.indexOf('*'))
})

test('runtime permission config honors downstream web and task policy', () => {
  const permission = buildCoworkRuntimePermissionConfig({
    managedSkillNames: [],
    allowPatterns: ['websearch', 'webfetch', 'mcp__charts__*'],
    askPatterns: [],
    bash: 'ask',
    fileWrite: 'deny',
    task: 'ask',
    web: 'allow',
    webSearch: 'deny',
  }) as Record<string, any>

  assert.equal(permission.task, 'ask')
  assert.equal(permission.bash, 'ask')
  assert.equal(permission.write, 'deny')
  assert.equal(permission.webfetch, 'allow')
  assert.equal(permission.codesearch, 'allow')
  assert.equal(permission.websearch, 'deny')
  assert.equal(permission['mcp__charts__*'], 'allow')
})
