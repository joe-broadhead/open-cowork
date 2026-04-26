import test from 'node:test'
import assert from 'node:assert/strict'
import { isSafeRelativePath } from '../mcps/skills/src/index.ts'

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
