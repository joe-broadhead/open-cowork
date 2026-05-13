import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setTimeout as delay } from 'timers/promises'

import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  buildManagedOpencodeAuthorizationHeader,
  createManagedOpencodeServer,
} from '../apps/desktop/src/main/runtime-managed-server.ts'
import {
  buildManagedOpencodeClientConfig,
  getActiveProjectOverlayDirectory,
  getClient,
  getModelInfo,
  getModelInfoAsync,
  getServerUrl,
  shouldEnableNativeWebSearch,
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
  const envFile = join(root, 'env')
  const argsFile = join(root, 'args')
  const executable = writeExecutable(root, 'fake-opencode', `
printf '%s' "$$" > ${JSON.stringify(pidFile)}
printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}
printf '%s\\n%s\\n%s\\n' "$OPENCODE_SERVER_USERNAME" "$OPENCODE_SERVER_PASSWORD" "$OPENCODE_DISABLE_EMBEDDED_WEB_UI" > ${JSON.stringify(envFile)}
printf '%s\\n' 'opencode server listening on http://127.0.0.1:43210'
while true; do sleep 1; done
`)

  const server = await createManagedOpencodeServer({
    env: {
      PATH: process.env.PATH || '',
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_SERVER_PASSWORD: 'runtime-password',
      OPENCODE_DISABLE_EMBEDDED_WEB_UI: 'true',
    },
    hostname: '127.0.0.1',
    config: { logLevel: 'warn' },
    opencodeBinPath: executable,
    port: 0,
    timeout: 5000,
  })

  const pid = (() => {
    try {
      assert.equal(server.url, 'http://127.0.0.1:43210')
      assert.equal(existsSync(pidFile), true)
      assert.match(readFileSync(argsFile, 'utf8'), /--log-level=WARN/)
      assert.equal(readFileSync(envFile, 'utf8'), 'opencode\nruntime-password\ntrue\n')
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

test('managed OpenCode client config includes Basic auth for root and directory-scoped clients', () => {
  const auth = {
    username: 'opencode',
    password: 'runtime-password',
    authorizationHeader: buildManagedOpencodeAuthorizationHeader({
      username: 'opencode',
      password: 'runtime-password',
    }),
  }

  const rootConfig = buildManagedOpencodeClientConfig('http://127.0.0.1:43210', auth)
  const scopedConfig = buildManagedOpencodeClientConfig('http://127.0.0.1:43210', auth, '/project')

  assert.deepEqual(rootConfig, {
    baseUrl: 'http://127.0.0.1:43210',
    headers: {
      Authorization: 'Basic b3BlbmNvZGU6cnVudGltZS1wYXNzd29yZA==',
    },
  })
  assert.deepEqual(scopedConfig, {
    baseUrl: 'http://127.0.0.1:43210',
    headers: {
      Authorization: 'Basic b3BlbmNvZGU6cnVudGltZS1wYXNzd29yZA==',
    },
    directory: '/project',
  })
})

test('runtime native web search env is enabled only when app permissions allow it', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-websearch-'))
  const previousConfigDir = process.env.OPEN_COWORK_CONFIG_DIR

  function writePermissions(permissions: { web: 'allow' | 'ask' | 'deny'; webSearch: boolean }) {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ permissions }, null, 2))
    clearConfigCaches()
  }

  process.env.OPEN_COWORK_CONFIG_DIR = root
  try {
    writePermissions({ web: 'allow', webSearch: true })
    assert.equal(shouldEnableNativeWebSearch(), true)

    writePermissions({ web: 'ask', webSearch: true })
    assert.equal(shouldEnableNativeWebSearch(), true)

    writePermissions({ web: 'deny', webSearch: true })
    assert.equal(shouldEnableNativeWebSearch(), false)

    writePermissions({ web: 'allow', webSearch: false })
    assert.equal(shouldEnableNativeWebSearch(), false)
  } finally {
    if (previousConfigDir === undefined) delete process.env.OPEN_COWORK_CONFIG_DIR
    else process.env.OPEN_COWORK_CONFIG_DIR = previousConfigDir
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
})
