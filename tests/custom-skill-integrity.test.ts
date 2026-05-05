import test from 'node:test'
import assert from 'node:assert/strict'
import { computeCustomSkillBundleDigest } from '../apps/desktop/src/main/custom-skill-integrity.ts'

test('custom skill bundle digest is stable across supporting file order', () => {
  const baseSkill = {
    scope: 'machine' as const,
    name: 'research-helper',
    content: '---\nname: research-helper\ndescription: Research helper.\n---\n# Research Helper\n',
    files: [
      { path: 'examples/a.md', content: 'A' },
      { path: 'references/b.md', content: 'B' },
    ],
  }

  const digest = computeCustomSkillBundleDigest(baseSkill)
  assert.match(digest, /^[a-f0-9]{64}$/)
  assert.equal(computeCustomSkillBundleDigest({
    ...baseSkill,
    files: [...baseSkill.files].reverse(),
  }), digest)
  assert.notEqual(computeCustomSkillBundleDigest({
    ...baseSkill,
    files: [
      { path: 'examples/a.md', content: 'A' },
      { path: 'references/b.md', content: 'changed' },
    ],
  }), digest)
})
