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
    publishConfig?: unknown
    dependencies?: Record<string, string>
  }
  const sharedPackageJson = JSON.parse(readFileSync(join(root, 'packages/shared/package.json'), 'utf8')) as {
    name?: string
    private?: boolean
    exports?: Record<string, unknown>
    files?: string[]
    sideEffects?: boolean
    publishConfig?: unknown
  }
  const clientSource = clientSources(join(root, 'packages/cloud-client/src')).join('\n')
  const desktopTransport = readFileSync(join(root, 'packages/cloud-server/src/transport-adapter.ts'), 'utf8')
  const readme = readFileSync(join(root, 'packages/cloud-client/README.md'), 'utf8')
  const docs = readFileSync(join(root, 'docs/cloud-client.md'), 'utf8')

  assert.equal(packageJson.name, '@open-cowork/cloud-client')
  assert.equal(packageJson.private, true)
  assert.equal(packageJson.sideEffects, false)
  assert.equal(packageJson.publishConfig, undefined)
  assert.deepEqual(packageJson.files, ['dist', 'README.md'])
  const documentedExports = [
    '.',
    './adapter',
    './domains/artifacts',
    './domains/billing',
    './domains/byok',
    './domains/capabilities',
    './domains/channels',
    './domains/config',
    './domains/identity',
    './domains/launchpad',
    './domains/sessions',
    './domains/settings',
    './domains/threads',
    './domains/transport',
    './domains/workflows',
    './package.json',
  ].sort()
  assert.deepEqual(Object.keys(packageJson.exports || {}).sort(), documentedExports)
  assert.equal(sharedPackageJson.name, '@open-cowork/shared')
  assert.equal(sharedPackageJson.private, true)
  assert.equal(sharedPackageJson.publishConfig, undefined)
  // '.' is the browser-safe barrel; './node' is the Node-only runtime substrate
  // (node:fs/node:crypto helpers) shared by the Electron main process and the cloud
  // server — it must never be imported from a browser bundle.
  assert.deepEqual(Object.keys(sharedPackageJson.exports || {}).sort(), ['.', './node', './package.json'])
  assert.deepEqual(sharedPackageJson.files, ['dist'])
  assert.equal(sharedPackageJson.sideEffects, false)
  for (const dependencyName of Object.keys(packageJson.dependencies || {})) {
    if (!dependencyName.startsWith('@open-cowork/')) continue
    const dependencyPackage = JSON.parse(readFileSync(join(root, `packages/${dependencyName.replace('@open-cowork/', '')}/package.json`), 'utf8')) as { private?: boolean }
    assert.equal(dependencyPackage.private, true, `${dependencyName} must remain a private workspace package until standalone SDK publication is explicit`)
  }
  assert.doesNotMatch(clientSource, /apps\/desktop|control-plane-store|session-service|@opencode-ai\/sdk/)
  assert.equal(desktopTransport.trim(), "export * from '@open-cowork/cloud-client'")
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
    'packages/app/src',
    'apps/gateway/src',
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
  const policySource = readFileSync(join(root, 'packages/cloud-server/src/services/api-token-policy.ts'), 'utf8')
  const sessionService = readFileSync(join(root, 'packages/cloud-server/src/session-service.ts'), 'utf8')

  assert.match(policySource, /export function normalizeApiTokenScopes/)
  assert.match(policySource, /export function normalizeApiTokenExpiresAt/)
  assert.match(policySource, /export function enforceApiTokenScopePolicy/)
  assert.doesNotMatch(sessionService, /function normalizeApiTokenScopes/)
  assert.doesNotMatch(sessionService, /function normalizeApiTokenExpiresAt/)
  assert.doesNotMatch(sessionService, /function enforceApiTokenScopePolicy/)
})

