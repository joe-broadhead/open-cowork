import { writeManagedSkillMirrorNames } from '@open-cowork/runtime-host/runtime-skill-mirror'
import { getMachineSkillsDir, getManagedSkillsDir, getRuntimeSkillCatalogDir } from '@open-cowork/runtime-host/runtime-paths'
import { copySkillsAndAgents, writeRuntimeAgentsFile } from '@open-cowork/runtime-host/runtime-content'
import { listCustomSkills } from '@open-cowork/runtime-host/native-customizations'
import { listEffectiveSkillsSync } from '@open-cowork/runtime-host/effective-skills'
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
test('writeRuntimeAgentsFile writes the runtime AGENTS mirror privately', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-agents-'))

  try {
    const sourcePath = join(root, 'AGENTS.md')
    const runtimeHome = join(root, 'runtime-home')
    writeFileSync(sourcePath, '# Runtime Instructions\n')

    writeRuntimeAgentsFile(runtimeHome, sourcePath)

    const outputPath = join(runtimeHome, 'AGENTS.md')
    assert.equal(readFileSync(outputPath, 'utf-8'), '# Runtime Instructions\n')
    assert.equal(statSync(outputPath).mode & 0o777, 0o600)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function writeSkillBundle(root: string, name: string, description: string) {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${description}\n`,
  )
  writeFileSync(join(directory, 'notes.md'), `${description}\n`)
}

test('copySkillsAndAgents keeps bundled skills out of the custom-skill discovery dir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-skill-mirror-'))
  const configDir = join(root, 'config')
  const downstreamRoot = join(root, 'downstream')
  const downstreamSkills = join(downstreamRoot, 'skills')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousDownstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  mkdirSync(configDir, { recursive: true })
  mkdirSync(downstreamSkills, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({
    skills: [
      {
        name: 'Keep Skill',
        description: 'Still configured.',
        badge: 'Skill',
        sourceName: 'keep-skill',
        toolIds: [],
      },
    ],
  }, null, 2))
  writeSkillBundle(downstreamSkills, 'keep-skill', 'Still configured')
  writeSkillBundle(downstreamSkills, 'stale-skill', 'Removed from config')

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_DOWNSTREAM_ROOT = downstreamRoot
  process.env.OPEN_COWORK_USER_DATA_DIR = join(root, 'user-data')
  clearConfigCaches()

  try {
    writeSkillBundle(getMachineSkillsDir(), 'stale-skill', 'Removed from config')
    writeSkillBundle(getManagedSkillsDir(), 'stale-skill', 'Removed from config')
    writeSkillBundle(getMachineSkillsDir(), 'user-skill', 'User-authored custom skill')

    copySkillsAndAgents()

    assert.equal(existsSync(join(getMachineSkillsDir(), 'keep-skill', 'SKILL.md')), false)
    assert.equal(existsSync(join(getManagedSkillsDir(), 'keep-skill', 'SKILL.md')), true)
    assert.equal(existsSync(join(getRuntimeSkillCatalogDir(), 'keep-skill', 'SKILL.md')), true)
    assert.equal(existsSync(join(getMachineSkillsDir(), 'stale-skill')), false)
    assert.equal(existsSync(join(getMachineSkillsDir(), 'user-skill', 'SKILL.md')), true)

    const customSkillNames = listCustomSkills().map((skill) => skill.name)
    assert.deepEqual(customSkillNames, ['user-skill'])

    const effectiveSkillNames = listEffectiveSkillsSync().map((skill) => skill.name)
    assert.equal(effectiveSkillNames.includes('keep-skill'), true)
    assert.equal(effectiveSkillNames.includes('user-skill'), true)
    assert.equal(effectiveSkillNames.includes('stale-skill'), false)
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 25))
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousDownstreamRoot === undefined) delete process.env.OPEN_COWORK_DOWNSTREAM_ROOT
    else process.env.OPEN_COWORK_DOWNSTREAM_ROOT = previousDownstreamRoot
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
})

test('custom skills shadow configured bundles without duplicate runtime catalog exposure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-skill-shadow-'))
  const configDir = join(root, 'config')
  const downstreamRoot = join(root, 'downstream')
  const downstreamSkills = join(downstreamRoot, 'skills')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousDownstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  mkdirSync(configDir, { recursive: true })
  mkdirSync(downstreamSkills, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({
    skills: [
      {
        name: 'Bundled Analyst',
        description: 'Configured bundle.',
        badge: 'Skill',
        sourceName: 'analyst',
        toolIds: [],
      },
    ],
  }, null, 2))
  writeSkillBundle(downstreamSkills, 'analyst', 'Configured bundle')

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_DOWNSTREAM_ROOT = downstreamRoot
  process.env.OPEN_COWORK_USER_DATA_DIR = join(root, 'user-data')
  clearConfigCaches()

  try {
    writeSkillBundle(getMachineSkillsDir(), 'analyst', 'Custom analyst')

    copySkillsAndAgents()

    const effectiveAnalyst = listEffectiveSkillsSync().find((skill) => skill.name === 'analyst')
    assert.equal(effectiveAnalyst?.source, 'custom')
    assert.equal(effectiveAnalyst?.description, 'Custom analyst')
    assert.equal(existsSync(join(getMachineSkillsDir(), 'analyst', 'SKILL.md')), true)
    assert.equal(existsSync(join(getManagedSkillsDir(), 'analyst', 'SKILL.md')), true)
    assert.equal(existsSync(join(getRuntimeSkillCatalogDir(), 'analyst', 'SKILL.md')), true)
    assert.match(readFileSync(join(getRuntimeSkillCatalogDir(), 'analyst', 'SKILL.md'), 'utf-8'), /Custom analyst/)
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 25))
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousDownstreamRoot === undefined) delete process.env.OPEN_COWORK_DOWNSTREAM_ROOT
    else process.env.OPEN_COWORK_DOWNSTREAM_ROOT = previousDownstreamRoot
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
})

test('copySkillsAndAgents preserves edited skill mirrors even when an old registry named them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-skill-mirror-edit-'))
  const configDir = join(root, 'config')
  const downstreamRoot = join(root, 'downstream')
  const downstreamSkills = join(downstreamRoot, 'skills')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousDownstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  mkdirSync(configDir, { recursive: true })
  mkdirSync(downstreamSkills, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({ skills: [] }, null, 2))
  writeSkillBundle(downstreamSkills, 'stale-skill', 'Generated source')

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_DOWNSTREAM_ROOT = downstreamRoot
  process.env.OPEN_COWORK_USER_DATA_DIR = join(root, 'user-data')
  clearConfigCaches()

  try {
    writeSkillBundle(getMachineSkillsDir(), 'stale-skill', 'Generated source')
    writeManagedSkillMirrorNames(getMachineSkillsDir(), ['stale-skill'])
    writeSkillBundle(getManagedSkillsDir(), 'stale-skill', 'Generated source')
    writeFileSync(
      join(getMachineSkillsDir(), 'stale-skill', 'SKILL.md'),
      '---\nname: stale-skill\ndescription: User edited skill\n---\n# User edited skill\n',
    )

    copySkillsAndAgents()

    assert.equal(existsSync(join(getMachineSkillsDir(), 'stale-skill', 'SKILL.md')), true)
    assert.equal(listCustomSkills().some((skill) => skill.name === 'stale-skill'), true)
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 25))
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousDownstreamRoot === undefined) delete process.env.OPEN_COWORK_DOWNSTREAM_ROOT
    else process.env.OPEN_COWORK_DOWNSTREAM_ROOT = previousDownstreamRoot
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
})

test('copySkillsAndAgents preserves custom skills that only match unconfigured bundled content', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-skill-mirror-template-'))
  const configDir = join(root, 'config')
  const downstreamRoot = join(root, 'downstream')
  const downstreamSkills = join(downstreamRoot, 'skills')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousDownstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  mkdirSync(configDir, { recursive: true })
  mkdirSync(downstreamSkills, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({ skills: [] }, null, 2))
  writeSkillBundle(downstreamSkills, 'template-skill', 'Template source')

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_DOWNSTREAM_ROOT = downstreamRoot
  process.env.OPEN_COWORK_USER_DATA_DIR = join(root, 'user-data')
  clearConfigCaches()

  try {
    writeSkillBundle(getMachineSkillsDir(), 'template-skill', 'Template source')

    copySkillsAndAgents()

    assert.equal(existsSync(join(getMachineSkillsDir(), 'template-skill', 'SKILL.md')), true)
    assert.equal(listCustomSkills().some((skill) => skill.name === 'template-skill'), true)
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 25))
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousDownstreamRoot === undefined) delete process.env.OPEN_COWORK_DOWNSTREAM_ROOT
    else process.env.OPEN_COWORK_DOWNSTREAM_ROOT = previousDownstreamRoot
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
})
