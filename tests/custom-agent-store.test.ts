import { getMachineAgentsDir } from '@open-cowork/runtime-host/runtime-paths'
import { listCustomAgents, removeCustomAgent, saveCustomAgent } from '@open-cowork/runtime-host/native-customizations'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
function withTempUserData<T>(fn: () => T): T {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-custom-agent-store-'))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  process.env.OPEN_COWORK_USER_DATA_DIR = root
  clearConfigCaches()
  try {
    return fn()
  } finally {
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
}

test('custom agent store saves, updates, lists, and removes machine agents', () => withTempUserData(() => {
  assert.equal(saveCustomAgent({
    scope: 'machine',
    directory: null,
    name: 'weekly-analyst',
    description: 'Analyze weekly business performance.',
    instructions: 'Load the analyst skill and write a concise weekly summary.',
    skillNames: ['analyst'],
    toolIds: ['websearch'],
    enabled: true,
    color: 'success',
    avatar: null,
    deniedToolPatterns: ['bash'],
    model: 'openrouter/deepseek/deepseek-v4-flash:free',
    temperature: 0.2,
    steps: 20,
  }, { websearch: 'allow', bash: 'deny' }), true)

  const saved = listCustomAgents().find((entry) => entry.name === 'weekly-analyst')
  assert.equal(saved?.description, 'Analyze weekly business performance.')
  assert.equal(saved?.enabled, true)
  assert.equal(saved?.color, 'success')
  assert.deepEqual(saved?.skillNames, ['analyst'])
  assert.deepEqual(saved?.toolIds, ['websearch'])
  assert.deepEqual(saved?.deniedToolPatterns, ['bash'])
  assert.equal(saved?.model, 'openrouter/deepseek/deepseek-v4-flash:free')

  assert.equal(saveCustomAgent({
    scope: 'machine',
    directory: null,
    name: 'weekly-analyst',
    description: 'Updated analyst.',
    instructions: 'Updated instructions.',
    skillNames: [],
    toolIds: [],
    enabled: false,
    color: 'accent',
    avatar: 'WA',
  }, { websearch: 'deny' }), true)

  const updated = listCustomAgents().find((entry) => entry.name === 'weekly-analyst')
  assert.equal(updated?.description, 'Updated analyst.')
  assert.equal(updated?.enabled, false)
  assert.equal(updated?.color, 'accent')
  assert.equal(updated?.avatar, 'WA')
  assert.deepEqual(updated?.skillNames, [])
  assert.deepEqual(updated?.toolIds, [])

  assert.equal(removeCustomAgent({ scope: 'machine', directory: null, name: 'weekly-analyst' }), true)
  assert.equal(listCustomAgents().some((entry) => entry.name === 'weekly-analyst'), false)
}))

test('custom agent store rejects invalid removal names before touching the filesystem', () => withTempUserData(() => {
  assert.throws(() => {
    removeCustomAgent({ scope: 'machine', directory: null, name: '../weekly-analyst' })
  }, /single managed file name/)
}))

test('custom agent store reconciles interrupted enabled-disabled file pairs', () => withTempUserData(() => {
  assert.equal(saveCustomAgent({
    scope: 'machine',
    directory: null,
    name: 'weekly-analyst',
    description: 'Enabled copy.',
    instructions: 'Enabled instructions.',
    skillNames: [],
    toolIds: [],
    enabled: true,
    color: 'accent',
  }, {}), true)

  const disabledPath = join(getMachineAgentsDir(), 'weekly-analyst.disabled.md')
  writeFileSync(disabledPath, [
    '---',
    'description: "Disabled copy."',
    '---',
    '',
    'Disabled instructions.',
    '',
  ].join('\n'))
  const newer = new Date(Date.now() + 2_000)
  utimesSync(disabledPath, newer, newer)

  const agent = listCustomAgents().find((entry) => entry.name === 'weekly-analyst')
  assert.equal(agent?.enabled, false)
  assert.equal(agent?.description, 'Disabled copy.')
  assert.equal(agent?.instructions, 'Disabled instructions.')
}))

test('custom agent store prefers disabled copies when interrupted file pairs tie', () => withTempUserData(() => {
  assert.equal(saveCustomAgent({
    scope: 'machine',
    directory: null,
    name: 'weekly-analyst',
    description: 'Enabled copy.',
    instructions: 'Enabled instructions.',
    skillNames: [],
    toolIds: [],
    enabled: true,
    color: 'accent',
  }, {}), true)

  const root = getMachineAgentsDir()
  const enabledPath = join(root, 'weekly-analyst.md')
  const disabledPath = join(root, 'weekly-analyst.disabled.md')
  writeFileSync(disabledPath, [
    '---',
    'description: "Disabled copy."',
    '---',
    '',
    'Disabled instructions.',
    '',
  ].join('\n'))
  const sameTimestamp = new Date('2026-05-26T10:00:00.000Z')
  utimesSync(enabledPath, sameTimestamp, sameTimestamp)
  utimesSync(disabledPath, sameTimestamp, sameTimestamp)

  const agent = listCustomAgents().find((entry) => entry.name === 'weekly-analyst')
  assert.equal(agent?.enabled, false)
  assert.equal(agent?.description, 'Disabled copy.')
}))
