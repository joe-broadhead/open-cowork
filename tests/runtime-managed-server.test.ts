import test from 'node:test'
import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { setTimeout as delay } from 'timers/promises'

import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  buildManagedOpencodeAuthorizationHeader,
  createManagedOpencodeServer,
  type ManagedOpencodeSupervisorFork,
} from '../apps/desktop/src/main/runtime-managed-server.ts'
import { createNodeManagedOpencodeServer } from '../apps/desktop/src/main/runtime-node-managed-server.ts'
import {
  buildManagedOpencodeClientConfig,
  getNativeOpencodeAuthPath,
  getRuntimeOpencodeAuthPath,
  getActiveProjectOverlayDirectory,
  getClient,
  getModelInfo,
  getModelInfoAsync,
  getServerUrl,
  reconcileProviderAuthBridge,
  shouldEnableNativeWebSearch,
  stopRuntime,
} from '../apps/desktop/src/main/runtime.ts'

function writeExecutable(root: string, name: string, source: string) {
  const path = join(root, name)
  writeFileSync(path, `#!/bin/sh\n${source}`)
  chmodSync(path, 0o755)
  return path
}

const testSupervisorPath = fileURLToPath(new URL('../apps/desktop/src/main/runtime-managed-server-supervisor.ts', import.meta.url))

const forkTestSupervisor: ManagedOpencodeSupervisorFork = () => {
  const execArgv = Array.from(new Set([...process.execArgv, '--no-warnings', '--experimental-strip-types']))
  const child = fork(testSupervisorPath, [], {
    execArgv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  return {
    get pid() {
      return child.pid
    },
    stdout: child.stdout,
    stderr: child.stderr,
    postMessage(message) {
      child.send(message)
    },
    kill() {
      return child.kill()
    },
    on(event, listener) {
      child.on(event, listener as Parameters<ChildProcess['on']>[1])
      return child
    },
    off(event, listener) {
      child.off(event, listener as Parameters<ChildProcess['off']>[1])
      return child
    },
  }
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
  const cwdFile = join(root, 'cwd')
  const runtimeCwd = join(root, 'runtime-cwd')
  mkdirSync(runtimeCwd, { recursive: true })
  const executable = writeExecutable(root, 'fake-opencode', `
printf '%s' "$$" > ${JSON.stringify(pidFile)}
printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}
pwd > ${JSON.stringify(cwdFile)}
printf '%s\\n%s\\n%s\\n' "$OPENCODE_SERVER_USERNAME" "$OPENCODE_SERVER_PASSWORD" "$OPENCODE_DISABLE_EMBEDDED_WEB_UI" > ${JSON.stringify(envFile)}
printf '%s\\n' 'opencode server listening on http://127.0.0.1:43210'
while true; do sleep 1; done
`)

  const mainProcessCwd = process.cwd()
  const server = await createManagedOpencodeServer({
    env: {
      PATH: process.env.PATH || '',
      OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCODE_SERVER_PASSWORD: 'runtime-password',
      OPENCODE_DISABLE_EMBEDDED_WEB_UI: 'true',
    },
    hostname: '127.0.0.1',
    config: { logLevel: 'warn' },
    forkUtilityProcess: forkTestSupervisor,
    opencodeBinPath: executable,
    cwd: runtimeCwd,
    port: 0,
    timeout: 5000,
  })

  const pid = (() => {
    try {
      assert.equal(server.url, 'http://127.0.0.1:43210')
      assert.equal(existsSync(pidFile), true)
      assert.match(readFileSync(argsFile, 'utf8'), /--log-level=WARN/)
      assert.equal(readFileSync(cwdFile, 'utf8').trim(), realpathSync(runtimeCwd))
      assert.equal(readFileSync(envFile, 'utf8'), 'opencode\nruntime-password\ntrue\n')
      assert.equal(process.cwd(), mainProcessCwd)
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
      forkUtilityProcess: forkTestSupervisor,
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

test('node managed opencode server handles child startup exit without IPC crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-node-exit-'))
  const executable = writeExecutable(root, 'exit-opencode', 'exit 42\n')

  try {
    await assert.rejects(
      createNodeManagedOpencodeServer({
        env: { PATH: process.env.PATH || '' },
        hostname: '127.0.0.1',
        opencodeBinPath: executable,
        port: 0,
        timeout: 5000,
      }),
      /Server exited with code 42/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('managed opencode server aborts startup with an Error value', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-abort-'))
  const pidFile = join(root, 'pid')
  const executable = writeExecutable(root, 'abort-opencode', `
printf '%s' "$$" > ${JSON.stringify(pidFile)}
while true; do sleep 1; done
`)
  const controller = new AbortController()

  try {
    const started = createManagedOpencodeServer({
      env: { PATH: process.env.PATH || '' },
      forkUtilityProcess: forkTestSupervisor,
      hostname: '127.0.0.1',
      opencodeBinPath: executable,
      port: 0,
      signal: controller.signal,
      timeout: 5000,
    })
    controller.abort()

    await assert.rejects(started, (error) => error instanceof Error)

    if (existsSync(pidFile)) {
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
      await waitForProcessExit(pid)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('managed opencode server reports one unexpected exit after readiness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-exit-'))
  const pidFile = join(root, 'pid')
  const executable = writeExecutable(root, 'exit-opencode', `
printf '%s' "$$" > ${JSON.stringify(pidFile)}
printf '%s\\n' 'opencode server listening on http://127.0.0.1:43211'
sleep 1
exit 7
`)
  const unexpectedExits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = []

  const server = await createManagedOpencodeServer({
    env: { PATH: process.env.PATH || '' },
    forkUtilityProcess: forkTestSupervisor,
    hostname: '127.0.0.1',
    opencodeBinPath: executable,
    onUnexpectedExit: (event) => {
      unexpectedExits.push(event)
    },
    port: 0,
    timeout: 5000,
  })

  try {
    assert.equal(server.url, 'http://127.0.0.1:43211')
    for (let attempt = 0; unexpectedExits.length === 0 && attempt < 80; attempt += 1) {
      await delay(50)
    }
    assert.deepEqual(unexpectedExits, [{ code: 7, signal: null }])
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
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

test('provider auth bridge is opt-in and leaves isolated runtime auth app-owned by default', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-runtime-auth-'))
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const previousXdgDataHome = process.env.XDG_DATA_HOME

  process.env.OPEN_COWORK_USER_DATA_DIR = join(root, 'app-data')
  process.env.XDG_DATA_HOME = join(root, 'native-data')
  clearConfigCaches()

  try {
    const runtimeAuth = getRuntimeOpencodeAuthPath()
    const nativeAuth = getNativeOpencodeAuthPath()
    mkdirSync(dirname(nativeAuth), { recursive: true })
    writeFileSync(nativeAuth, '{"provider":{}}\n')

    reconcileProviderAuthBridge(true)
    assert.equal(resolve(dirname(runtimeAuth), readlinkSync(runtimeAuth)), resolve(nativeAuth))

    reconcileProviderAuthBridge(false)
    assert.throws(() => readlinkSync(runtimeAuth), { code: 'ENOENT' })
    assert.equal(readFileSync(nativeAuth, 'utf8'), '{"provider":{}}\n')

    mkdirSync(dirname(runtimeAuth), { recursive: true })
    writeFileSync(runtimeAuth, '{"isolated":true}\n')
    reconcileProviderAuthBridge(false)
    assert.equal(readFileSync(runtimeAuth, 'utf8'), '{"isolated":true}\n')
  } finally {
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = previousXdgDataHome
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
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
