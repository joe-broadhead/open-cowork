import { getMachineSkillsDir, getRuntimeHomeDir, getRuntimeSkillCatalogDir } from '@open-cowork/runtime-host/runtime-paths'
import { buildManagedExternalDirectoryRules, buildManagedSkillRules, buildPermissionConfig } from '@open-cowork/runtime-host/permission-config'
import test from 'node:test'
import assert from 'node:assert/strict'
import { getProjectOverlayDirName } from '../apps/desktop/src/main/config-loader.ts'

test('buildManagedSkillRules dedupes and sorts skill names deterministically', () => {
  assert.deepEqual(buildManagedSkillRules(['charts', '', 'autoresearch', 'charts']), {
    autoresearch: 'allow',
    charts: 'allow',
  })
})

test('buildManagedExternalDirectoryRules collapses large skill catalogs to managed roots', () => {
  const rules = buildManagedExternalDirectoryRules({
    skillNames: Array.from({ length: 60 }, (_, index) => `skill-${String(index + 1).padStart(2, '0')}`),
    projectDirectory: '/tmp/open-cowork-project',
  })

  assert.deepEqual(rules, {
    [`${getMachineSkillsDir()}/*`]: 'allow',
    [`${getRuntimeSkillCatalogDir()}/*`]: 'allow',
    [`${getRuntimeHomeDir()}/${getProjectOverlayDirName()}/skill-bundles/*`]: 'allow',
    [`/tmp/open-cowork-project/${getProjectOverlayDirName()}/skill-bundles/*`]: 'allow',
  })
  assert.equal(JSON.stringify(rules).length < 600, true)
})

test('buildPermissionConfig keeps app-level native caps stronger than allow patterns', () => {
  const permission = buildPermissionConfig({
    allowPatterns: ['codesearch', 'webfetch', 'websearch', 'bash', 'edit', 'write', 'apply_patch'],
    web: 'deny',
    webSearch: 'deny',
    bash: 'ask',
    edit: 'deny',
  })

  assert.equal(permission.codesearch, 'deny')
  assert.equal(permission.webfetch, 'deny')
  assert.equal(permission.websearch, 'deny')
  assert.equal(permission.bash, 'ask')
  assert.equal(permission.edit, 'deny')
  assert.equal(permission.write, 'deny')
  assert.equal(permission.apply_patch, 'deny')
})

test('buildPermissionConfig requires selected native tool patterns when requested', () => {
  const permission = buildPermissionConfig({
    allowPatterns: ['bash', 'write'],
    bash: 'allow',
    edit: 'allow',
    web: 'allow',
    webSearch: 'allow',
    requireNativeToolPattern: true,
  })

  assert.equal(permission.bash, 'allow')
  assert.equal(permission.write, 'allow')
  assert.equal(permission.edit, 'deny')
  assert.equal(permission.apply_patch, 'deny')
  assert.equal(permission.codesearch, 'deny')
  assert.equal(permission.webfetch, 'deny')
  assert.equal(permission.websearch, 'deny')
})

test('buildPermissionConfig treats ask patterns as stronger than broad allow patterns', () => {
  const permission = buildPermissionConfig({
    askPatterns: ['web*'],
    allowPatterns: ['websearch'],
    web: 'allow',
    webSearch: 'allow',
  })

  assert.equal(permission.webfetch, 'ask')
  assert.equal(permission.websearch, 'ask')
  assert.equal(permission.codesearch, 'allow')
})

test('buildPermissionConfig applies user-denied patterns after generated allow patterns', () => {
  const permission = buildPermissionConfig({
    allowPatterns: ['mcp__github__*'],
    deniedPatterns: ['mcp__github__delete_repo'],
  })

  assert.equal(permission['mcp__github__*'], 'allow')
  assert.equal(permission.mcp__github__delete_repo, 'deny')
})
