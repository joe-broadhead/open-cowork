import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { DEFAULT_CONFIG } from '../apps/desktop/src/main/config-types.ts'
import { resolveCloudRuntimePolicy } from '../apps/desktop/src/main/cloud/cloud-config.ts'
import { createInMemoryObjectStore } from '../apps/desktop/src/main/cloud/object-store.ts'
import { createCloudPathProvider } from '../apps/desktop/src/main/cloud/path-provider.ts'
import { createCloudProjectSourceService } from '../apps/desktop/src/main/cloud/project-source-service.ts'

const execFile = promisify(execFileCallback)

function principal() {
  return {
    tenantId: 'tenant-a',
    userId: 'user-a',
    email: 'user@example.test',
  }
}

test('cloud project source service uploads and restores a snapshot into a sandbox workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-project-restore-'))
  const paths = createCloudPathProvider(root)
  const objectStore = createInMemoryObjectStore()
  const service = createCloudProjectSourceService({
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    objectStore,
  })

  const uploaded = await service.uploadSnapshot(principal(), {
    title: 'fixture',
    files: [{
      path: 'README.md',
      dataBase64: Buffer.from('from snapshot').toString('base64'),
      byteCount: 'from snapshot'.length,
    }],
    fileCount: 1,
    byteCount: 'from snapshot'.length,
  })
  const restored = await service.restoreProjectSource({
    tenantId: 'tenant-a',
    sessionId: 'session-a',
    source: uploaded.projectSource,
    paths,
  })

  assert.equal(restored.restored, true)
  assert.equal(
    await readFile(paths.resolveWorkspacePath('tenant-a', 'session-a', 'README.md'), 'utf8'),
    'from snapshot',
  )
})

test('cloud project source service rejects secret-bearing snapshot uploads', async () => {
  const service = createCloudProjectSourceService({
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    objectStore: createInMemoryObjectStore(),
  })

  await assert.rejects(() => service.uploadSnapshot(principal(), {
    files: [{
      path: '.env',
      dataBase64: Buffer.from('SECRET=value').toString('base64'),
      byteCount: 12,
    }],
    fileCount: 1,
    byteCount: 12,
  }), /blocked file/)
})

test('cloud project source service refuses to restore snapshots across tenants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'open-cowork-project-restore-tenant-'))
  const paths = createCloudPathProvider(root)
  const objectStore = createInMemoryObjectStore()
  const service = createCloudProjectSourceService({
    policy: resolveCloudRuntimePolicy(DEFAULT_CONFIG),
    objectStore,
  })
  const uploaded = await service.uploadSnapshot(principal(), {
    files: [{
      path: 'README.md',
      dataBase64: Buffer.from('from tenant a').toString('base64'),
      byteCount: 'from tenant a'.length,
    }],
    fileCount: 1,
    byteCount: 'from tenant a'.length,
  })

  await assert.rejects(() => service.restoreProjectSource({
    tenantId: 'tenant-b',
    sessionId: 'session-b',
    source: uploaded.projectSource,
    paths,
  }), /does not belong/)
})

test('cloud project source service restores a git source from a local fixture repo when policy permits file URLs', async (t) => {
  try {
    await execFile('git', ['--version'])
  } catch {
    t.skip('git is not available')
    return
  }

  const root = await mkdtemp(join(tmpdir(), 'open-cowork-project-git-'))
  const repo = join(root, 'repo')
  await mkdir(repo)
  await execFile('git', ['init'], { cwd: repo })
  await execFile('git', ['config', 'user.email', 'test@example.test'], { cwd: repo })
  await execFile('git', ['config', 'user.name', 'Test User'], { cwd: repo })
  await writeFile(join(repo, 'README.md'), 'from git')
  await execFile('git', ['add', 'README.md'], { cwd: repo })
  await execFile('git', ['commit', '-m', 'initial'], { cwd: repo })

  const policy = resolveCloudRuntimePolicy({
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      projectSources: {
        ...DEFAULT_CONFIG.cloud.projectSources,
        git: {
          ...DEFAULT_CONFIG.cloud.projectSources.git,
          allowFileUrls: true,
        },
      },
    },
  })
  const paths = createCloudPathProvider(join(root, 'worker'))
  const service = createCloudProjectSourceService({
    policy,
    objectStore: createInMemoryObjectStore(),
  })
  await service.restoreProjectSource({
    tenantId: 'tenant-a',
    sessionId: 'session-a',
    source: {
      kind: 'git',
      repositoryUrl: pathToFileURL(repo).toString(),
      ref: 'HEAD',
    },
    paths,
  })

  assert.equal(
    await readFile(paths.resolveWorkspacePath('tenant-a', 'session-a', 'README.md'), 'utf8'),
    'from git',
  )
})

test('cloud project source service restores git subdirectories as the sandbox root', async (t) => {
  try {
    await execFile('git', ['--version'])
  } catch {
    t.skip('git is not available')
    return
  }

  const root = await mkdtemp(join(tmpdir(), 'open-cowork-project-git-subdir-'))
  const repo = join(root, 'repo')
  await mkdir(join(repo, 'packages', 'app'), { recursive: true })
  await execFile('git', ['init'], { cwd: repo })
  await execFile('git', ['config', 'user.email', 'test@example.test'], { cwd: repo })
  await execFile('git', ['config', 'user.name', 'Test User'], { cwd: repo })
  await writeFile(join(repo, 'README.md'), 'repo root')
  await writeFile(join(repo, 'packages', 'app', 'README.md'), 'app root')
  await execFile('git', ['add', 'README.md', 'packages/app/README.md'], { cwd: repo })
  await execFile('git', ['commit', '-m', 'initial'], { cwd: repo })

  const policy = resolveCloudRuntimePolicy({
    ...DEFAULT_CONFIG,
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      projectSources: {
        ...DEFAULT_CONFIG.cloud.projectSources,
        git: {
          ...DEFAULT_CONFIG.cloud.projectSources.git,
          allowFileUrls: true,
        },
      },
    },
  })
  const paths = createCloudPathProvider(join(root, 'worker'))
  const service = createCloudProjectSourceService({
    policy,
    objectStore: createInMemoryObjectStore(),
  })
  await service.restoreProjectSource({
    tenantId: 'tenant-a',
    sessionId: 'session-a',
    source: {
      kind: 'git',
      repositoryUrl: pathToFileURL(repo).toString(),
      ref: 'HEAD',
      subdirectory: 'packages/app',
    },
    paths,
  })

  assert.equal(
    await readFile(paths.resolveWorkspacePath('tenant-a', 'session-a', 'README.md'), 'utf8'),
    'app root',
  )
})
