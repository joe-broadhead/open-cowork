import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const skillsRoot = 'skills'
const safeSkillName = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

function parseFrontmatter(content: string) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(content)
  assert.ok(match, 'skill must start with YAML frontmatter')
  return Object.fromEntries(
    match[1].split('\n').map((line) => {
      const separator = line.indexOf(':')
      assert.ok(separator > 0, `invalid frontmatter line: ${line}`)
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
    }),
  )
}

test('bundled skills have valid OpenCode skill metadata and references', () => {
  const skillNames = readdirSync(skillsRoot)
    .filter((entry) => statSync(join(skillsRoot, entry)).isDirectory())
    .sort()

  assert.deepEqual(skillNames, ['autoresearch', 'chart-creator', 'skill-creator'])

  for (const skillName of skillNames) {
    assert.match(skillName, safeSkillName)
    const skillPath = join(skillsRoot, skillName, 'SKILL.md')
    const content = readFileSync(skillPath, 'utf8')
    const frontmatter = parseFrontmatter(content)

    assert.equal(frontmatter.name, skillName)
    assert.equal(typeof frontmatter.description, 'string')
    assert.ok(frontmatter.description.length >= 30)
    assert.match(content, new RegExp(`# ${skillName.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join(' ')}`))

    const referencedMarkdownFiles = Array.from(content.matchAll(/references\/[a-z0-9-]+\.md/g)).map((match) => match[0])
    for (const relativePath of referencedMarkdownFiles) {
      assert.equal(statSync(join(skillsRoot, skillName, relativePath)).isFile(), true)
    }
  }
})
