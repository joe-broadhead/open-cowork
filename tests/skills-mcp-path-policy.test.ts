import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isSafeRelativePath, isSafeSkillBundleName, resolveSafeSkillsRoot, saveSkillBundle } from '../mcps/skills/src/index.ts'

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
    saveSkillBundle('safe-skill', '# Existing\n', [])

    assert.throws(
      () => saveSkillBundle('safe-skill', '# Replacement\n', [{ path: '../escape.md', content: 'bad' }]),
      /Invalid skill file path/,
    )

    assert.equal(readFileSync(join(root, 'safe-skill', 'SKILL.md'), 'utf-8'), '# Existing\n')
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
