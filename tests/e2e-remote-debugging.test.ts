import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendE2ERemoteDebuggingSwitches,
  applyE2EArgEnvironment,
  buildE2EArgEnvironment,
  E2E_ARG_ENV_ENABLE_KEY,
  e2eReadyFileRelativePathIsContained,
  e2eWindowReadyProbeEnabled,
  resolveE2ERemoteDebuggingPort,
} from '../apps/desktop/src/main/e2e-remote-debugging.ts'

test('e2e remote debugging port is ignored unless smoke mode is enabled', () => {
  assert.equal(resolveE2ERemoteDebuggingPort({
    OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT: '9222',
  }), null)
})

test('e2e remote debugging port must be a valid TCP port', () => {
  assert.equal(resolveE2ERemoteDebuggingPort({
    OPEN_COWORK_E2E: '1',
    OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT: '0',
  }), null)
  assert.equal(resolveE2ERemoteDebuggingPort({
    OPEN_COWORK_E2E: '1',
    OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT: '65536',
  }), null)
  assert.equal(resolveE2ERemoteDebuggingPort({
    OPEN_COWORK_E2E: '1',
    OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT: '9222',
  }), '9222')
})

test('e2e remote debugging appends address and port switches', () => {
  const switches: Array<[string, string]> = []
  const didAppend = appendE2ERemoteDebuggingSwitches({
    commandLine: {
      appendSwitch(name: string, value?: string) {
        switches.push([name, value || ''])
      },
    },
  }, {
    OPEN_COWORK_E2E: '1',
    OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT: '9333',
  })

  assert.equal(didAppend, true)
  assert.deepEqual(switches, [
    ['remote-debugging-address', '127.0.0.1'],
    ['remote-debugging-port', '9333'],
  ])
})

test('e2e ready file containment rejects rooted and cross-volume relative paths', () => {
  assert.equal(e2eReadyFileRelativePathIsContained('probe/ready.json'), true)
  assert.equal(e2eReadyFileRelativePathIsContained('probe\\ready.json'), true)
  assert.equal(e2eReadyFileRelativePathIsContained(''), false)
  assert.equal(e2eReadyFileRelativePathIsContained('../ready.json'), false)
  assert.equal(e2eReadyFileRelativePathIsContained('..\\ready.json'), false)
  assert.equal(e2eReadyFileRelativePathIsContained('/tmp/ready.json'), false)
  assert.equal(e2eReadyFileRelativePathIsContained('\\tmp\\ready.json'), false)
  assert.equal(e2eReadyFileRelativePathIsContained('D:\\tmp\\ready.json'), false)
})

test('e2e window ready probe is enabled only for contained smoke files', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'open-cowork-e2e-probe-'))
  try {
    assert.equal(e2eWindowReadyProbeEnabled({
      OPEN_COWORK_E2E: '1',
      TMPDIR: tempRoot,
      OPEN_COWORK_E2E_READY_FILE: join(tempRoot, 'probe.json'),
    }), true)
    assert.equal(e2eWindowReadyProbeEnabled({
      OPEN_COWORK_E2E: '1',
      TMPDIR: tempRoot,
      OPEN_COWORK_E2E_READY_FILE: join(tempRoot, '..', 'probe.json'),
    }), false)
    assert.equal(e2eWindowReadyProbeEnabled({
      TMPDIR: tempRoot,
      OPEN_COWORK_E2E_READY_FILE: join(tempRoot, 'probe.json'),
    }), false)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('e2e arg environment applies only smoke allowlisted keys', () => {
  const args = buildE2EArgEnvironment({
    OPEN_COWORK_E2E: '1',
    OPEN_COWORK_E2E_READY_FILE: '/tmp/open-cowork/probe.json',
    OPEN_COWORK_CONFIG_PATH: '/tmp/open-cowork/config.json',
    HOME: '/tmp/should-not-apply',
  })
  assert.equal(args.length, 3)

  const env: NodeJS.ProcessEnv = { [E2E_ARG_ENV_ENABLE_KEY]: '1' }
  applyE2EArgEnvironment([
    'Open Cowork',
    ...args,
    '--open-cowork-e2e-env=HOME=%2Ftmp%2Fnot-applied',
    '--open-cowork-e2e-env=OPEN_COWORK_E2E_READY_FILE=%',
  ], env)

  assert.deepEqual(env, {
    [E2E_ARG_ENV_ENABLE_KEY]: '1',
    OPEN_COWORK_E2E: '1',
    OPEN_COWORK_E2E_READY_FILE: '/tmp/open-cowork/probe.json',
    OPEN_COWORK_CONFIG_PATH: '/tmp/open-cowork/config.json',
  })
})

test('e2e arg environment is ignored without the trusted smoke marker', () => {
  const args = buildE2EArgEnvironment({
    OPEN_COWORK_E2E: '1',
    OPEN_COWORK_E2E_REMOTE_DEBUGGING_PORT: '9333',
  })
  const env: NodeJS.ProcessEnv = {}

  applyE2EArgEnvironment(['Open Cowork', ...args], env)

  assert.deepEqual(env, {})
})
