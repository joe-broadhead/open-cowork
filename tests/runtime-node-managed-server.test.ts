import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import {
  createNodeManagedOpencodeServer,
  resolveNodeManagedOpencodeSupervisorPath,
} from '../apps/desktop/src/main/runtime-node-managed-server.ts'

const NODE_MANAGED_RUNTIME_TEST_TIMEOUT_MS = 15_000

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

test('node managed opencode server starts and stops without Electron utilityProcess', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-node-runtime-server-'))
  const pidFile = join(root, 'pid')
  const envFile = join(root, 'env')
  const argsFile = join(root, 'args')
  const executable = writeExecutable(root, 'fake-opencode', `
printf '%s' "$$" > ${JSON.stringify(pidFile)}
printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}
printf '%s\\n%s\\n' "$OPENCODE_SERVER_USERNAME" "$OPENCODE_CONFIG_CONTENT" > ${JSON.stringify(envFile)}
printf '%s\\n' 'opencode server listening on http://127.0.0.1:43220'
while true; do sleep 1; done
`)

  const server = await createNodeManagedOpencodeServer({
    env: {
      PATH: process.env.PATH || '',
      OPENCODE_SERVER_USERNAME: 'opencode',
    },
    hostname: '127.0.0.1',
    config: { logLevel: 'warn', model: 'test/model' },
    opencodeBinPath: executable,
    port: 0,
    timeout: NODE_MANAGED_RUNTIME_TEST_TIMEOUT_MS,
  })

  const pid = (() => {
    try {
      assert.equal(server.url, 'http://127.0.0.1:43220')
      assert.match(readFileSync(argsFile, 'utf8'), /--hostname=127\.0\.0\.1/)
      assert.match(readFileSync(argsFile, 'utf8'), /--port=0/)
      assert.match(readFileSync(argsFile, 'utf8'), /--log-level=WARN/)
      const env = readFileSync(envFile, 'utf8')
      assert.match(env, /^opencode\n/)
      assert.match(env, /"model":"test\/model"/)
      return Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
    } finally {
      server.close()
    }
  })()

  await waitForProcessExit(pid)
  rmSync(root, { recursive: true, force: true })
})

test('node managed opencode server reports unexpected child exit after readiness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-node-runtime-exit-'))
  const executable = writeExecutable(root, 'exit-opencode', `
printf '%s\\n' 'opencode server listening on http://127.0.0.1:43221'
sleep 1
exit 9
`)
  const unexpectedExits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = []

  const server = await createNodeManagedOpencodeServer({
    env: { PATH: process.env.PATH || '' },
    hostname: '127.0.0.1',
    opencodeBinPath: executable,
    onUnexpectedExit: (event) => unexpectedExits.push(event),
    port: 0,
    timeout: NODE_MANAGED_RUNTIME_TEST_TIMEOUT_MS,
  })

  try {
    assert.equal(server.url, 'http://127.0.0.1:43221')
    for (let attempt = 0; unexpectedExits.length === 0 && attempt < 80; attempt += 1) {
      await delay(50)
    }
    assert.deepEqual(unexpectedExits, [{ code: 9, signal: null }])
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('node managed supervisor path resolves to a runnable source or build artifact', () => {
  assert.equal(existsSync(resolveNodeManagedOpencodeSupervisorPath()), true)
})
