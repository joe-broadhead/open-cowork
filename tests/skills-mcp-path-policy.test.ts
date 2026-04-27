import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { isSafeRelativePath, resolveSafeSkillsRoot } from '../mcps/skills/src/index.ts'

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

test('skills MCP root policy rejects broad filesystem roots', () => {
  assert.throws(() => resolveSafeSkillsRoot(undefined), /not configured/)
  assert.throws(() => resolveSafeSkillsRoot('relative/skills'), /absolute/)
  assert.throws(() => resolveSafeSkillsRoot(resolve('/')), /filesystem root/)
  assert.throws(() => resolveSafeSkillsRoot(homedir()), /home directory/)

  const safeRoot = resolve(homedir(), '.config', 'open-cowork', 'runtime-home', '.config', 'opencode', 'skills')
  assert.equal(resolveSafeSkillsRoot(safeRoot), safeRoot)
})