test('cloud client adapter delegates concrete operations to domain clients', () => {
  const root = process.cwd()
  const adapter = readFileSync(join(root, 'packages/cloud-client/src/adapter.ts'), 'utf8')
  const contracts = readFileSync(join(root, 'packages/cloud-client/src/contracts.ts'), 'utf8')
  const expectedFactories: Record<string, string> = {
    artifacts: 'createCloudArtifactsClient',
    billing: 'createCloudBillingClient',
    byok: 'createCloudByokClient',
    capabilities: 'createCloudCapabilitiesClient',
    channels: 'createCloudChannelsClient',
    config: 'createCloudConfigClient',
    identity: 'createCloudIdentityClient',
    launchpad: 'createCloudLaunchpadClient',
    sessions: 'createCloudSessionsClient',
    settings: 'createCloudSettingsClient',
    threads: 'createCloudThreadsClient',
    transport: 'createCloudTransportEventClient',
    workflows: 'createCloudWorkflowsClient',
  }

  for (const [domain, factory] of Object.entries(expectedFactories)) {
    const source = readFileSync(join(root, `packages/cloud-client/src/domains/${domain}.ts`), 'utf8')
    assert.equal(source.includes(factory), true, `${domain} must expose a concrete client factory`)
  }

  for (const route of [
    '/api/sessions',
    '/api/channels',
    '/api/workflows',
    '/api/threads',
    '/api/capabilities',
    '/api/launchpad',
    '/api/settings',
    '/api/byok',
    '/api/billing',
    '/api/admin',
  ]) {
    assert.doesNotMatch(adapter, new RegExp(route.replaceAll('/', '\\\\/')), `adapter should not own concrete ${route} routes`)
  }
  assert.match(adapter, /createCloudSessionsClient\(domainContext\)/)
  assert.match(adapter, /createCloudChannelsClient\(\{/)
  assert.match(adapter, /createCloudTransportEventClient\(sseContext\)/)
  assert.equal(adapter.split('\n').length < 400, true, 'adapter must remain a thin compatibility wrapper')
  assert.match(adapter, /export type \* from '\.\/contracts\.js'/)
  assert.doesNotMatch(adapter, /export type CloudClientSessionStatus/)
  assert.match(contracts, /export type CloudTransportAdapter = \{/)
})

test('cloud session service delegates channel behavior to the extracted domain service', () => {
  const root = process.cwd()
  const sessionService = readFileSync(join(root, 'packages/cloud-server/src/session-service.ts'), 'utf8')
  const channelDomainService = readFileSync(join(root, 'packages/cloud-server/src/services/channel-domain-service.ts'), 'utf8')
  const channelContext = readFileSync(join(root, 'packages/cloud-server/src/services/channel-domain-context.ts'), 'utf8')
  const channelSessionActions = readFileSync(join(root, 'packages/cloud-server/src/services/channel-session-actions.ts'), 'utf8')
  const channelInteractionActions = readFileSync(join(root, 'packages/cloud-server/src/services/channel-interaction-actions.ts'), 'utf8')

  assert.match(channelDomainService, /export class CloudChannelDomainService/)
  assert.match(channelDomainService, /return sessionActions\.bindChannelSession\(this\.options, principal, input\)/)
  assert.match(channelSessionActions, /export async function bindChannelSession\(/)
  assert.match(channelContext, /export async function requireChannelActor\(/)
  assert.match(channelInteractionActions, /assertRemoteInteractionAllowed\(principal/)
  assert.match(sessionService, /private readonly channelDomain: CloudChannelDomainService/)
  assert.match(sessionService, /new CloudChannelDomainService\(/)
  assert.match(sessionService, /return this\.channelDomain\.bindChannelSession\(principal, input\)/)
  assert.match(sessionService, /return this\.channelDomain\.resolveChannelInteraction\(principal, input\)/)
  assert.doesNotMatch(sessionService, /function channelRoleCanPrompt/)
  assert.doesNotMatch(sessionService, /function principalCanManageChannels/)
  assert.doesNotMatch(sessionService, /private async requireChannelActor/)
  assert.doesNotMatch(sessionService, /findChannelSessionBindingByThread\(\{/)
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
