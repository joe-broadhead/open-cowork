import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  createObjectWorkspaceCheckpointStore,
  defaultCloudSessionCheckpointRoots,
  sessionCheckpointLatestKey,
} from '@open-cowork/cloud-server/workspace-checkpoint-store'
import { createInMemoryObjectStore } from '@open-cowork/cloud-server/object-store'
import {
  createEnvelopeSecretAdapter,
  createPlaintextSecretAdapter,
} from '@open-cowork/cloud-server/secret-adapter'
import { createCloudPathProvider } from '@open-cowork/cloud-server/path-provider'

const CHECKPOINT_KEY = 'checkpoint-store-test-key-material-with-sufficient-randomness'

async function writeFixture(path: string, value: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value)
}

function restoreScratchPaths(rootId: string, rootPath: string) {
  const rootKey = `${rootId}-${createHash('sha256').update(rootId).digest('hex')}`
  const prefix = join(dirname(rootPath), `.open-cowork-checkpoint-${rootKey}`)
  return {
    stagePath: `${prefix}.stage`,
    backupPath: `${prefix}.backup`,
  }
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
    secretAdapter: createEnvelopeSecretAdapter(CHECKPOINT_KEY),
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

test('workspace checkpoint store requires envelope encryption for every save', async () => {
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
  }), /envelope-encrypted SecretAdapter/)

  const plaintextStore = createObjectWorkspaceCheckpointStore({
    objectStore: createInMemoryObjectStore(),
    secretAdapter: createPlaintextSecretAdapter(),
  })
  await assert.rejects(() => plaintextStore.saveSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    roots: defaultCloudSessionCheckpointRoots(paths, 'tenant-1', 'session-1'),
  }), /envelope-encrypted SecretAdapter/)
})

test('workspace checkpoint store skips symlinks inside checkpoint roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-checkpoint-symlink-'))
  const paths = createCloudPathProvider(root)
  const workspacePath = paths.resolveWorkspacePath('tenant-1', 'session-1')
  const store = createObjectWorkspaceCheckpointStore({
    objectStore: createInMemoryObjectStore(),
    secretAdapter: createEnvelopeSecretAdapter(CHECKPOINT_KEY),
  })

  await writeFixture(join(workspacePath, 'target.txt'), 'target')
  await symlink(join(workspacePath, 'target.txt'), join(workspacePath, 'link.txt'))

  const manifest = await store.saveSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    roots: defaultCloudSessionCheckpointRoots(paths, 'tenant-1', 'session-1'),
  })

  assert.deepEqual(manifest.entries.map((entry) => entry.relativePath), ['target.txt'])
})

test('workspace checkpoint capture rejects a parent symlink swap without uploading outside data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-checkpoint-swap-'))
  const workspacePath = join(root, 'workspace')
  const nestedPath = join(workspacePath, 'nested')
  const movedNestedPath = join(workspacePath, 'nested-original')
  const outsidePath = join(root, 'outside')
  const outsideSentinel = 'host-readable-data-that-must-not-be-checkpointed'
  await writeFixture(join(workspacePath, 'a-trigger.txt'), 'safe trigger')
  await writeFixture(join(nestedPath, 'z-target.txt'), 'safe workspace data')
  await writeFixture(join(outsidePath, 'z-target.txt'), outsideSentinel)

  const backingStore = createInMemoryObjectStore()
  const rawBodies: Buffer[] = []
  let swapped = false
  const objectStore = {
    ...backingStore,
    async putObject(input: Parameters<typeof backingStore.putObject>[0]) {
      rawBodies.push(Buffer.from(input.body))
      const result = await backingStore.putObject(input)
      if (!swapped && input.key.includes('/files/')) {
        swapped = true
        await rename(nestedPath, movedNestedPath)
        await symlink(outsidePath, nestedPath)
      }
      return result
    },
  }
  const store = createObjectWorkspaceCheckpointStore({
    objectStore,
    secretAdapter: createEnvelopeSecretAdapter(CHECKPOINT_KEY),
  })

  await assert.rejects(() => store.saveSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    checkpointId: 'checkpoint-swap',
    roots: [{
      rootId: 'workspace',
      kind: 'workspace',
      path: workspacePath,
      required: true,
    }],
  }), /escapes root|changed before capture/)
  assert.equal(rawBodies.some((body) => body.includes(Buffer.from(outsideSentinel))), false)
  assert.equal(await backingStore.getObject(sessionCheckpointLatestKey({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
  })), null)
})

