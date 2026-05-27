import test from 'node:test'
import assert from 'node:assert/strict'

import { createCloudPathProvider } from '../apps/desktop/src/main/cloud/path-provider.ts'

test('cloud path provider derives stable runtime, workspace, and artifact roots', () => {
  const provider = createCloudPathProvider('/srv/open-cowork-cloud')

  assert.equal(provider.getAppDataDir(), '/srv/open-cowork-cloud/app')
  assert.deepEqual(provider.getRuntimeXdgRoots(), {
    home: '/srv/open-cowork-cloud/runtime/home',
    configHome: '/srv/open-cowork-cloud/runtime/xdg/config',
    dataHome: '/srv/open-cowork-cloud/runtime/xdg/data',
    stateHome: '/srv/open-cowork-cloud/runtime/xdg/state',
    cacheHome: '/srv/open-cowork-cloud/runtime/xdg/cache',
  })
  assert.equal(
    provider.resolveWorkspacePath('tenant-1', 'session-1', 'repo'),
    '/srv/open-cowork-cloud/workspaces/tenant-1/session-1/repo',
  )
  assert.equal(
    provider.resolveArtifactPath('tenant-1', 'session-1', 'chart.json'),
    '/srv/open-cowork-cloud/artifacts/tenant-1/session-1/chart.json',
  )
})

test('cloud path provider rejects absolute and traversal workspace paths', () => {
  const provider = createCloudPathProvider('/srv/open-cowork-cloud')

  assert.throws(() => provider.resolveWorkspacePath('../etc/passwd'), /relative path/)
  assert.throws(() => provider.resolveWorkspacePath('/etc/passwd'), /relative path/)
  assert.throws(() => provider.resolveArtifactPath('tenant-1', 'session-1', '..'), /relative path/)
})
