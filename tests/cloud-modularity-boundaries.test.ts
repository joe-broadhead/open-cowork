import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const cloudRoot = join(root, 'apps/desktop/src/main/cloud')
const cloudClientRoot = join(root, 'packages/cloud-client/src')
const architectureDoc = readFileSync(join(root, 'docs/architecture.md'), 'utf8')

const lineThreshold = 2_000
const documentedLargeFileExceptions = new Set([
  'apps/desktop/src/main/cloud/in-memory-control-plane-store.ts',
  'apps/desktop/src/main/cloud/postgres-control-plane-store.ts',
  'apps/desktop/src/main/cloud/session-service.ts',
])

test('cloud core has enforceable domain module boundaries', () => {
  const expectedStoreDomains = [
    'identity.ts',
    'billing.ts',
    'byok.ts',
    'channels.ts',
    'sessions.ts',
    'settings.ts',
    'workflows.ts',
    'thread-index.ts',
    'schema.ts',
  ]
  for (const file of expectedStoreDomains) {
    assert.equal(existsSync(join(cloudRoot, 'control-plane-domains', file)), true, `${file} domain store contract is missing`)
  }

  const expectedRoutes = [
    'api-tokens.ts',
    'billing.ts',
    'byok.ts',
    'channels.ts',
    'project-sources.ts',
    'workspace.ts',
  ]
  for (const file of expectedRoutes) {
    assert.equal(existsSync(join(cloudRoot, 'http-routes', file)), true, `${file} route module is missing`)
  }

  const expectedServices = [
    'identity-service.ts',
    'byok-service.ts',
    'billing-service.ts',
    'quota-service.ts',
    'channel-service.ts',
    'workflow-service.ts',
    'projection-service.ts',
  ]
  for (const file of expectedServices) {
    assert.equal(existsSync(join(cloudRoot, 'services', file)), true, `${file} domain service is missing`)
  }
})

test('cloud client exposes a thin public barrel and domain barrels', () => {
  const indexSource = readFileSync(join(cloudClientRoot, 'index.ts'), 'utf8')
  assert.doesNotMatch(indexSource, /function createHttpSseCloudTransportAdapter/)
  assert.match(indexSource, /export \* from '\.\/adapter\.js'/)

  const expectedClientDomains = [
    'artifacts.ts',
    'billing.ts',
    'byok.ts',
    'capabilities.ts',
    'channels.ts',
    'config.ts',
    'identity.ts',
    'sessions.ts',
    'settings.ts',
    'threads.ts',
    'transport.ts',
    'workflows.ts',
  ]
  for (const file of expectedClientDomains) {
    assert.equal(existsSync(join(cloudClientRoot, 'domains', file)), true, `${file} cloud-client domain barrel is missing`)
  }
})

test('large cloud source files are documented exceptions', () => {
  const sourceRoots = [cloudRoot, cloudClientRoot]
  for (const sourceRoot of sourceRoots) {
    for (const file of sourceFiles(sourceRoot)) {
      const relativePath = relative(root, file)
      const lineCount = readFileSync(file, 'utf8').split('\n').length
      if (lineCount <= lineThreshold) continue
      assert.equal(
        documentedLargeFileExceptions.has(relativePath),
        true,
        `${relativePath} has ${lineCount} lines and needs a documented modularity exception or further splitting`,
      )
      assert.match(
        architectureDoc,
        new RegExp(relativePath.split('/').at(-1)!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${relativePath} is a large-file exception but is not documented in docs/architecture.md`,
      )
    }
  }
})

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory)) {
    if (entry === 'dist' || entry === 'node_modules') continue
    const path = join(directory, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...sourceFiles(path))
    else if (path.endsWith('.ts')) files.push(path)
  }
  return files
}