test('workspace checkpoint restore rejects object tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-checkpoint-tamper-'))
  const sourcePaths = createCloudPathProvider(join(root, 'source'))
  const targetPaths = createCloudPathProvider(join(root, 'target'))
  const objectStore = createInMemoryObjectStore()
  const store = createObjectWorkspaceCheckpointStore({
    objectStore,
    secretAdapter: createEnvelopeSecretAdapter(CHECKPOINT_KEY),
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
  const originalObject = await objectStore.getObject(workspaceEntry.objectKey)
  assert.ok(originalObject)

  const targetWorkspace = targetPaths.resolveWorkspacePath('tenant-1', 'session-1')
  await writeFixture(join(targetWorkspace, 'README.md'), 'existing live file')
  await writeFixture(join(targetWorkspace, 'stale.txt'), 'existing stale file')

  await objectStore.putObject({
    key: workspaceEntry.objectKey,
    body: 'tampered',
  })

  await assert.rejects(() => store.restoreSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    roots: defaultCloudSessionCheckpointRoots(targetPaths, 'tenant-1', 'session-1'),
  }), /Checkpoint stored size mismatch|encrypted cloud secret envelope/)
  assert.equal(await readFile(join(targetWorkspace, 'README.md'), 'utf8'), 'existing live file')
  assert.equal(await readFile(join(targetWorkspace, 'stale.txt'), 'utf8'), 'existing stale file')

  await objectStore.putObject({
    key: originalObject.key,
    body: originalObject.body,
    contentType: originalObject.contentType,
    metadata: originalObject.metadata,
  })
  await store.restoreSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    roots: defaultCloudSessionCheckpointRoots(targetPaths, 'tenant-1', 'session-1'),
  })
  assert.equal(await readFile(join(targetWorkspace, 'README.md'), 'utf8'), 'workspace file')
  await assert.rejects(() => readFile(join(targetWorkspace, 'stale.txt')), { code: 'ENOENT' })
})

test('workspace checkpoint restore recovers and removes crash-left staging state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-checkpoint-crash-recovery-'))
  const sourceRoot = join(root, 'source-workspace')
  const targetRoot = join(root, 'target-workspace')
  const objectStore = createInMemoryObjectStore()
  const store = createObjectWorkspaceCheckpointStore({
    objectStore,
    secretAdapter: createEnvelopeSecretAdapter(CHECKPOINT_KEY),
  })
  const roots = (path: string) => [{
    rootId: 'workspace',
    kind: 'workspace' as const,
    path,
    required: true,
  }]
  await writeFixture(join(sourceRoot, 'README.md'), 'restored workspace')
  await store.saveSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    checkpointId: 'checkpoint-crash-recovery',
    roots: roots(sourceRoot),
  })

  await writeFixture(join(targetRoot, 'README.md'), 'pre-crash workspace')
  const { stagePath, backupPath } = restoreScratchPaths('workspace', targetRoot)
  await rename(targetRoot, backupPath)
  await writeFixture(join(stagePath, 'decrypted-residue.txt'), 'must be removed')

  await store.restoreSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    roots: roots(targetRoot),
  })
  assert.equal(await readFile(join(targetRoot, 'README.md'), 'utf8'), 'restored workspace')
  await assert.rejects(() => access(stagePath), { code: 'ENOENT' })
  await assert.rejects(() => access(backupPath), { code: 'ENOENT' })
})

