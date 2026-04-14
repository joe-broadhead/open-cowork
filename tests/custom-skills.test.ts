import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readSkillBundleDirectory } from '../apps/desktop/src/main/custom-skills.ts'

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
