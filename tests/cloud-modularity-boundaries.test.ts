import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const cloudRoot = join(root, 'apps/desktop/src/main/cloud')
const cloudClientRoot = join(root, 'packages/cloud-client/src')
const architectureDoc = readFileSync(join(root, 'docs/architecture.md'), 'utf8')

const lineThreshold = 2_000
const documentedLargeFileBudgets = new Map([
  ['apps/desktop/src/main/cloud/in-memory-control-plane-store.ts', 4_200],
  ['apps/desktop/src/main/cloud/postgres-control-plane-store.ts', 4_400],
  ['apps/desktop/src/main/cloud/session-service.ts', 4_200],
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

  const expectedPostgresDomains = [
    'billing.ts',
    'byok.ts',
    'channels.ts',
    'identity.ts',
    'schema.ts',
    'sessions.ts',
    'shared.ts',
    'thread-index.ts',
    'webhooks.ts',
    'workers.ts',
    'workflows.ts',
  ]
  for (const file of expectedPostgresDomains) {
    assert.equal(existsSync(join(cloudRoot, 'postgres-domains', file)), true, `${file} Postgres domain mapper is missing`)
  }

  const expectedRoutes = [
    'api-tokens.ts',
    'billing.ts',
    'byok.ts',
    'capabilities.ts',
    'channels.ts',
    'project-sources.ts',
    'settings.ts',
    'threads.ts',
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
    'managed-worker-service.ts',
    'session-command-service.ts',
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
      const budget = documentedLargeFileBudgets.get(relativePath)
      assert.equal(
        typeof budget,
        'number',
        `${relativePath} has ${lineCount} lines and needs a documented modularity budget or further splitting`,
      )
      assert.ok(
        lineCount <= budget!,
        `${relativePath} has ${lineCount} lines and exceeds its modularity budget of ${budget}`,
      )
      assert.match(
        architectureDoc,
        new RegExp(relativePath.split('/').at(-1)!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${relativePath} is a large-file exception but is not documented in docs/architecture.md`,
      )
    }
  }
})

test('postgres store delegates row mapping to domain modules', () => {
  const source = readFileSync(join(cloudRoot, 'postgres-control-plane-store.ts'), 'utf8')
  assert.doesNotMatch(source, /function \w+FromRow\(/, 'Postgres row mappers belong in postgres-domains/*')
  assert.match(source, /postgres-domains\/identity\.ts/)
  assert.match(source, /postgres-domains\/sessions\.ts/)
  assert.match(source, /postgres-domains\/channels\.ts/)
  assert.match(source, /postgres-store-domains\/workers\.ts/)
  assert.match(source, /postgres-domains\/workflows\.ts/)

  for (const file of sourceFiles(join(cloudRoot, 'postgres-domains'))) {
    const relativePath = relative(root, file)
    const lineCount = readFileSync(file, 'utf8').split('\n').length
    assert.ok(lineCount <= 250, `${relativePath} has ${lineCount} lines; Postgres domain mappers should stay narrow`)
  }
})

test('session service delegates command payload parsing to command service module', () => {
  const source = readFileSync(join(cloudRoot, 'session-service.ts'), 'utf8')
  assert.doesNotMatch(source, /function normalize(Prompt|QuestionReply|QuestionReject|Permission)Payload\(/)
  assert.match(source, /services\/session-command-service\.ts/)
})

test('cloud route and service modules stay behind store and runtime boundaries', () => {
  const checkedRoots = [
    join(cloudRoot, 'http-routes'),
    join(cloudRoot, 'services'),
  ]
  for (const checkedRoot of checkedRoots) {
    for (const file of sourceFiles(checkedRoot)) {
      const relativePath = relative(root, file)
      const source = readFileSync(file, 'utf8')
      assert.doesNotMatch(source, /postgres-control-plane-store/, `${relativePath} must not import concrete Postgres stores`)
      assert.doesNotMatch(source, /@opencode-ai\/sdk/, `${relativePath} must not import OpenCode runtime surfaces`)
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
