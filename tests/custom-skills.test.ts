import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readSkillBundleDirectory, saveCustomSkill } from '../apps/desktop/src/main/custom-skills.ts'

test('readSkillBundleDirectory loads SKILL.md and supporting files from a bundle directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'opencowork-skill-bundle-'))
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
  const root = mkdtempSync(join(tmpdir(), 'opencowork-skill-bundle-'))
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
