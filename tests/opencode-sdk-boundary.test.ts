import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const root = process.cwd()
const boundaryDoc = readFileSync(join(root, 'docs/opencode-sdk-v2-boundary.md'), 'utf8')

const ignoredDirectories = new Set([
  '.git',
  '.open-cowork-test',
  'coverage',
  'dist',
  'dist-browser',
  'node_modules',
  'release',
  'site',
  '__tests__',
])

const sourceRoots = [
  'apps/desktop/src/main',
  'apps/desktop/src/preload',
  'packages/app/src',
  'apps/channel-gateway/src',
  'apps/standalone-gateway/src',
  'packages',
  // Durable Gateway product partition (audit 2026-07-18) — must stay on V2 entry.
  'products/gateway/src',
] as const

const runtimeAuthoritySourceRoots = [
  'apps/desktop/src/main',
  'apps/standalone-gateway/src',
  'packages/cloud-server/src',
  'packages/runtime-host/src',
] as const

const sdkImportPattern = /\bfrom\s+['"]@opencode-ai\/sdk(?:\/v2(?:\/server)?)?['"]|import\s*\(\s*['"]@opencode-ai\/sdk(?:\/v2(?:\/server)?)?['"]\s*\)/

const allowedSdkImportPaths = new Set([
  'packages/cloud-server/src/app.ts',
  'packages/cloud-server/src/byok-runtime-config.ts',
  'packages/cloud-server/src/opencode-runtime-adapter.ts',
  'packages/cloud-server/src/runtime-adapter.ts',
  'packages/cloud-server/src/worker-scoped-runtime-adapter.ts',
  'apps/desktop/src/main/durable-session-events.ts',
  'apps/desktop/src/main/event-subscriptions.ts',
  'apps/desktop/src/main/events.ts',
  'apps/desktop/src/main/ipc/context.ts',
  'apps/desktop/src/main/ipc/provider-handlers.ts',
  // question-normalization moved to runtime-host (JOE-842) — no SDK import
  'apps/desktop/src/main/runtime-mcp-status-polling.ts',
  'apps/standalone-gateway/src/opencode.ts',
  'packages/runtime-host/src/agent-config.ts',
  'packages/runtime-host/src/agent-prompts.ts',
  'packages/runtime-host/src/opencode-adapter.ts',
  'packages/runtime-host/src/opencode-v2.ts',
  'packages/runtime-host/src/permission-config.ts',
  'packages/runtime-host/src/provider-utils.ts',
  'packages/runtime-host/src/runtime-config-builder.ts',
  'packages/runtime-host/src/runtime-managed-server-core.ts',
  'packages/runtime-host/src/runtime-managed-server.ts',
  'packages/runtime-host/src/runtime-node-managed-server.ts',
  'packages/runtime-host/src/runtime-skill-verifier.ts',
  'packages/runtime-host/src/runtime-state.ts',
  'packages/runtime-host/src/runtime.ts',
  'packages/runtime-host/src/session-history-loader.ts',
  // products/gateway durable OpenCode client (classic residual session APIs on V2 client)
  'products/gateway/src/opencode-client.ts',
  'products/gateway/src/gateway-runtime.ts',
  'products/gateway/src/channel-sync.ts',
  'products/gateway/src/opencode-session-runtime.ts',
  'products/gateway/src/live.ts',
  'products/gateway/src/heartbeat.ts',
  'products/gateway/src/scheduler.ts',
  'products/gateway/src/observability.ts',
])

test('OpenCode SDK imports stay inside documented runtime boundary modules', () => {
  const seenSdkImports = new Set<string>()
  for (const sourceRoot of sourceRoots) {
    for (const filePath of sourceFiles(join(root, sourceRoot))) {
      const relativePath = relative(root, filePath)
      const source = readFileSync(filePath, 'utf8')
      if (!sdkImportPattern.test(source)) continue
      seenSdkImports.add(relativePath)
      assert.equal(
        allowedSdkImportPaths.has(relativePath),
        true,
        `${relativePath} imports @opencode-ai/sdk outside the documented runtime boundary`,
      )
    }
  }

  for (const allowedPath of allowedSdkImportPaths) {
    assert.equal(
      seenSdkImports.has(allowedPath),
      true,
      `${allowedPath} is documented as an SDK boundary file but no longer imports the SDK`,
    )
    assert.match(
      boundaryDoc,
      new RegExp(`\`${escapeRegex(allowedPath)}\``),
      `${allowedPath} must be listed in docs/opencode-sdk-v2-boundary.md`,
    )
  }
})

test('only runtime authority packages declare OpenCode runtime dependencies', () => {
  const opencodeManifests: string[] = []
  for (const manifestPath of packageManifests(root)) {
    const relativePath = relative(root, manifestPath)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    const dependencySets = [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.peerDependencies,
      manifest.optionalDependencies,
    ]
    const declaresOpencode = dependencySets.some((dependencies) => dependencies?.['@opencode-ai/sdk'] || dependencies?.['opencode-ai'])
    if (declaresOpencode) opencodeManifests.push(relativePath)
  }
  assert.deepEqual(opencodeManifests.sort(), [
    'apps/desktop/package.json',
    'apps/standalone-gateway/package.json',
    'packages/cloud-server/package.json',
    'packages/runtime-host/package.json',
    // Durable Gateway product partition coordinates OpenCode sessions via MCP/CLI
    // (products/gateway); not Desktop Electron runtime-host.
    'products/gateway/package.json',
  ])
})

test('native-v2-covered capabilities do not regress to classic client methods', () => {
  const forbidden = /\b(?:client|c|options\.client|result\.client)\.(?:session\.(?:create|get|messages|promptAsync|abort|status|children|revert|unrevert)|event\.subscribe|question\.(?:list|reply|reject)|permission\.(?:list|reply|reject)|provider\.(?:list|auth)|auth\.(?:set|remove)|command\.list|app\.agents|file\.list|find\.files)\s*\(/g
  const violations: string[] = []
  for (const sourceRoot of runtimeAuthoritySourceRoots) {
    for (const filePath of sourceFiles(join(root, sourceRoot))) {
      const relativePath = relative(root, filePath)
      const source = stripComments(readFileSync(filePath, 'utf8'))
      for (const match of source.matchAll(forbidden)) {
        violations.push(`${relativePath}: ${match[0].trim()}`)
      }
    }
  }
  assert.deepEqual(violations, [], `covered capabilities must use client.v2.*:\n${violations.join('\n')}`)
})

/**
 * JOE-845 classic SDK gap allowlist (OpenCode pin-gated).
 *
 * Full burn-down is Won't Do on OpenCode 1.18.1 — generated V2 clients lack
 * working routes for these methods. Do NOT invent V2 wrappers.
 *
 * Ratchet rules:
 * - Exact file:method → call count. Silent expansion fails this test.
 * - Every method must appear in docs/opencode-sdk-v2-boundary.md and the residual
 *   registry in docs/opencode-classic-sdk-burndown.md.
 * - On each OpenCode bump: prove a real V2 route, switch the call site, then
 *   remove the row + update the burndown registry in the same commit.
 */
const classicSdkGapAllowlist = new Map<string, number>([
  // MCP group — no V2 MCP surface on 1.18.1
  ['apps/desktop/src/main/events.ts:mcp.status', 1],
  ['apps/desktop/src/main/ipc-handlers.ts:mcp.auth.authenticate', 1],
  ['apps/desktop/src/main/ipc/catalog-handlers.ts:mcp.auth.authenticate', 1],
  ['apps/desktop/src/main/ipc/catalog-handlers.ts:mcp.auth.remove', 1],
  ['apps/desktop/src/main/ipc/catalog-handlers.ts:mcp.connect', 1],
  ['apps/desktop/src/main/ipc/catalog-handlers.ts:mcp.disconnect', 1],
  // Explorer gaps — V2 fs.read lacks wildcard; status/symbols/text missing
  ['apps/desktop/src/main/ipc/explorer-handlers.ts:file.read', 1],
  ['apps/desktop/src/main/ipc/explorer-handlers.ts:file.status', 1],
  ['apps/desktop/src/main/ipc/explorer-handlers.ts:find.symbols', 1],
  ['apps/desktop/src/main/ipc/explorer-handlers.ts:find.text', 1],
  // Session mutations without working native V2 routes
  ['apps/desktop/src/main/ipc/session-action-handlers.ts:session.delete', 1],
  ['apps/desktop/src/main/ipc/session-action-handlers.ts:session.diff', 1],
  ['apps/desktop/src/main/ipc/session-action-handlers.ts:session.share', 1],
  ['apps/desktop/src/main/ipc/session-action-handlers.ts:session.summarize', 1], // v2.session.compact → OperationUnavailable
  ['apps/desktop/src/main/ipc/session-action-handlers.ts:session.unshare', 1],
  ['apps/desktop/src/main/ipc/session-action-handlers.ts:session.update', 1],
  ['apps/desktop/src/main/ipc/session-command-handlers.ts:session.command', 1],
  ['apps/desktop/src/main/ipc/session-command-handlers.ts:session.todo', 1],
  ['apps/desktop/src/main/ipc/session-handlers.ts:session.fork', 1],
  ['apps/desktop/src/main/runtime-mcp-recovery.ts:mcp.connect', 2],
  // Runtime tool catalog — V2 lists agents/commands/skills, not effective tools
  ['packages/runtime-host/src/runtime-tools.ts:tool.list', 1],
  ['packages/runtime-host/src/session-history-loader.ts:session.diff', 1],
  ['packages/runtime-host/src/session-history-loader.ts:session.todo', 2],
  ['packages/runtime-host/src/session-history-loader.ts:session.update', 1],
])

/** Distinct classic methods represented in the allowlist (JOE-845 residual set). */
const classicSdkGapMethods = new Set(
  [...classicSdkGapAllowlist.keys()].map((key) => key.slice(key.indexOf(':') + 1)),
)

/** Pin version residual burn-down is blocked on. Update when OpenCode is bumped. */
const OPENCODE_CLASSIC_GAP_PIN = '1.18.1'

test('classic SDK calls are limited to documented native-V2 capability gaps', () => {
  const classicCall = /\b(?:client|options\.client)\.((?:session|mcp|tool|file|find)\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g
  const actual = new Map<string, number>()
  for (const sourceRoot of runtimeAuthoritySourceRoots) {
    for (const filePath of sourceFiles(join(root, sourceRoot))) {
      const relativePath = relative(root, filePath)
      const source = stripComments(readFileSync(filePath, 'utf8'))
      for (const match of source.matchAll(classicCall)) {
        const key = `${relativePath}:${match[1]}`
        actual.set(key, (actual.get(key) || 0) + 1)
      }
    }
  }

  assert.deepEqual(
    [...actual].sort(([a], [b]) => a.localeCompare(b)),
    [...classicSdkGapAllowlist].sort(([a], [b]) => a.localeCompare(b)),
    'classic calls must have an exact file-and-count allowlist entry; prefer client.v2.* whenever native V2 supports the capability',
  )
  for (const key of classicSdkGapAllowlist.keys()) {
    const method = key.slice(key.indexOf(':') + 1)
    assert.match(boundaryDoc, new RegExp(`\`${escapeRegex(method)}\``), `${method} must be documented as a native-V2 gap`)
  }
})

test('JOE-845: classic gap residual runway is documented and pin-gated', () => {
  const burndownDoc = readFileSync(join(root, 'docs/opencode-classic-sdk-burndown.md'), 'utf8')
  assert.match(burndownDoc, /Won't Do \(full burn-down\) while pinned to OpenCode 1\.18\.1/)
  assert.match(burndownDoc, new RegExp(escapeRegex(OPENCODE_CLASSIC_GAP_PIN)))
  assert.match(boundaryDoc, /opencode-classic-sdk-burndown\.md/)

  // Every allowlisted method must appear as a residual registry row.
  for (const method of classicSdkGapMethods) {
    assert.match(
      burndownDoc,
      new RegExp(`\`${escapeRegex(method)}\``),
      `${method} must be tracked in docs/opencode-classic-sdk-burndown.md residual registry`,
    )
  }

  // Runtime authority packages must stay on the residual pin until a real bump.
  // Only desktop + runtime-host ship the opencode-ai binary package; cloud and
  // standalone depend on the SDK client alone.
  for (const manifestPath of [
    'apps/desktop/package.json',
    'apps/standalone-gateway/package.json',
    'packages/cloud-server/package.json',
    'packages/runtime-host/package.json',
  ]) {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    assert.equal(
      manifest.dependencies?.['@opencode-ai/sdk'],
      OPENCODE_CLASSIC_GAP_PIN,
      `${manifestPath} @opencode-ai/sdk must match classic-gap pin ${OPENCODE_CLASSIC_GAP_PIN}`,
    )
  }
  for (const manifestPath of ['apps/desktop/package.json', 'packages/runtime-host/package.json']) {
    const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    assert.equal(
      manifest.dependencies?.['opencode-ai'],
      OPENCODE_CLASSIC_GAP_PIN,
      `${manifestPath} opencode-ai must match classic-gap pin ${OPENCODE_CLASSIC_GAP_PIN}`,
    )
  }

  // Ratchet: residual method count cannot shrink without a corresponding doc burn
  // note, and must not grow silently (allowlist equality already enforces growth).
  assert.equal(classicSdkGapMethods.size, 19, 'expected 19 distinct classic gap methods on OpenCode 1.18.1')
})

function stripComments(source: string) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of safeReadDirectory(directory)) {
    if (ignoredDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.isFile() && sourceExtension(path)) files.push(path)
  }
  return files
}

function packageManifests(directory: string): string[] {
  const manifests: string[] = []
  for (const entry of safeReadDirectory(directory)) {
    if (ignoredDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) manifests.push(...packageManifests(path))
    else if (entry.isFile() && entry.name === 'package.json') manifests.push(path)
  }
  return manifests
}

function safeReadDirectory(directory: string) {
  try {
    return readdirSync(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return []
    throw error
  }
}

function sourceExtension(path: string) {
  return ['.ts', '.tsx', '.js', '.jsx', '.mjs'].includes(extname(path))
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