test('workspace checkpoint retry rolls every partially swapped root back before validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-checkpoint-multi-root-crash-'))
  const sourceA = join(root, 'source-a')
  const sourceB = join(root, 'source-b')
  const targetA = join(root, 'target-a')
  const targetB = join(root, 'target-b')
  const objectStore = createInMemoryObjectStore()
  const store = createObjectWorkspaceCheckpointStore({
    objectStore,
    secretAdapter: createEnvelopeSecretAdapter(CHECKPOINT_KEY),
  })
  const roots = (left: string, right: string) => [
    { rootId: 'workspace-a', kind: 'workspace' as const, path: left, required: true },
    { rootId: 'workspace-b', kind: 'workspace' as const, path: right, required: true },
  ]
  await writeFixture(join(sourceA, 'state.txt'), 'checkpoint A')
  await writeFixture(join(sourceB, 'state.txt'), 'checkpoint B')
  const manifest = await store.saveSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    checkpointId: 'checkpoint-multi-root',
    roots: roots(sourceA, sourceB),
  })
  await writeFixture(join(targetA, 'state.txt'), 'original A')
  await writeFixture(join(targetB, 'state.txt'), 'original B')

  const scratchA = restoreScratchPaths('workspace-a', targetA)
  const scratchB = restoreScratchPaths('workspace-b', targetB)
  await rename(targetA, scratchA.backupPath)
  await writeFixture(join(targetA, 'state.txt'), 'partially installed A')
  await rename(targetB, scratchB.backupPath)
  await writeFixture(join(scratchB.stagePath, 'state.txt'), 'staged B')
  const missingEntry = manifest.entries.find((entry) => entry.rootId === 'workspace-b')
  assert.ok(missingEntry)
  await objectStore.deleteObject(missingEntry.objectKey)

  await assert.rejects(() => store.restoreSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    roots: roots(targetA, targetB),
  }), /Checkpoint object is missing/)
  assert.equal(await readFile(join(targetA, 'state.txt'), 'utf8'), 'original A')
  assert.equal(await readFile(join(targetB, 'state.txt'), 'utf8'), 'original B')
  for (const path of [
    scratchA.stagePath,
    scratchA.backupPath,
    scratchB.stagePath,
    scratchB.backupPath,
  ]) {
    await assert.rejects(() => access(path), { code: 'ENOENT' })
  }
})

test('workspace checkpoint store encrypts arbitrary-name payloads without leaking secret classification metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-checkpoint-arbitrary-secret-'))
  const sourcePaths = createCloudPathProvider(join(root, 'source'))
  const targetPaths = createCloudPathProvider(join(root, 'target'))
  const objectStore = createInMemoryObjectStore()
  const store = createObjectWorkspaceCheckpointStore({
    objectStore,
    secretAdapter: createEnvelopeSecretAdapter(CHECKPOINT_KEY),
  })
  const sentinel = 'arbitrary-name-sensitive-value-7df01ab4'
  const relativePath = 'ordinary-notes.bin'
  await writeFixture(
    sourcePaths.resolveWorkspacePath('tenant-1', 'session-1', relativePath),
    sentinel,
  )

  const manifest = await store.saveSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    checkpointId: 'checkpoint-arbitrary-secret',
    roots: defaultCloudSessionCheckpointRoots(sourcePaths, 'tenant-1', 'session-1'),
  })

  assert.ok(manifest.entries.length > 0)
  assert.equal(manifest.entries.every((entry) => entry.encrypted && entry.secretBearing), true)
  assert.equal(manifest.roots.every((checkpointRoot) => checkpointRoot.secretBearing), true)
  const rawKeys = [
    ...manifest.entries.map((entry) => entry.objectKey),
    manifest.manifestKey,
    manifest.latestKey,
  ]
  for (const key of rawKeys) {
    const rawObject = await objectStore.getObject(key)
    assert.ok(rawObject)
    assert.equal(
      rawObject.body.includes(Buffer.from(sentinel)),
      false,
      `raw object ${key} leaked the arbitrary-name sentinel`,
    )
  }
  for (const entry of manifest.entries) {
    const stored = await objectStore.headObject(entry.objectKey)
    assert.ok(stored)
    assert.equal(stored.metadata.encrypted, 'true')
    assert.equal('secret' in stored.metadata, false)
  }

  await store.restoreSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    roots: defaultCloudSessionCheckpointRoots(targetPaths, 'tenant-1', 'session-1'),
  })
  assert.equal(
    await readFile(targetPaths.resolveWorkspacePath('tenant-1', 'session-1', relativePath), 'utf8'),
    sentinel,
  )
})

