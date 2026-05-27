import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createObjectWorkspaceCheckpointStore,
  defaultCloudSessionCheckpointRoots,
  sessionCheckpointLatestKey,
} from '../apps/desktop/src/main/cloud/workspace-checkpoint-store.ts'
import { createInMemoryObjectStore } from '../apps/desktop/src/main/cloud/object-store.ts'
import { createPlaintextSecretAdapter } from '../apps/desktop/src/main/cloud/secret-adapter.ts'
import { createCloudPathProvider } from '../apps/desktop/src/main/cloud/path-provider.ts'

async function writeFixture(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value)
}

test('workspace checkpoint store saves a manifest and restores runtime/workspace files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-checkpoint-'))
  const sourcePaths = createCloudPathProvider(join(root, 'source'))
  const targetPaths = createCloudPathProvider(join(root, 'target'))
  const sourceRuntime = sourcePaths.getRuntimeXdgRoots()
  const targetRuntime = targetPaths.getRuntimeXdgRoots()
  const objectStore = createInMemoryObjectStore()
  const store = createObjectWorkspaceCheckpointStore({
    objectStore,
    secretAdapter: createPlaintextSecretAdapter(),
  })

  await writeFixture(join(sourceRuntime.dataHome, 'opencode', 'session.json'), '{"id":"session-1"}')
  await writeFixture(join(sourceRuntime.configHome, 'opencode', 'auth.json'), 'secret-token')
  await writeFixture(sourcePaths.resolveWorkspacePath('tenant-1', 'session-1', 'README.md'), 'workspace file')
  await writeFixture(sourcePaths.resolveArtifactPath('tenant-1', 'session-1', 'chart.json'), '{"mark":"bar"}')

  const manifest = await store.saveSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    checkpointId: 'checkpoint-1',
    checkpointVersion: 3,
    roots: defaultCloudSessionCheckpointRoots(sourcePaths, 'tenant-1', 'session-1'),
    now: new Date('2026-01-01T00:00:00.000Z'),
  })

  assert.equal(manifest.checkpointId, 'checkpoint-1')
  assert.equal(manifest.checkpointVersion, 3)
  assert.equal(manifest.entries.length, 4)
  assert.equal((await objectStore.headObject(sessionCheckpointLatestKey({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
  })))?.metadata.latest, 'true')

  const secretEntry = manifest.entries.find((entry) => entry.rootId === 'opencode-config' && entry.relativePath === 'auth.json')
  assert.ok(secretEntry)
  assert.equal(secretEntry.secretBearing, true)
  assert.equal(secretEntry.encrypted, true)
  const storedSecret = await objectStore.getObject(secretEntry.objectKey)
  assert.equal(storedSecret?.body.includes(Buffer.from('secret-token')), false)

  const restored = await store.restoreSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    roots: defaultCloudSessionCheckpointRoots(targetPaths, 'tenant-1', 'session-1'),
  })

  assert.equal(restored.restoredEntries, 4)
  assert.equal(await readFile(join(targetRuntime.dataHome, 'opencode', 'session.json'), 'utf8'), '{"id":"session-1"}')
  assert.equal(await readFile(join(targetRuntime.configHome, 'opencode', 'auth.json'), 'utf8'), 'secret-token')
  assert.equal(await readFile(targetPaths.resolveWorkspacePath('tenant-1', 'session-1', 'README.md'), 'utf8'), 'workspace file')
  assert.equal(await readFile(targetPaths.resolveArtifactPath('tenant-1', 'session-1', 'chart.json'), 'utf8'), '{"mark":"bar"}')
})

test('workspace checkpoint store requires secret storage for secret-bearing roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-checkpoint-secret-'))
  const paths = createCloudPathProvider(root)
  const runtime = paths.getRuntimeXdgRoots()
  const store = createObjectWorkspaceCheckpointStore({
    objectStore: createInMemoryObjectStore(),
  })

  await writeFixture(join(runtime.configHome, 'opencode', 'auth.json'), 'secret-token')

  await assert.rejects(() => store.saveSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    roots: defaultCloudSessionCheckpointRoots(paths, 'tenant-1', 'session-1'),
  }), /SecretAdapter/)
})

test('workspace checkpoint store rejects symlinks inside checkpoint roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-checkpoint-symlink-'))
  const paths = createCloudPathProvider(root)
  const workspacePath = paths.resolveWorkspacePath('tenant-1', 'session-1')
  const store = createObjectWorkspaceCheckpointStore({
    objectStore: createInMemoryObjectStore(),
    secretAdapter: createPlaintextSecretAdapter(),
  })

  await writeFixture(join(workspacePath, 'target.txt'), 'target')
  await symlink(join(workspacePath, 'target.txt'), join(workspacePath, 'link.txt'))

  await assert.rejects(() => store.saveSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    roots: defaultCloudSessionCheckpointRoots(paths, 'tenant-1', 'session-1'),
  }), /symlink/)
})

test('workspace checkpoint restore rejects object tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-checkpoint-tamper-'))
  const sourcePaths = createCloudPathProvider(join(root, 'source'))
  const targetPaths = createCloudPathProvider(join(root, 'target'))
  const objectStore = createInMemoryObjectStore()
  const store = createObjectWorkspaceCheckpointStore({
    objectStore,
    secretAdapter: createPlaintextSecretAdapter(),
  })

  await writeFixture(sourcePaths.resolveWorkspacePath('tenant-1', 'session-1', 'README.md'), 'workspace file')
  const manifest = await store.saveSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    checkpointId: 'checkpoint-1',
    roots: defaultCloudSessionCheckpointRoots(sourcePaths, 'tenant-1', 'session-1'),
  })
  const workspaceEntry = manifest.entries.find((entry) => entry.rootId === 'workspace' && entry.relativePath === 'README.md')
  assert.ok(workspaceEntry)

  await objectStore.putObject({
    key: workspaceEntry.objectKey,
    body: 'tampered',
  })

  await assert.rejects(() => store.restoreSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    roots: defaultCloudSessionCheckpointRoots(targetPaths, 'tenant-1', 'session-1'),
  }), /hash mismatch/)
})
