import { getMachineSkillsDir } from '@open-cowork/runtime-host/runtime-paths'
import { findBundledSkillDir } from '@open-cowork/runtime-host/runtime-content'
import { getEffectiveSkillBundleSync, listEffectiveBuiltInSkillBundlesSync, readEffectiveSkillBundleFile } from '@open-cowork/runtime-host/effective-skills'
import { buildBundledSkillIndex, clearBundledSkillIndexCache, getBundledSkillIndex, warmBundledSkillIndex } from '@open-cowork/runtime-host/bundled-skill-index'
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { clearConfigCaches } from '@open-cowork/runtime-host/config'
function testTempDir(prefix: string) {
  const parent = join(process.cwd(), '.open-cowork-test')
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, prefix))
}

test('effective skill bundle file reads reject traversal and symlinks outside the bundle root', async () => {
  const tempRoot = testTempDir('open-cowork-effective-skills-')
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
  mkdirSync(join(skillRoot, '..meta'), { recursive: true })
  writeFileSync(join(skillRoot, '..notes.md'), 'dot-dot-prefixed content')
  writeFileSync(join(skillRoot, '..meta', 'details.md'), 'dot-dot-prefixed nested content')
  writeFileSync(outsideFile, 'outside content')
  symlinkSync(outsideFile, join(skillRoot, 'outside-link.md'))

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_DOWNSTREAM_ROOT = downstreamRoot
  clearConfigCaches()

  try {
    const bundle = getEffectiveSkillBundleSync('leak-test')
    assert.deepEqual(
      bundle?.files.map((file) => file.path).sort(),
      ['..meta/details.md', '..notes.md', 'safe.md'].sort(),
    )
    assert.equal(await readEffectiveSkillBundleFile('leak-test', 'safe.md'), 'safe content')
    assert.equal(await readEffectiveSkillBundleFile('leak-test', '..notes.md'), 'dot-dot-prefixed content')
    assert.equal(await readEffectiveSkillBundleFile('leak-test', '..meta/details.md'), 'dot-dot-prefixed nested content')
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
  const tempRoot = testTempDir('open-cowork-skill-discovery-')
  const skillRoot = join(tempRoot, 'skills')
  const nestedRoot = join(skillRoot, 'nested')
  const realSkill = join(nestedRoot, 'safe-skill')
  const dotPrefixedRoot = join(skillRoot, '..catalog')
  const dotPrefixedSkill = join(dotPrefixedRoot, 'dot-prefixed-skill')
  const outsideSkill = join(tempRoot, 'outside-skill')

  mkdirSync(realSkill, { recursive: true })
  mkdirSync(dotPrefixedSkill, { recursive: true })
  mkdirSync(outsideSkill, { recursive: true })
  writeFileSync(
    join(realSkill, 'SKILL.md'),
    '---\nname: safe-skill\ndescription: Safe skill.\n---\n# Safe Skill\n',
  )
  writeFileSync(
    join(dotPrefixedSkill, 'SKILL.md'),
    '---\nname: dot-prefixed-skill\ndescription: Dot-prefixed path skill.\n---\n# Dot Prefixed Skill\n',
  )
  writeFileSync(
    join(outsideSkill, 'SKILL.md'),
    '---\nname: outside-skill\ndescription: Outside skill.\n---\n# Outside Skill\n',
  )
  symlinkSync(outsideSkill, join(skillRoot, 'outside-skill'))

  try {
    assert.equal(findBundledSkillDir(skillRoot, 'safe-skill'), realSkill)
    assert.equal(findBundledSkillDir(skillRoot, 'dot-prefixed-skill'), dotPrefixedSkill)
    assert.equal(findBundledSkillDir(skillRoot, 'outside-skill'), null)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('bundled skill discovery rejects symlinked SKILL.md definitions', () => {
  const tempRoot = testTempDir('open-cowork-skill-definition-')
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

test('bundled skill index prefers root order and shallower duplicate bundles', () => {
  const tempRoot = testTempDir('open-cowork-skill-index-')
  const firstRoot = join(tempRoot, 'first', 'skills')
  const secondRoot = join(tempRoot, 'second', 'skills')
  const firstNested = join(firstRoot, 'nested', 'duplicate-skill')
  const firstDirect = join(firstRoot, 'duplicate-skill')
  const secondDirect = join(secondRoot, 'duplicate-skill')

  mkdirSync(firstNested, { recursive: true })
  mkdirSync(firstDirect, { recursive: true })
  mkdirSync(secondDirect, { recursive: true })
  writeFileSync(join(firstNested, 'SKILL.md'), '---\nname: duplicate-skill\ndescription: Nested\n---\n# Nested\n')
  writeFileSync(join(firstDirect, 'SKILL.md'), '---\nname: duplicate-skill\ndescription: Direct\n---\n# Direct\n')
  writeFileSync(join(secondDirect, 'SKILL.md'), '---\nname: duplicate-skill\ndescription: Second\n---\n# Second\n')

  try {
    clearBundledSkillIndexCache()
    const directIndex = buildBundledSkillIndex([firstRoot, secondRoot])
    assert.equal(directIndex.get('duplicate-skill')?.skillDir, firstDirect)

    const cachedIndex = getBundledSkillIndex([secondRoot, firstRoot])
    assert.equal(cachedIndex.get('duplicate-skill')?.skillDir, secondDirect)
    assert.equal(getBundledSkillIndex([secondRoot, firstRoot]), cachedIndex)
  } finally {
    clearBundledSkillIndexCache()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('bundled skill index accepts symlinked bundle roots while rejecting nested symlink escapes', () => {
  const tempRoot = testTempDir('open-cowork-skill-index-symlink-root-')
  const realRoot = join(tempRoot, 'real-skills')
  const linkedRoot = join(tempRoot, 'linked-skills')
  const skillDir = join(realRoot, 'linked-skill')
  const outsideSkill = join(tempRoot, 'outside-skill')

  mkdirSync(skillDir, { recursive: true })
  mkdirSync(outsideSkill, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: linked-skill\ndescription: Linked\n---\n# Linked\n')
  writeFileSync(join(outsideSkill, 'SKILL.md'), '---\nname: outside-skill\ndescription: Outside\n---\n# Outside\n')
  symlinkSync(realRoot, linkedRoot, 'dir')
  symlinkSync(outsideSkill, join(realRoot, 'outside-skill'), 'dir')

  try {
    clearBundledSkillIndexCache()
    const index = getBundledSkillIndex([linkedRoot])
    assert.equal(index.get('linked-skill')?.skillDir, join(linkedRoot, 'linked-skill'))
    assert.equal(index.has('outside-skill'), false)
  } finally {
    clearBundledSkillIndexCache()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('bundled skill index reflects nested tree changes without a manual cache clear', () => {
  const tempRoot = testTempDir('open-cowork-skill-index-refresh-')
  const skillRoot = join(tempRoot, 'skills')
  const firstSkill = join(skillRoot, 'first-skill')
  const nestedSkill = join(skillRoot, 'vendor', 'nested-skill')

  mkdirSync(firstSkill, { recursive: true })
  writeFileSync(join(firstSkill, 'SKILL.md'), '---\nname: first-skill\ndescription: First\n---\n# First\n')

  try {
    clearBundledSkillIndexCache()
    const initialIndex = getBundledSkillIndex([skillRoot])
    assert.equal(initialIndex.has('first-skill'), true)
    assert.equal(initialIndex.has('nested-skill'), false)

    mkdirSync(nestedSkill, { recursive: true })
    writeFileSync(join(nestedSkill, 'SKILL.md'), '---\nname: nested-skill\ndescription: Nested\n---\n# Nested\n')

    const refreshedIndex = getBundledSkillIndex([skillRoot])
    assert.equal(refreshedIndex.has('first-skill'), true)
    assert.equal(refreshedIndex.get('nested-skill')?.skillDir, nestedSkill)
    assert.notEqual(refreshedIndex, initialIndex)
  } finally {
    clearBundledSkillIndexCache()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('warmed bundled skill index stays stable until explicit invalidation', () => {
  const tempRoot = testTempDir('open-cowork-skill-index-warm-')
  const skillRoot = join(tempRoot, 'skills')
  const firstSkill = join(skillRoot, 'first-skill')
  const lateSkill = join(skillRoot, 'late-skill')

  mkdirSync(firstSkill, { recursive: true })
  writeFileSync(join(firstSkill, 'SKILL.md'), '---\nname: first-skill\ndescription: First\n---\n# First\n')

  try {
    clearBundledSkillIndexCache()
    const warmedIndex = warmBundledSkillIndex([skillRoot])
    assert.equal(warmedIndex.has('first-skill'), true)

    mkdirSync(lateSkill, { recursive: true })
    writeFileSync(join(lateSkill, 'SKILL.md'), '---\nname: late-skill\ndescription: Late\n---\n# Late\n')

    assert.equal(getBundledSkillIndex([skillRoot]), warmedIndex)
    assert.equal(getBundledSkillIndex([skillRoot]).has('late-skill'), false)

    clearBundledSkillIndexCache()
    assert.equal(getBundledSkillIndex([skillRoot]).has('late-skill'), true)
  } finally {
    clearBundledSkillIndexCache()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('effective skill bundle file reads return null when a validated file becomes unreadable', async () => {
  const tempRoot = testTempDir('open-cowork-effective-skills-unreadable-')
  const configDir = join(tempRoot, 'config')
  const downstreamRoot = join(tempRoot, 'downstream')
  const skillRoot = join(downstreamRoot, 'skills', 'unreadable-test')
  const unreadablePath = join(skillRoot, 'unreadable.md')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousDownstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT

  mkdirSync(configDir, { recursive: true })
  mkdirSync(skillRoot, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({
    skills: [
      {
        name: 'Unreadable Test',
        description: 'Test unreadable skill bundle file handling.',
        badge: 'Skill',
        sourceName: 'unreadable-test',
        toolIds: [],
      },
    ],
  }, null, 2))
  writeFileSync(
    join(skillRoot, 'SKILL.md'),
    '---\nname: unreadable-test\ndescription: Test unreadable skill bundle file handling.\n---\n# Unreadable Test\n',
  )
  writeFileSync(unreadablePath, 'unreadable content')
  chmodSync(unreadablePath, 0)

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_DOWNSTREAM_ROOT = downstreamRoot
  clearConfigCaches()

  try {
    assert.equal(await readEffectiveSkillBundleFile('unreadable-test', 'unreadable.md'), null)
  } finally {
    chmodSync(unreadablePath, 0o600)
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousDownstreamRoot === undefined) delete process.env.OPEN_COWORK_DOWNSTREAM_ROOT
    else process.env.OPEN_COWORK_DOWNSTREAM_ROOT = previousDownstreamRoot
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('built-in skill bundles are materialized in one pass while only valid custom skills shadow configured bundles', () => {
  const tempRoot = testTempDir('open-cowork-effective-builtins-')
  const configDir = join(tempRoot, 'config')
  const downstreamRoot = join(tempRoot, 'downstream')
  const downstreamSkills = join(downstreamRoot, 'skills')
  const bundledAnalyst = join(downstreamSkills, 'analyst')
  const bundledChart = join(downstreamSkills, 'chart-creator')
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR
  const previousDownstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR

  mkdirSync(configDir, { recursive: true })
  mkdirSync(bundledAnalyst, { recursive: true })
  mkdirSync(bundledChart, { recursive: true })
  writeFileSync(join(configDir, 'config.jsonc'), JSON.stringify({
    skills: [
      { name: 'Analyst', description: 'Bundled analyst.', badge: 'Skill', sourceName: 'analyst', toolIds: [] },
      { name: 'Chart Creator', description: 'Bundled charting.', badge: 'Skill', sourceName: 'chart-creator', toolIds: ['charts'] },
    ],
  }, null, 2))
  writeFileSync(join(bundledAnalyst, 'SKILL.md'), '---\nname: analyst\ndescription: Bundled analyst.\n---\n# Analyst\n')
  writeFileSync(join(bundledChart, 'SKILL.md'), '---\nname: chart-creator\ndescription: Bundled charting.\n---\n# Chart\n')
  writeFileSync(join(bundledChart, 'reference.md'), 'chart reference')

  process.env.OPEN_COWORK_CONFIG_DIR = configDir
  process.env.OPEN_COWORK_DOWNSTREAM_ROOT = downstreamRoot
  process.env.OPEN_COWORK_USER_DATA_DIR = join(tempRoot, 'user-data')
  clearBundledSkillIndexCache()
  clearConfigCaches()

  try {
    const customAnalyst = join(getMachineSkillsDir(), 'analyst')
    mkdirSync(customAnalyst, { recursive: true })
    writeFileSync(join(customAnalyst, 'SKILL.md'), '---\nname: analyst\ndescription: Custom analyst.\n---\n# Custom Analyst\n')

    const invalidCustomChart = join(getMachineSkillsDir(), 'chart-creator')
    mkdirSync(invalidCustomChart, { recursive: true })
    writeFileSync(join(invalidCustomChart, 'SKILL.md'), '---\nname: chart-creator\n---\n# Invalid Custom Chart\n')

    const bundles = listEffectiveBuiltInSkillBundlesSync()
    assert.equal(bundles.some((bundle) => bundle.name === 'analyst'), false)
    const chartBundle = bundles.find((bundle) => bundle.name === 'chart-creator')
    assert.equal(chartBundle?.content?.includes('Bundled charting'), true)
    assert.equal(chartBundle?.files.some((file) => file.path === 'reference.md' && file.content === 'chart reference'), true)
    assert.equal(getEffectiveSkillBundleSync('chart-creator')?.origin, 'open-cowork')
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    if (previousDownstreamRoot === undefined) delete process.env.OPEN_COWORK_DOWNSTREAM_ROOT
    else process.env.OPEN_COWORK_DOWNSTREAM_ROOT = previousDownstreamRoot
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearBundledSkillIndexCache()
    clearConfigCaches()
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
