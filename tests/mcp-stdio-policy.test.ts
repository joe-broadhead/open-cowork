import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { validateCustomMcpStdioCommand } from '../apps/desktop/src/main/mcp-stdio-policy.ts'

test('allows common bare runtime commands for local MCPs', () => {
  assert.doesNotThrow(() => validateCustomMcpStdioCommand({
    name: 'filesystem',
    scope: 'machine',
    directory: null,
    command: 'npx',
  }))
})

test('rejects unknown bare commands for local MCPs', () => {
  assert.throws(() => validateCustomMcpStdioCommand({
    name: 'unsafe',
    scope: 'machine',
    directory: null,
    command: 'sh',
  }), /not an allowed bare command/)
})

test('allows project-relative executables that stay inside the project', () => {
  const root = mkdtempSync(join(tmpdir(), 'opencowork-mcp-'))
  const scriptPath = join(root, 'bin', 'server.js')

  try {
    mkdirSync(join(root, 'bin'), { recursive: true })
    writeFileSync(scriptPath, 'process.stdout.write("ok")', { flag: 'w' })
    assert.doesNotThrow(() => validateCustomMcpStdioCommand({
      name: 'local-project',
      scope: 'project',
      directory: root,
      command: './bin/server.js',
    }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects project-relative executables that escape the project root', () => {
  const root = mkdtempSync(join(tmpdir(), 'opencowork-mcp-'))
  const outside = mkdtempSync(join(tmpdir(), 'opencowork-mcp-outside-'))
  const scriptPath = join(outside, 'server.js')

  try {
    writeFileSync(scriptPath, 'process.stdout.write("ok")', { flag: 'w' })
    assert.throws(() => validateCustomMcpStdioCommand({
      name: 'escaped-project',
      scope: 'project',
      directory: root,
      command: '../server.js',
    }), /must stay inside the selected project/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
