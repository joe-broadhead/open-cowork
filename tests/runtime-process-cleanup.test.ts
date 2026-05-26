import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  buildPsSnapshotArgs,
  collectOrphanedManagedProcessTree,
  collectProcessTreeFromRootPids,
  isManagedOpencodeServeCommand,
  OPEN_COWORK_MANAGED_RUNTIME_ENV,
  OPEN_COWORK_MANAGED_RUNTIME_VALUE,
  parsePsOutput,
  readTrackedManagedRuntimePids,
  registerTrackedManagedRuntimePid,
  unregisterTrackedManagedRuntimePid,
} from '../apps/desktop/src/main/runtime-process-cleanup.ts'

function testTempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('isManagedOpencodeServeCommand only matches Cowork-owned runtime servers', () => {
  assert.equal(
    isManagedOpencodeServeCommand(`/opt/opencode/bin/opencode serve --hostname=127.0.0.1 --port=0 PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`),
    true,
  )
  assert.equal(
    isManagedOpencodeServeCommand('/Applications/Open Cowork.app/Contents/Resources/app.asar.unpacked/node_modules/opencode-darwin-arm64/bin/opencode serve --hostname=127.0.0.1 --port=0'),
    true,
  )
  assert.equal(
    isManagedOpencodeServeCommand('/Users/someone/.nvm/versions/node/v22/bin/opencode serve --hostname=127.0.0.1 --port=0 PATH=/usr/bin'),
    false,
  )
})

test('parsePsOutput reads pid, ppid, and command from ps output', () => {
  const parsed = parsePsOutput([
    `81762 1 /opt/opencode/bin/opencode serve --hostname=127.0.0.1 --port=0 PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`,
    `81763 81762 node /opt/open-cowork/mcps/charts/dist/index.js PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`,
  ].join('\n'))

  assert.deepEqual(parsed, [
    {
      pid: 81762,
      ppid: 1,
      command: `/opt/opencode/bin/opencode serve --hostname=127.0.0.1 --port=0 PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`,
    },
    {
      pid: 81763,
      ppid: 81762,
      command: `node /opt/open-cowork/mcps/charts/dist/index.js PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`,
    },
  ])
})

test('parsePsOutput skips headers and malformed rows while preserving ppid zero', () => {
  const parsed = parsePsOutput([
    'PID PPID COMMAND',
    'not-a-pid 1 /bin/echo bad',
    '1000 0 /sbin/launchd',
    '1001 1000',
    '1002 1000 COMMAND',
    '1003 1000 ARGS',
    '1004 1000 /usr/bin/node script.js',
  ].join('\n'))

  assert.deepEqual(parsed, [
    {
      pid: 1000,
      ppid: 0,
      command: '/sbin/launchd',
    },
    {
      pid: 1004,
      ppid: 1000,
      command: '/usr/bin/node script.js',
    },
  ])
})

test('buildPsSnapshotArgs chooses platform-specific command columns', () => {
  assert.deepEqual(buildPsSnapshotArgs('darwin', false), ['-axo', 'pid=,ppid=,command='])
  assert.deepEqual(buildPsSnapshotArgs('darwin', true), ['eww', '-axo', 'pid=,ppid=,command='])
  assert.deepEqual(buildPsSnapshotArgs('linux', false), ['-axo', 'pid=,ppid=,args='])
  assert.deepEqual(buildPsSnapshotArgs('linux', true), ['eww', '-axo', 'pid=,ppid=,args='])
  assert.equal(buildPsSnapshotArgs('win32', false), null)
})

test('collectOrphanedManagedProcessTree returns orphaned Cowork runtime roots and descendants', () => {
  const processes = parsePsOutput([
    `81762 1 /opt/opencode/bin/opencode serve --hostname=127.0.0.1 --port=0 PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`,
    `81763 81762 node /opt/open-cowork/mcps/charts/dist/index.js PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`,
    `81764 81762 node /opt/open-cowork/mcps/skills/dist/index.js PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`,
    `91250 90000 /opt/opencode/bin/opencode serve --hostname=127.0.0.1 --port=0 PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`,
    `91251 91250 node /opt/open-cowork/mcps/charts/dist/index.js PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`,
    '92000 1 /Applications/Open Cowork.app/Contents/Resources/app.asar.unpacked/node_modules/opencode-darwin-arm64/bin/opencode serve --hostname=127.0.0.1 --port=0',
    '92001 92000 /Applications/Open Cowork.app/Contents/Resources/mcps/charts/dist/index.js',
    '93000 1 /Users/someone/.nvm/versions/node/v22/bin/opencode serve --hostname=127.0.0.1 --port=0 PATH=/usr/bin',
  ].join('\n'))

  const collected = collectOrphanedManagedProcessTree(processes)

  assert.deepEqual(
    collected.map((entry) => entry.pid),
    [81763, 81764, 81762, 92001, 92000],
  )
})

test('collectProcessTreeFromRootPids follows tracked runtime roots without environment markers', () => {
  const processes = parsePsOutput([
    '4100 1 /opt/opencode/bin/opencode serve --hostname=127.0.0.1 --port=0',
    '4101 4100 node /opt/open-cowork/mcps/charts/dist/index.js',
    '4102 4101 node /opt/open-cowork/mcps/google-drive/dist/index.js',
    '5100 1 /usr/local/bin/opencode serve --hostname=127.0.0.1 --port=0',
  ].join('\n'))

  const collected = collectProcessTreeFromRootPids(processes, [4100])

  assert.deepEqual(
    collected.map((entry) => entry.pid),
    [4102, 4101, 4100],
  )
})

test('runtime pid ledger writes private atomic state', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows ACLs do not map cleanly to POSIX mode assertions')
    return
  }

  const root = testTempDir('opencowork-runtime-pids-')
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  process.env.OPEN_COWORK_USER_DATA_DIR = root
  clearConfigCaches()

  try {
    registerTrackedManagedRuntimePid(4100)
    registerTrackedManagedRuntimePid(4100)
    registerTrackedManagedRuntimePid(4102)

    assert.deepEqual(readTrackedManagedRuntimePids(), [4100, 4102])
    const ledgerPath = join(root, 'runtime-home', '.local', 'state', 'managed-runtime-pids.json')
    assert.equal(statSync(ledgerPath).mode & 0o777, 0o600)

    unregisterTrackedManagedRuntimePid(4100)
    assert.deepEqual(readTrackedManagedRuntimePids(), [4102])
  } finally {
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    clearConfigCaches()
    rmSync(root, { recursive: true, force: true })
  }
})
