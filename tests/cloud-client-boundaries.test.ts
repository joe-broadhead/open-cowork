import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

test('cloud client package boundary and desktop transport compatibility re-export stay documented', () => {
  const root = process.cwd()
  const packageJson = JSON.parse(readFileSync(join(root, 'packages/cloud-client/package.json'), 'utf8')) as {
    name?: string
    private?: boolean
    exports?: Record<string, unknown>
    files?: string[]
    sideEffects?: boolean
    dependencies?: Record<string, string>
  }
  const sharedPackageJson = JSON.parse(readFileSync(join(root, 'packages/shared/package.json'), 'utf8')) as {
    name?: string
    private?: boolean
    exports?: Record<string, unknown>
    files?: string[]
    sideEffects?: boolean
  }
  const clientSource = clientSources(join(root, 'packages/cloud-client/src')).join('\n')
  const desktopTransport = readFileSync(join(root, 'apps/desktop/src/main/cloud/transport-adapter.ts'), 'utf8')
  const readme = readFileSync(join(root, 'packages/cloud-client/README.md'), 'utf8')
  const docs = readFileSync(join(root, 'docs/cloud-client.md'), 'utf8')

  assert.equal(packageJson.name, '@open-cowork/cloud-client')
  assert.equal(packageJson.private, false)
  assert.equal(packageJson.sideEffects, false)
  assert.deepEqual(packageJson.files, ['dist', 'README.md'])
  const publicExports = [
    '.',
    './adapter',
    './domains/artifacts',
    './domains/billing',
    './domains/byok',
    './domains/capabilities',
    './domains/channels',
    './domains/config',
    './domains/identity',
    './domains/sessions',
    './domains/settings',
    './domains/threads',
    './domains/transport',
    './domains/workflows',
    './package.json',
  ].sort()
  assert.deepEqual(Object.keys(packageJson.exports || {}).sort(), publicExports)
  assert.equal(sharedPackageJson.name, '@open-cowork/shared')
  assert.equal(sharedPackageJson.private, false)
  assert.deepEqual(Object.keys(sharedPackageJson.exports || {}).sort(), ['.', './package.json'])
  assert.deepEqual(sharedPackageJson.files, ['dist'])
  assert.equal(sharedPackageJson.sideEffects, false)
  for (const dependencyName of Object.keys(packageJson.dependencies || {})) {
    if (!dependencyName.startsWith('@open-cowork/')) continue
    const dependencyPackage = JSON.parse(readFileSync(join(root, `packages/${dependencyName.replace('@open-cowork/', '')}/package.json`), 'utf8')) as { private?: boolean }
    assert.equal(dependencyPackage.private, false, `${dependencyName} must be publishable because cloud-client is public`)
  }
  assert.doesNotMatch(clientSource, /apps\/desktop|control-plane-store|session-service|@opencode-ai\/sdk/)
  assert.equal(desktopTransport.trim(), "export * from '../../../../../packages/cloud-client/src/index.ts'")
  for (const document of [readme, docs]) {
    assert.match(document, /supported typed .*client|workspace\/source\s+package/i)
    assert.match(document, /not an independently versioned public npm SDK|standalone SDK publishing/i)
    assert.match(document, /pre-1\.0|SemVer|semver/i)
    assert.match(document, /requestTimeoutMs/i)
    assert.match(document, /signal/i)
    assert.match(document, /does not retry automatically/i)
    assert.match(document, /CloudTransportError|error taxonomy/i)
    assert.match(document, /service-token|Gateway/i)
    assert.match(document, /operator/i)
    assert.match(document, /publish checklist|release checklist/i)
  }
})

test('first-party client surfaces stay on public cloud-client/shared boundaries', () => {
  const root = process.cwd()
  const clientRoots = [
    'apps/desktop/src/preload',
    'apps/desktop/src/renderer',
    'apps/gateway/src',
    'apps/website/src',
    'packages/cloud-client/src',
  ]
  const forbidden = [
    /@opencode-ai\/sdk/,
    /apps\/desktop\/src\/main\/cloud\/(?:app|http-server|session-service|control-plane-store|postgres-control-plane-store|in-memory-control-plane-store|runtime-adapter|opencode-runtime-adapter|secret-adapter|object-store|worker)/,
    /\.\.\/.*main\/cloud\/(?:app|http-server|session-service|control-plane-store|postgres-control-plane-store|in-memory-control-plane-store|runtime-adapter|opencode-runtime-adapter|secret-adapter|object-store|worker)/,
    /postgres-control-plane-store/,
    /in-memory-control-plane-store/,
    /control-plane-store/,
    /session-service/,
    /opencode-runtime-adapter/,
  ]

  for (const clientRoot of clientRoots) {
    for (const filePath of sourceFiles(join(root, clientRoot))) {
      if (filePath.endsWith('.test.ts') || filePath.endsWith('.test.tsx')) continue
      const source = readFileSync(filePath, 'utf8')
      for (const pattern of forbidden) {
        assert.doesNotMatch(
          source,
          pattern,
          `${relative(root, filePath)} imports server/runtime internals instead of @open-cowork/cloud-client or @open-cowork/shared`,
        )
      }
    }
  }
})

test('cloud API token policy is extracted from the monolithic session service', () => {
  const root = process.cwd()
  const policySource = readFileSync(join(root, 'apps/desktop/src/main/cloud/services/api-token-policy.ts'), 'utf8')
  const sessionService = readFileSync(join(root, 'apps/desktop/src/main/cloud/session-service.ts'), 'utf8')

  assert.match(policySource, /export function normalizeApiTokenScopes/)
  assert.match(policySource, /export function normalizeApiTokenExpiresAt/)
  assert.match(policySource, /export function enforceApiTokenScopePolicy/)
  assert.doesNotMatch(sessionService, /function normalizeApiTokenScopes/)
  assert.doesNotMatch(sessionService, /function normalizeApiTokenExpiresAt/)
  assert.doesNotMatch(sessionService, /function enforceApiTokenScopePolicy/)
})

function clientSources(directory: string): string[] {
  const sources: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) sources.push(...clientSources(path))
    else if (entry.isFile() && entry.name.endsWith('.ts')) sources.push(readFileSync(path, 'utf8'))
  }
  return sources
}

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist'].includes(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.isFile() && ['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(extname(path))) files.push(path)
  }
  return files
}
