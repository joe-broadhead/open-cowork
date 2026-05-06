import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setTimeout as delay } from 'timers/promises'

import {
  createManagedOpencodeServer,
  getActiveProjectOverlayDirectory,
  getClient,
  getModelInfo,
  getModelInfoAsync,
  getServerUrl,
  stopRuntime,
} from '../apps/desktop/src/main/runtime.ts'

function writeExecutable(root: string, name: string, source: string) {
  const path = join(root, name)
  writeFileSync(path, `#!/bin/sh\n${source}`)
  chmodSync(path, 0o755)
  return path
}

async function waitForProcessExit(pid: number) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await delay(25)
  }
  assert.fail(`managed server process ${pid} did not exit`)
}

test('managed opencode server resolves from stdout and closes the child process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-server-'))
  const pidFile = join(root, 'pid')
  const executable = writeExecutable(root, 'fake-opencode', `
printf '%s' "$$" > ${JSON.stringify(pidFile)}
printf '%s\\n' 'opencode server listening on http://127.0.0.1:43210'
while true; do sleep 1; done
`)

  const server = await createManagedOpencodeServer({
    env: { PATH: process.env.PATH || '' },
    hostname: '127.0.0.1',
    opencodeBinPath: executable,
    port: 0,
    timeout: 1000,
  })

  const pid = (() => {
    try {
      assert.equal(server.url, 'http://127.0.0.1:43210')
      assert.equal(existsSync(pidFile), true)
      const childPid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
      assert.ok(childPid > 0)
      return childPid
    } finally {
      server.close()
    }
  })()

  await waitForProcessExit(pid)
})

test('managed opencode server timeout fails closed and stops the child process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-timeout-'))
  const pidFile = join(root, 'pid')
  const executable = writeExecutable(root, 'silent-opencode', `
printf '%s' "$$" > ${JSON.stringify(pidFile)}
while true; do sleep 1; done
`)

  await assert.rejects(
    createManagedOpencodeServer({
      env: { PATH: process.env.PATH || '' },
      hostname: '127.0.0.1',
      opencodeBinPath: executable,
      port: 0,
      timeout: 200,
    }),
    /Timeout waiting for server to start after 200ms/,
  )

  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
    await waitForProcessExit(pid)
  }
})

test('runtime accessors remain inert before startup and after stop', async () => {
  await stopRuntime()

  assert.equal(getClient(), null)
  assert.equal(getServerUrl(), null)
  assert.equal(getActiveProjectOverlayDirectory(), null)
  assert.deepEqual(await getModelInfoAsync(), getModelInfo())
})