test('workspace checkpoint restore remains compatible with legacy plaintext manifest entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-checkpoint-legacy-plaintext-'))
  const sourcePaths = createCloudPathProvider(join(root, 'source'))
  const targetPaths = createCloudPathProvider(join(root, 'target'))
  const objectStore = createInMemoryObjectStore()
  const store = createObjectWorkspaceCheckpointStore({
    objectStore,
    secretAdapter: createEnvelopeSecretAdapter(CHECKPOINT_KEY),
  })
  const legacyValue = 'legacy-plaintext-checkpoint-payload'
  await writeFixture(
    sourcePaths.resolveWorkspacePath('tenant-1', 'session-1', 'legacy.txt'),
    legacyValue,
  )
  const manifest = await store.saveSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    checkpointId: 'legacy-plaintext',
    roots: defaultCloudSessionCheckpointRoots(sourcePaths, 'tenant-1', 'session-1'),
  })
  const entry = manifest.entries.find((candidate) => candidate.relativePath === 'legacy.txt')
  assert.ok(entry)
  const legacyManifest = {
    ...manifest,
    entries: manifest.entries.map((candidate) => candidate.objectKey === entry.objectKey
      ? {
          ...candidate,
          storedSize: Buffer.byteLength(legacyValue),
          secretBearing: false,
          encrypted: false,
        }
      : candidate),
  }
  await objectStore.putObject({
    key: entry.objectKey,
    body: legacyValue,
    contentType: 'application/octet-stream',
    metadata: {
      encrypted: 'false',
    },
  })
  const legacyManifestBody = JSON.stringify(legacyManifest, null, 2)
  await objectStore.putObject({
    key: manifest.manifestKey,
    body: legacyManifestBody,
  })
  await objectStore.putObject({
    key: manifest.latestKey,
    body: legacyManifestBody,
  })

  const restored = await store.restoreSessionCheckpoint({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    roots: defaultCloudSessionCheckpointRoots(targetPaths, 'tenant-1', 'session-1'),
  })
  assert.equal(restored.restoredEntries, 1)
  assert.equal(
    await readFile(targetPaths.resolveWorkspacePath('tenant-1', 'session-1', 'legacy.txt'), 'utf8'),
    legacyValue,
  )
})

test('workspace checkpoint keys do not collide after normalization and retain legacy read compatibility', async () => {
  assert.notEqual(
    sessionCheckpointLatestKey({ tenantId: 'Tenant!', sessionId: 'Session?' }),
    sessionCheckpointLatestKey({ tenantId: 'tenant?', sessionId: 'session!' }),
  )

  const objectStore = createInMemoryObjectStore()
  const store = createObjectWorkspaceCheckpointStore({ objectStore })
  const legacyLatestKey = 'tenants/tenant/sessions/session/checkpoints/latest.json'
  const legacyManifestKey = 'tenants/tenant/sessions/session/checkpoints/checkpoint/manifest.json'
  await objectStore.putObject({
    key: legacyLatestKey,
    body: JSON.stringify({
      version: 1,
      tenantId: 'Tenant!',
      sessionId: 'Session?',
      checkpointId: 'Checkpoint!',
      checkpointVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      manifestKey: legacyManifestKey,
      latestKey: legacyLatestKey,
      roots: [],
      entries: [],
    }),
  })

  const legacy = await store.readSessionCheckpoint({
    tenantId: 'Tenant!',
    sessionId: 'Session?',
  })
  assert.equal(legacy?.checkpointId, 'Checkpoint!')
})
