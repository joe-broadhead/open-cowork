import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectOrphanedManagedProcessTree,
  collectProcessTreeFromRootPids,
  isManagedOpencodeServeCommand,
  OPEN_COWORK_MANAGED_RUNTIME_ENV,
  OPEN_COWORK_MANAGED_RUNTIME_VALUE,
  parsePsOutput,
} from '../apps/desktop/src/main/runtime-process-cleanup.ts'

test('isManagedOpencodeServeCommand only matches Cowork-owned runtime servers', () => {
  assert.equal(
    isManagedOpencodeServeCommand(`/opt/opencode/bin/opencode serve --hostname=127.0.0.1 --port=0 PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`),
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

test('collectOrphanedManagedProcessTree returns orphaned Cowork runtime roots and descendants', () => {
  const processes = parsePsOutput([
    `81762 1 /opt/opencode/bin/opencode serve --hostname=127.0.0.1 --port=0 PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`,
    `81763 81762 node /opt/open-cowork/mcps/charts/dist/index.js PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`,
    `81764 81762 node /opt/open-cowork/mcps/skills/dist/index.js PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`,
    `91250 90000 /opt/opencode/bin/opencode serve --hostname=127.0.0.1 --port=0 PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`,
    `91251 91250 node /opt/open-cowork/mcps/charts/dist/index.js PATH=/usr/bin ${OPEN_COWORK_MANAGED_RUNTIME_ENV}=${OPEN_COWORK_MANAGED_RUNTIME_VALUE}`,
    '93000 1 /Users/someone/.nvm/versions/node/v22/bin/opencode serve --hostname=127.0.0.1 --port=0 PATH=/usr/bin',
  ].join('\n'))

  const collected = collectOrphanedManagedProcessTree(processes)

  assert.deepEqual(
    collected.map((entry) => entry.pid),
    [81763, 81764, 81762],
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
