import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type AddressInfo } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import {
  cleanupSmokePaths,
  createSmokePaths,
  launchPackagedMacProbe,
} from '../apps/desktop/tests/smoke-helpers.ts'

const launchServicesAuthorizationKey = 'OPEN_COWORK_E2E_ARG_ENV'

function launchctlEnvironment(key: string) {
  const value = execFileSync('launchctl', ['getenv', key], { encoding: 'utf8' }).replace(/[\r\n]+$/, '')
  return value || null
}

function processIsAlive(processId: number) {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function findFixtureProcess(executablePath: string, port: number) {
  const processTable = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  const portArgument = `--remote-debugging-port=${port}`
  for (const line of processTable.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/)
    if (!match || !match[2].includes(executablePath) || !match[2].includes(portArgument)) continue
    return Number.parseInt(match[1], 10)
  }
  return null
}

async function delay(ms: number) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  return port
}

async function waitForFile(path: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await delay(25)
  }
  throw new Error(`Fixture did not create ${path}`)
}

async function stopFixtureProcess(processId: number) {
  if (!processIsAlive(processId)) return
  process.kill(processId, 'SIGTERM')
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!processIsAlive(processId)) return
    await delay(50)
  }
  process.kill(processId, 'SIGKILL')
}

function writeFixtureInfoPlist(path: string, bundleId: string) {
  writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Fixture</string>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.2.3</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
`)
}

test('macOS packaged probe restores LaunchServices authorization when interrupted', {
  skip: process.platform === 'darwin' ? false : 'macOS-only packaged launch contract',
}, async () => {
  const originalAuthorization = launchctlEnvironment(launchServicesAuthorizationKey)
  const authorizationSentinel = `interrupt-restore-${process.pid}`
  const helperUrl = new URL('../apps/desktop/tests/smoke-helpers.ts', import.meta.url).href
  const childSource = `
    import { withLaunchServicesEnvironment } from ${JSON.stringify(helperUrl)}
    await withLaunchServicesEnvironment(
      { ${JSON.stringify(launchServicesAuthorizationKey)}: '1' },
      async () => {
        process.stdout.write('ready\\n')
        await new Promise(() => setInterval(() => {}, 1_000))
      },
    )
  `
  execFileSync('launchctl', ['setenv', launchServicesAuthorizationKey, authorizationSentinel])
  const child = spawn(process.execPath, [
    '--no-warnings',
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    childSource,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      const timeout = setTimeout(() => rejectReady(new Error(`Interrupted helper did not become ready: ${stderr}`)), 5_000)
      child.stdout!.setEncoding('utf8')
      child.stdout!.once('data', (chunk) => {
        clearTimeout(timeout)
        if (!String(chunk).includes('ready')) {
          rejectReady(new Error(`Interrupted helper emitted unexpected output: ${String(chunk)}`))
          return
        }
        resolveReady()
      })
      child.once('error', (error) => {
        clearTimeout(timeout)
        rejectReady(error)
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timeout)
        rejectReady(new Error(`Interrupted helper exited before ready with ${signal || code}: ${stderr}`))
      })
    })
    assert.equal(launchctlEnvironment(launchServicesAuthorizationKey), '1')
    child.kill('SIGTERM')
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
    assert.equal(exit.signal, 'SIGTERM')
    assert.equal(launchctlEnvironment(launchServicesAuthorizationKey), authorizationSentinel)
  } finally {
    if (processIsAlive(child.pid!)) await stopFixtureProcess(child.pid!)
    if (originalAuthorization === null) {
      execFileSync('launchctl', ['unsetenv', launchServicesAuthorizationKey])
    } else {
      execFileSync('launchctl', ['setenv', launchServicesAuthorizationKey, originalAuthorization])
    }
  }
})

test('macOS packaged probe reports bounded diagnostics when the candidate exits early', {
  skip: process.platform === 'darwin' ? false : 'macOS-only packaged launch contract',
}, async () => {
  const paths = createSmokePaths()
  const executable = join(paths.tempRoot, 'Fixture.app', 'Contents', 'MacOS', 'Fixture')
  const infoPlist = join(paths.tempRoot, 'Fixture.app', 'Contents', 'Info.plist')
  const fixtureSource = join(paths.tempRoot, 'fixture.c')
  const candidatePidFile = join(paths.tempRoot, 'fixture.pid')
  const originalAuthorization = launchctlEnvironment(launchServicesAuthorizationKey)
  const authorizationSentinel = `restore-${process.pid}`
  mkdirSync(join(executable, '..'), { recursive: true })
  writeFixtureInfoPlist(infoPlist, `com.open-cowork.packaged-smoke-fixture.${process.pid}`)
  writeFileSync(fixtureSource, `#include <stdio.h>
#include <unistd.h>
int main(void) {
  FILE *file = fopen(${JSON.stringify(candidatePidFile)}, "w");
  if (file != NULL) {
    fprintf(file, "%d", getpid());
    fclose(file);
  }
  sleep(1);
  return 7;
}
`)
  execFileSync('/usr/bin/clang', [fixtureSource, '-o', executable])
  execFileSync('launchctl', ['setenv', launchServicesAuthorizationKey, authorizationSentinel])
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], { stdio: 'ignore' })
  const unrelatedExit = new Promise<void>((resolveExit) => unrelated.once('exit', () => resolveExit()))

  try {
    const startedAt = Date.now()
    await assert.rejects(
      launchPackagedMacProbe(paths, executable, { timeoutMs: 5_000 }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Packaged mac probe failed/)
        assert.match(error.message, /candidate exited before writing the ready file/)
        assert.match(error.message, /Diagnostics:/)
        assert.match(error.message, /"action":"surface"/)
        assert.match(error.message, /"candidateObserved":true/)
        assert.match(error.message, /"bundle":"[^"]+\/Fixture\.app"/)
        assert.match(error.message, /"candidateArchitecture":"(?:arm64|x86_64)"/)
        assert.match(error.message, /"candidateVersion":"1\.2\.3"/)
        assert.match(error.message, /"label":"mac"/)
        assert.match(error.message, /"readyFileCreated":false/)
        assert.doesNotMatch(error.message, /OPEN_COWORK|provider|token|secret/i)
        return true
      },
    )
    assert.ok(Date.now() - startedAt < 4_000, 'early exit should fail before the probe timeout')
    const candidatePid = Number.parseInt(readFileSync(candidatePidFile, 'utf8'), 10)
    assert.equal(processIsAlive(candidatePid), false)
    assert.equal(processIsAlive(unrelated.pid!), true, 'cleanup must not terminate an unrelated process')
    assert.equal(launchctlEnvironment(launchServicesAuthorizationKey), authorizationSentinel)
  } finally {
    if (processIsAlive(unrelated.pid!)) unrelated.kill('SIGTERM')
    await Promise.race([
      unrelatedExit,
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
    ])
    if (originalAuthorization === null) {
      execFileSync('launchctl', ['unsetenv', launchServicesAuthorizationKey])
    } else {
      execFileSync('launchctl', ['setenv', launchServicesAuthorizationKey, originalAuthorization])
    }
    cleanupSmokePaths(paths)
  }
})

test('macOS packaged probe kills only the timed-out candidate instance', {
  skip: process.platform === 'darwin' ? false : 'macOS-only packaged launch contract',
}, async () => {
  const paths = createSmokePaths()
  const bundleId = `com.open-cowork.packaged-smoke-cleanup.${process.pid}`
  const candidateBundle = join(paths.tempRoot, 'Candidate.app')
  const controlBundle = join(paths.tempRoot, 'Control.app')
  const candidateExecutable = join(candidateBundle, 'Contents', 'MacOS', 'Fixture')
  const controlExecutable = join(controlBundle, 'Contents', 'MacOS', 'Fixture')
  const candidatePidFile = join(paths.tempRoot, 'candidate.pid')
  const candidateArgsFile = join(paths.tempRoot, 'candidate.args')
  const stalePidFile = join(paths.tempRoot, 'stale.pid')
  const controlPidFile = join(paths.tempRoot, 'control.pid')
  const fixtureSource = join(paths.tempRoot, 'long-lived-fixture.c')
  let staleProcessId: number | null = null
  let controlProcessId: number | null = null
  let controlPort: number | null = null

  mkdirSync(join(candidateExecutable, '..'), { recursive: true })
  mkdirSync(join(controlExecutable, '..'), { recursive: true })
  writeFixtureInfoPlist(join(candidateBundle, 'Contents', 'Info.plist'), bundleId)
  writeFixtureInfoPlist(join(controlBundle, 'Contents', 'Info.plist'), bundleId)
  writeFileSync(fixtureSource, `#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  const char *pid_file = ${JSON.stringify(candidatePidFile)};
  const char *prefix = "--fixture-pid-file=";
  for (int index = 1; index < argc; index += 1) {
    if (strncmp(argv[index], prefix, strlen(prefix)) == 0) pid_file = argv[index] + strlen(prefix);
  }
  FILE *args = fopen(${JSON.stringify(candidateArgsFile)}, "w");
  if (args != NULL) {
    for (int index = 1; index < argc; index += 1) fprintf(args, "%s\\n", argv[index]);
    fclose(args);
  }
  FILE *file = fopen(pid_file, "w");
  if (file != NULL) {
    fprintf(file, "%d", getpid());
    fclose(file);
  }
  sleep(30);
  return 0;
}
`)
  execFileSync('/usr/bin/clang', [fixtureSource, '-o', candidateExecutable])
  linkSync(candidateExecutable, controlExecutable)

  try {
    const stalePort = await availablePort()
    execFileSync('open', [
      '-n',
      '-g',
      '-j',
      candidateBundle,
      '--args',
      `--fixture-pid-file=${stalePidFile}`,
      `--remote-debugging-port=${stalePort}`,
    ])
    await waitForFile(stalePidFile)
    staleProcessId = Number.parseInt(readFileSync(stalePidFile, 'utf8'), 10)
    assert.equal(processIsAlive(staleProcessId), true)

    controlPort = await availablePort()
    execFileSync('open', [
      '-n',
      '-g',
      '-j',
      controlBundle,
      '--args',
      `--fixture-pid-file=${controlPidFile}`,
      `--remote-debugging-port=${controlPort}`,
    ])
    await waitForFile(controlPidFile)
    controlProcessId = Number.parseInt(readFileSync(controlPidFile, 'utf8'), 10)
    assert.equal(processIsAlive(controlProcessId), true)

    await assert.rejects(
      launchPackagedMacProbe(paths, candidateExecutable, { timeoutMs: 750 }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Timed out waiting for packaged probe file/)
        assert.match(error.message, /"candidateAlive":true/)
        assert.match(error.message, /"candidateObserved":true/)
        return true
      },
    )

    await waitForFile(candidatePidFile)
    const candidateProcessId = Number.parseInt(readFileSync(candidatePidFile, 'utf8'), 10)
    assert.equal(processIsAlive(staleProcessId), false, 'preflight must quiesce the exact stale candidate')
    assert.equal(processIsAlive(candidateProcessId), false, 'timed-out candidate must be terminated')
    assert.equal(processIsAlive(controlProcessId), true, 'same-bundle control instance must survive')
    assert.match(
      readFileSync(candidateArgsFile, 'utf8'),
      /^--use-mock-keychain$/m,
      'packaged macOS smoke must avoid an interactive Keychain authorization prompt',
    )
  } finally {
    if (controlProcessId === null && controlPort !== null) {
      controlProcessId = findFixtureProcess(controlExecutable, controlPort)
    }
    if (staleProcessId !== null && processIsAlive(staleProcessId)) await stopFixtureProcess(staleProcessId)
    if (controlProcessId !== null) await stopFixtureProcess(controlProcessId)
    cleanupSmokePaths(paths)
  }
})
