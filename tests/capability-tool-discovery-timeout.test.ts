import type { ResolvedRuntimeMcpEntry } from '@open-cowork/runtime-host/runtime-mcp'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import {
  CAPABILITY_TOOL_DISCOVERY_TIMEOUT_MS,
  listToolsFromMcpEntry,
} from '../apps/desktop/src/main/capability-tool-discovery.ts'
async function waitForPid(path: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (existsSync(path)) return Number(readFileSync(path, 'utf8'))
    await delay(25)
  }
  throw new Error('Timed out waiting for MCP child pid.')
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessExit(pid: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!processIsAlive(pid)) return
    await delay(25)
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  assert.fail(`MCP child process ${pid} was still running after discovery timeout cleanup.`)
}

test('capability MCP discovery documents a default timeout', () => {
  assert.equal(CAPABILITY_TOOL_DISCOVERY_TIMEOUT_MS, 5_000)
})

test('capability MCP discovery times out hanging stdio probes and closes the transport', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-capability-discovery-'))
  const pidPath = join(tempRoot, 'mcp.pid')
  const script = [
    'const fs = require("node:fs")',
    `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid))`,
    'process.on("SIGTERM", () => process.exit(0))',
    'process.on("SIGINT", () => process.exit(0))',
    'setInterval(() => {}, 1000)',
  ].join(';')
  const entry: ResolvedRuntimeMcpEntry = {
    type: 'local',
    command: [process.execPath, '-e', script],
  }

  try {
    const result = listToolsFromMcpEntry(entry, { timeoutMs: 100 }).then(
      () => null,
      (error: unknown) => error,
    )
    const pid = await waitForPid(pidPath)
    const error = await result

    assert.ok(error instanceof Error)
    assert.equal(error.name, 'TimeoutError')
    assert.match(error.message, /timed out after 100ms/)
    await waitForProcessExit(pid)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
