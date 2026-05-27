import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  buildPortableRuntimeManifest,
  isRuntimeSnapshotSecretBearingPath,
  runtimePathsForPortability,
} from '../apps/desktop/src/main/cloud/runtime-portability.ts'

test('runtime portability manifest inventories OpenCode XDG roots and Cowork runtime content', () => {
  const root = '/tmp/open-cowork-portability'
  const runtimePaths = runtimePathsForPortability({
    home: join(root, 'runtime-home'),
    configHome: join(root, 'runtime-home/.config'),
    dataHome: join(root, 'runtime-home/.local/share'),
    cacheHome: join(root, 'runtime-home/.cache'),
    stateHome: join(root, 'runtime-home/.local/state'),
  })

  const manifest = buildPortableRuntimeManifest({
    runtimePaths,
    workspaceDirs: [join(root, 'workspace')],
    artifactDirs: [join(root, 'chart-artifacts')],
    metadataPaths: [join(root, 'sessions.json')],
  })

  assert.deepEqual(
    manifest.map((entry) => entry.kind),
    [
      'opencode-config',
      'opencode-data',
      'opencode-state',
      'opencode-cache',
      'cowork-runtime-content',
      'cowork-runtime-content',
      'workspace',
      'artifact',
      'metadata',
    ],
  )
  assert.equal(manifest.find((entry) => entry.kind === 'opencode-cache')?.required, false)
  assert.equal(manifest.find((entry) => entry.kind === 'opencode-data')?.secretBearing, true)
  assert.equal(manifest.find((entry) => entry.path.endsWith('runtime-skill-catalog'))?.required, true)
})

test('runtime portability classifier flags secret-bearing snapshot paths', () => {
  assert.equal(isRuntimeSnapshotSecretBearingPath('/runtime-home/.local/share/opencode/auth.json'), true)
  assert.equal(isRuntimeSnapshotSecretBearingPath('/app-data/settings.enc'), true)
  assert.equal(isRuntimeSnapshotSecretBearingPath('/workspace/.env.production'), true)
  assert.equal(isRuntimeSnapshotSecretBearingPath('/workspace/report.csv'), false)
})
