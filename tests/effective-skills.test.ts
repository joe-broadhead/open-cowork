import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  getEffectiveSkillBundleSync,
  readEffectiveSkillBundleFile,
} from '../apps/desktop/src/main/effective-skills.ts'
import { findBundledSkillDir } from '../apps/desktop/src/main/runtime-content.ts'

function testTempDir(prefix: string) {
  const parent = join(process.cwd(), '.open-cowork-test')
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, prefix))
}

test('effective skill bundle file reads reject traversal and symlinks outside the bundle root', async () => {
  const tempRoot = testTempDir('opencowork-effective-skills-')
  const configDir = join(tempRoot, 'config')
  const downstreamRoot = join(tempRoot, 'downstream')
  const skillRoot = join(downstreamRoot, 'skills', 'leak-test')
  const outsideFile = join(tempRoot, 'outside.md')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousDownstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT

  mkdirSync(configDir, { recursive: true })
  mkdirSync(skillRoot, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({
    skills: [
      {
        name: 'Leak Test',
        description: 'Test skill bundle path handling.',
        badge: 'Skill',
        sourceName: 'leak-test',
        toolIds: [],
      },
    ],
  }, null, 2))
  writeFileSync(
    join(skillRoot, 'SKILL.md'),
    '---\nname: leak-test\ndescription: Test skill bundle path handling.\n---\n# Leak Test\n',
  )
  writeFileSync(join(skillRoot, 'safe.md'), 'safe content')
  writeFileSync(outsideFile, 'outside content')
  symlinkSync(outsideFile, join(skillRoot, 'outside-link.md'))

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_DOWNSTREAM_ROOT = downstreamRoot
  clearConfigCaches()

  try {
    const bundle = getEffectiveSkillBundleSync('leak-test')
    assert.deepEqual(bundle?.files.map((file) => file.path), ['safe.md'])
    assert.equal(await readEffectiveSkillBundleFile('leak-test', 'safe.md'), 'safe content')
    assert.equal(await readEffectiveSkillBundleFile('leak-test', '../outside.md'), null)
    assert.equal(await readEffectiveSkillBundleFile('leak-test', 'outside-link.md'), null)
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousDownstreamRoot === undefined) delete process.env.OPEN_COWORK_DOWNSTREAM_ROOT
    else process.env.OPEN_COWORK_DOWNSTREAM_ROOT = previousDownstreamRoot
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('bundled skill discovery skips symlinked directories outside the configured root', () => {
  const tempRoot = testTempDir('opencowork-skill-discovery-')
  const skillRoot = join(tempRoot, 'skills')
  const nestedRoot = join(skillRoot, 'nested')
  const realSkill = join(nestedRoot, 'safe-skill')
  const outsideSkill = join(tempRoot, 'outside-skill')

  mkdirSync(realSkill, { recursive: true })
  mkdirSync(outsideSkill, { recursive: true })
  writeFileSync(
    join(realSkill, 'SKILL.md'),
    '---\nname: safe-skill\ndescription: Safe skill.\n---\n# Safe Skill\n',
  )
  writeFileSync(
    join(outsideSkill, 'SKILL.md'),
    '---\nname: outside-skill\ndescription: Outside skill.\n---\n# Outside Skill\n',
  )
  symlinkSync(outsideSkill, join(skillRoot, 'outside-skill'))

  try {
    assert.equal(findBundledSkillDir(skillRoot, 'safe-skill'), realSkill)
    assert.equal(findBundledSkillDir(skillRoot, 'outside-skill'), null)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('bundled skill discovery rejects symlinked SKILL.md definitions', () => {
  const tempRoot = testTempDir('opencowork-skill-definition-')
  const skillRoot = join(tempRoot, 'skills')
  const leakySkill = join(skillRoot, 'leaky-skill')
  const outsideSkillDefinition = join(tempRoot, 'SKILL.md')

  mkdirSync(leakySkill, { recursive: true })
  writeFileSync(
    outsideSkillDefinition,
    '---\nname: leaky-skill\ndescription: Outside skill definition.\n---\n# Leaky Skill\n',
  )
  symlinkSync(outsideSkillDefinition, join(leakySkill, 'SKILL.md'))

  try {
    assert.equal(findBundledSkillDir(skillRoot, 'leaky-skill'), null)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
