import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appendE2ERemoteDebuggingSwitches,
  e2eReadyFileRelativePathIsContained,
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
