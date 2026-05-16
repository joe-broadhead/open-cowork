import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isSafeRelativePath, isSafeSkillBundleName, resolveSafeSkillsRoot, saveSkillBundle } from '../mcps/skills/src/index.ts'
import { CUSTOM_SKILL_LIMITS } from '../apps/desktop/src/main/custom-content-limits.ts'

function skillContent(name: string, description = 'Valid test skill bundle.') {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n')
}

test('skills MCP path policy accepts ordinary relative bundle files', () => {
  assert.equal(isSafeRelativePath('references/example.md'), true)
  assert.equal(isSafeRelativePath('assets/icon.svg'), true)
})

test('skills MCP path policy rejects traversal and absolute paths', () => {
  for (const path of ['../secret.md', 'references/../../secret.md', '/tmp/secret.md', '\\tmp\\secret.md']) {
    assert.equal(isSafeRelativePath(path), false, path)
  }
})

test('skills MCP path policy rejects empty segments and Windows traversal', () => {
  for (const path of ['', 'references//example.md', 'references\\..\\secret.md']) {
    assert.equal(isSafeRelativePath(path), false, path)
  }
})

test('skills MCP bundle name policy accepts only lowercase path segments', () => {
  assert.equal(isSafeSkillBundleName('data-analyst'), true)
  assert.equal(isSafeSkillBundleName('skill1'), true)

  for (const name of ['', '../secret', 'Bad_Skill', '-bad', 'bad-', 'bad--name', 'a'.repeat(65)]) {
    assert.equal(isSafeSkillBundleName(name), false, name)
  }
})

test('skills MCP validates bundle files before replacing an existing bundle', () => {
  const previousRoot = process.env.OPEN_COWORK_CUSTOM_SKILLS_DIR
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-skills-mcp-'))

  try {
    process.env.OPEN_COWORK_CUSTOM_SKILLS_DIR = root
    saveSkillBundle('safe-skill', skillContent('safe-skill', 'Existing valid skill.'), [])

    assert.throws(
      () => saveSkillBundle('safe-skill', skillContent('safe-skill', 'Replacement valid skill.'), [{ path: '../escape.md', content: 'bad' }]),
      /safe relative path|Invalid skill file path/,
    )

    const savedContent = readFileSync(join(root, 'safe-skill', 'SKILL.md'), 'utf-8')
    assert.match(savedContent, /^name: safe-skill$/m)
    assert.match(savedContent, /^description: Existing valid skill\.$/m)
  } finally {
    if (previousRoot === undefined) {
      delete process.env.OPEN_COWORK_CUSTOM_SKILLS_DIR
    } else {
      process.env.OPEN_COWORK_CUSTOM_SKILLS_DIR = previousRoot
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('skills MCP applies custom skill bundle validation before writing', () => {
  const previousRoot = process.env.OPEN_COWORK_CUSTOM_SKILLS_DIR
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-skills-mcp-'))

  try {
    process.env.OPEN_COWORK_CUSTOM_SKILLS_DIR = root

    assert.throws(
      () => saveSkillBundle('safe-skill', '# Missing frontmatter\n', []),
      /SKILL\.md must include a frontmatter description|frontmatter/,
    )
    assert.throws(
      () => saveSkillBundle('safe-skill', skillContent('safe-skill'), [
        { path: 'references/large.md', content: 'x'.repeat(CUSTOM_SKILL_LIMITS.fileBytes + 1) },
      ]),
      /too large/,
    )

    saveSkillBundle('safe-skill', skillContent('wrong-name'), [])
    assert.match(readFileSync(join(root, 'safe-skill', 'SKILL.md'), 'utf-8'), /^name: safe-skill$/m)
  } finally {
    if (previousRoot === undefined) {
      delete process.env.OPEN_COWORK_CUSTOM_SKILLS_DIR
    } else {
      process.env.OPEN_COWORK_CUSTOM_SKILLS_DIR = previousRoot
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('skills MCP root policy rejects broad filesystem roots', () => {
  assert.throws(() => resolveSafeSkillsRoot(undefined), /not configured/)
  assert.throws(() => resolveSafeSkillsRoot('relative/skills'), /absolute/)
  assert.throws(() => resolveSafeSkillsRoot(resolve('/')), /filesystem root/)
  assert.throws(() => resolveSafeSkillsRoot(homedir()), /home directory/)

  const safeRoot = resolve(homedir(), '.config', 'open-cowork', 'runtime-home', '.config', 'opencode', 'skills')
  assert.equal(resolveSafeSkillsRoot(safeRoot), safeRoot)
})
