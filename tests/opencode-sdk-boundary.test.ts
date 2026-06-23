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
  'node_modules',
  'release',
  'site',
])

const sourceRoots = [
  'apps/desktop/src/main',
  'apps/desktop/src/preload',
  'apps/desktop/src/renderer',
  'apps/gateway/src',
  'apps/standalone-gateway/src',
  'apps/website/src',
  'packages',
] as const

const sdkImportPattern = /\bfrom\s+['"]@opencode-ai\/sdk(?:\/v2(?:\/server)?)?['"]|import\s*\(\s*['"]@opencode-ai\/sdk(?:\/v2(?:\/server)?)?['"]\s*\)/

const allowedSdkImportPaths = new Set([
  'apps/desktop/src/main/agent-config.ts',
  'apps/desktop/src/main/agent-prompts.ts',
  'apps/desktop/src/main/cloud/app.ts',
  'apps/desktop/src/main/cloud/byok-runtime-config.ts',
  'apps/desktop/src/main/cloud/opencode-runtime-adapter.ts',
  'apps/desktop/src/main/cloud/worker-scoped-runtime-adapter.ts',
  'apps/desktop/src/main/event-subscriptions.ts',
  'apps/desktop/src/main/events.ts',
  'apps/desktop/src/main/ipc/context.ts',
  'apps/desktop/src/main/permission-config.ts',
  'apps/desktop/src/main/question-normalization.ts',
  'apps/desktop/src/main/runtime-config-builder.ts',
  'apps/desktop/src/main/runtime-managed-server.ts',
  'apps/desktop/src/main/runtime-mcp-status-polling.ts',
  'apps/desktop/src/main/runtime-node-managed-server.ts',
  'apps/desktop/src/main/runtime-skill-verifier.ts',
  'apps/desktop/src/main/runtime-state.ts',
  'apps/desktop/src/main/runtime.ts',
  'apps/desktop/src/main/session-history-loader.ts',
  'apps/standalone-gateway/src/opencode.ts',
  'packages/runtime-host/src/opencode-adapter.ts',
  'packages/runtime-host/src/runtime-managed-server-core.ts',
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
    'packages/runtime-host/package.json',
  ])
})

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
