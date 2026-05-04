import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { listCustomSkills, readSkillBundleDirectory, saveCustomSkill } from '../apps/desktop/src/main/custom-skills.ts'
import { CUSTOM_SKILL_LIMITS } from '../apps/desktop/src/main/custom-content-limits.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import { getMachineSkillsDir } from '../apps/desktop/src/main/runtime-paths.ts'
import { closeLogger } from '../apps/desktop/src/main/logger.ts'

function testTempDir(prefix: string) {
  const parent = join(process.cwd(), '.open-cowork-test')
  mkdirSync(parent, { recursive: true })
  return mkdtempSync(join(parent, prefix))
}

test('readSkillBundleDirectory loads SKILL.md and supporting files from a bundle directory', () => {
  const root = testTempDir('opencowork-skill-bundle-')
  const bundle = join(root, 'Chart Creator')
  mkdirSync(join(bundle, 'references'), { recursive: true })
  writeFileSync(join(bundle, 'SKILL.md'), '---\nname: Chart Creator\ndescription: "Build charts"\n---\n# Chart Creator')
  writeFileSync(join(bundle, 'references', 'example.md'), '# Example')

  try {
    const skill = readSkillBundleDirectory(bundle, {
      name: 'chart-creator',
      scope: 'machine',
      directory: null,
    })
    assert.equal(skill.name, 'chart-creator')
    assert.match(skill.content, /# Chart Creator/)
    assert.deepEqual(skill.files, [
      {
        path: 'references/example.md',
        content: '# Example',
      },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readSkillBundleDirectory canonicalizes the imported frontmatter name to the saved bundle id', () => {
  const root = testTempDir('opencowork-skill-bundle-')
  const bundle = join(root, 'Chart Creator')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(bundle, 'SKILL.md'), '---\nname: Chart Creator\ndescription: "Build charts"\n---\n# Chart Creator')

  try {
    const skill = readSkillBundleDirectory(bundle, {
      name: 'chart-creator',
      scope: 'machine',
      directory: null,
    })
    assert.match(skill.content, /^---\nname: chart-creator\n/m)
    assert.equal(skill.name, 'chart-creator')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('saveCustomSkill rejects bundles that do not meet OpenCode frontmatter requirements', () => {
  assert.throws(() => {
    saveCustomSkill({
      scope: 'machine',
      directory: null,
      name: 'Bad_Skill',
      content: '# Missing frontmatter',
      files: [],
    })
  }, /Skill bundle names must use 1-64 lowercase letters, numbers, and single hyphens only|SKILL\.md must include a frontmatter description/)
})

test('readSkillBundleDirectory rejects oversized supporting files', () => {
  const root = testTempDir('opencowork-skill-bundle-')
  const bundle = join(root, 'Chart Creator')
  mkdirSync(join(bundle, 'references'), { recursive: true })
  writeFileSync(join(bundle, 'SKILL.md'), '---\nname: Chart Creator\ndescription: "Build charts"\n---\n# Chart Creator')
  writeFileSync(join(bundle, 'references', 'large.md'), 'x'.repeat(CUSTOM_SKILL_LIMITS.fileBytes + 1))

  try {
    assert.throws(() => {
      readSkillBundleDirectory(bundle, {
        name: 'chart-creator',
        scope: 'machine',
        directory: null,
      })
    }, /too large/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listCustomSkills skips invalid existing bundles without aborting enumeration', async () => {
  const root = testTempDir('opencowork-skill-list-')
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  process.env.OPEN_COWORK_USER_DATA_DIR = join(root, 'user-data')
  clearConfigCaches()

  try {
    saveCustomSkill({
      scope: 'machine',
      directory: null,
      name: 'valid-skill',
      content: '---\nname: valid-skill\ndescription: "Valid skill"\n---\n# Valid Skill',
      files: [],
    })

    const badSkill = join(getMachineSkillsDir(), 'bad-skill')
    let nested = badSkill
    for (let index = 0; index <= CUSTOM_SKILL_LIMITS.pathDepth; index += 1) {
      nested = join(nested, `level-${index}`)
    }
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(badSkill, 'SKILL.md'), '---\nname: bad-skill\ndescription: "Bad skill"\n---\n# Bad Skill')
    writeFileSync(join(nested, 'too-deep.md'), 'too deep')

    const skills = listCustomSkills()
    assert.deepEqual(skills.map((skill) => skill.name), ['valid-skill'])
  } finally {
    closeLogger()
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
})

test('listCustomSkills skips bundles with too-deep supporting file paths', async () => {
  const root = testTempDir('opencowork-skill-file-depth-')
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  process.env.OPEN_COWORK_USER_DATA_DIR = join(root, 'user-data')
  clearConfigCaches()

  try {
    saveCustomSkill({
      scope: 'machine',
      directory: null,
      name: 'valid-skill',
      content: '---\nname: valid-skill\ndescription: "Valid skill"\n---\n# Valid Skill',
      files: [],
    })

    const badSkill = join(getMachineSkillsDir(), 'bad-file-depth')
    let nested = badSkill
    for (let index = 0; index < CUSTOM_SKILL_LIMITS.pathDepth; index += 1) {
      nested = join(nested, `level-${index}`)
    }
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(badSkill, 'SKILL.md'), '---\nname: bad-file-depth\ndescription: "Bad skill"\n---\n# Bad Skill')
    writeFileSync(join(nested, 'too-deep.md'), 'too deep')

    const skills = listCustomSkills()
    assert.deepEqual(skills.map((skill) => skill.name), ['valid-skill'])
  } finally {
    closeLogger()
    await new Promise((resolve) => setTimeout(resolve, 20))
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
})

test('saveCustomSkill rejects too many supporting files before writing the bundle', () => {
  assert.throws(() => {
    saveCustomSkill({
      scope: 'machine',
      directory: null,
      name: 'bounded-skill',
      content: '---\nname: bounded-skill\ndescription: "Bounded skill"\n---\n# Bounded Skill',
      files: Array.from({ length: CUSTOM_SKILL_LIMITS.fileCount + 1 }, (_, index) => ({
        path: `references/file-${index}.md`,
        content: 'ok',
      })),
    })
  }, /too many entries/)
})
