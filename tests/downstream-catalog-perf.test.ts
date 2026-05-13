import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOpenCoworkAgentConfig } from '../apps/desktop/src/main/agent-config.ts'
import { buildCoworkRuntimePermissionConfig } from '../apps/desktop/src/main/runtime-permissions.ts'
import { buildCapabilityMapGroups } from '../apps/desktop/src/renderer/components/capabilities/capabilities-page-support.ts'
import {
  createDownstreamCatalogFixture,
  DOWNSTREAM_AGENT_COUNT,
  DOWNSTREAM_SKILL_COUNT,
  DOWNSTREAM_TOOL_COUNT,
} from '../scripts/perf/downstream-catalog-fixture.ts'

test('downstream-sized catalog fixture exercises large skills, tools, and agents', () => {
  const fixture = createDownstreamCatalogFixture()

  assert.equal(fixture.skills.length, DOWNSTREAM_SKILL_COUNT)
  assert.equal(fixture.tools.length, DOWNSTREAM_TOOL_COUNT)
  assert.equal(fixture.customAgents.length, DOWNSTREAM_AGENT_COUNT)
})

test('downstream-sized runtime permissions stay bounded for large skill catalogs', () => {
  const fixture = createDownstreamCatalogFixture()
  const permission = buildCoworkRuntimePermissionConfig({
    managedSkillNames: fixture.skillNames,
    allowPatterns: fixture.allowPatterns,
    askPatterns: fixture.askPatterns,
    bash: 'ask',
    fileWrite: 'ask',
    task: 'allow',
    web: 'allow',
    webSearch: 'allow',
    projectDirectory: '/tmp/open-cowork-downstream-project',
  }) as Record<string, any>

  assert.equal(Object.keys(permission.external_directory).length, 5)
  assert.equal(permission.skill['*'], 'deny')
  assert.equal(Object.keys(permission.skill).length, DOWNSTREAM_SKILL_COUNT + 1)
  assert.equal(JSON.stringify(permission).length < 16_000, true)
})

test('built-in agent permissions do not repeat every managed skill in downstream catalogs', () => {
  const fixture = createDownstreamCatalogFixture()
  const agents = buildOpenCoworkAgentConfig({
    allToolPatterns: fixture.allToolPatterns,
    allowToolPatterns: fixture.allowPatterns,
    askToolPatterns: fixture.askPatterns,
    managedSkillNames: fixture.skillNames,
    availableSkillNames: fixture.skillNames,
    bash: 'ask',
    fileWrite: 'ask',
    task: 'allow',
    web: 'allow',
    webSearch: 'allow',
    projectDirectory: '/tmp/open-cowork-downstream-project',
    customAgents: fixture.customAgents,
  }) as Record<string, any>

  assert.equal(agents.build.permission.skill, 'allow')
  assert.equal(agents.plan.permission.skill, 'allow')
  assert.equal(agents.general.permission.skill, 'allow')
  assert.equal(agents.explore.permission.skill, 'allow')
  assert.equal(agents['agent-01'].permission.skill['skill-01'], 'allow')
})

test('capability map groups remain deterministic with downstream-sized catalogs', () => {
  const fixture = createDownstreamCatalogFixture()
  const groups = buildCapabilityMapGroups(fixture.tools, fixture.skills, 'tool 01')

  assert.ok(groups.length > 0)
  assert.deepEqual(
    groups.map((group) => group.label),
    [...groups.map((group) => group.label)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
  )
})
