import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const root = process.cwd()

const ignoredDirectories = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
  'release',
  'site',
])

test('cloud control-plane facade files stay within documented compatibility budgets', () => {
  const budgets = [
    { path: 'packages/cloud-server/src/http-server.ts', maxLines: 1_930 },
    { path: 'packages/cloud-server/src/in-memory-control-plane-store.ts', maxLines: 1_620 },
    { path: 'packages/cloud-server/src/session-service.ts', maxLines: 1_205 },
  ]

  for (const budget of budgets) {
    const lines = lineCount(join(root, budget.path))
    assert.equal(
      lines <= budget.maxLines,
      true,
      `${budget.path} has ${lines} lines and must stay <= ${budget.maxLines}; extract a domain module instead of growing the facade`,
    )
  }
})

test('cloud route, service, client-domain, and gateway source modules stay bounded', () => {
  const budgets = [
    { directory: 'packages/cloud-server/src/http-routes', maxLines: 500 },
    { directory: 'packages/cloud-server/src/services', maxLines: 450 },
    { directory: 'packages/cloud-client/src/domains', maxLines: 120 },
    { directory: 'apps/gateway/src', maxLines: 900 },
  ]

  for (const budget of budgets) {
    for (const filePath of sourceFiles(join(root, budget.directory))) {
      if (filePath.endsWith('.test.ts')) continue
      const lines = lineCount(filePath)
      assert.equal(
        lines <= budget.maxLines,
        true,
        `${relative(root, filePath)} has ${lines} lines and must stay <= ${budget.maxLines}`,
      )
    }
  }
})

test('client surfaces do not import server-only cloud control-plane internals', () => {
  const clientRoots = [
    'apps/desktop/src/preload',
    'packages/app/src',
    'apps/gateway/src',
    'packages/cloud-client/src',
  ]
  const forbidden = [
    /@opencode-ai\/sdk/,
    /main\/cloud\/(?:app|http-server|session-service|control-plane-store|postgres-control-plane-store|in-memory-control-plane-store|runtime-adapter|opencode-runtime-adapter|secret-adapter|object-store|worker)(?:\.ts)?/,
    /(?:^|\/)apps\/desktop\/src\/main\/cloud\/(?:app|http-server|session-service|control-plane-store|postgres-control-plane-store|in-memory-control-plane-store|runtime-adapter|opencode-runtime-adapter|secret-adapter|object-store|worker)(?:\.ts)?/,
  ]

  for (const clientRoot of clientRoots) {
    for (const filePath of sourceFiles(join(root, clientRoot))) {
      const source = readFileSync(filePath, 'utf8')
      for (const pattern of forbidden) {
        assert.doesNotMatch(
          source,
          pattern,
          `${relative(root, filePath)} imports server-only Cloud internals instead of @open-cowork/cloud-client or shared contracts`,
        )
      }
    }
  }
})

test('cloud route and service modules do not reach below their domain seams', () => {
  const routeForbidden = [
    /@opencode-ai\/sdk/,
    /postgres-control-plane-store/,
    /in-memory-control-plane-store/,
    /opencode-runtime-adapter/,
    /worker-scoped-runtime-adapter/,
  ]
  const serviceForbidden = [
    /@opencode-ai\/sdk/,
    /from ['"]node:http['"]/,
    /from ['"]node:net['"]/,
    /postgres-control-plane-store/,
    /in-memory-control-plane-store/,
    /opencode-runtime-adapter/,
  ]

  for (const filePath of sourceFiles(join(root, 'packages/cloud-server/src/http-routes'))) {
    const source = readFileSync(filePath, 'utf8')
    for (const pattern of routeForbidden) {
      assert.doesNotMatch(source, pattern, `${relative(root, filePath)} bypasses service/store seams`)
    }
  }
  for (const filePath of sourceFiles(join(root, 'packages/cloud-server/src/services'))) {
    const source = readFileSync(filePath, 'utf8')
    for (const pattern of serviceForbidden) {
      assert.doesNotMatch(source, pattern, `${relative(root, filePath)} bypasses store/runtime seams`)
    }
  }
})

test('BYOK orchestration stays outside the CloudSessionService facade', () => {
  const sessionServiceSource = readFileSync(join(root, 'packages/cloud-server/src/session-service.ts'), 'utf8')
  const byokServiceSource = readFileSync(join(root, 'packages/cloud-server/src/services/byok-service.ts'), 'utf8')

  const extractedByokHelpers = [
    'private async assertByokProviderAllowed',
    'private assertByokKmsRefAllowed',
    'private requireByokSecrets',
    'function normalizeByokProviderIdForPolicy',
    'function principalCanManageByok',
  ]
  for (const helper of extractedByokHelpers) {
    assert.equal(
      sessionServiceSource.includes(helper),
      false,
      `CloudSessionService should delegate ${helper} to services/byok-service.ts`,
    )
  }

  const forbiddenByokServiceImports = [
    /http-server/,
    /postgres-control-plane-store/,
    /in-memory-control-plane-store/,
    /opencode-runtime-adapter/,
    /@opencode-ai\/sdk/,
  ]
  for (const pattern of forbiddenByokServiceImports) {
    assert.doesNotMatch(byokServiceSource, pattern, 'BYOK service should remain a policy/store seam, not an HTTP/runtime module')
  }
})

function lineCount(path: string) {
  return readFileSync(path, 'utf8').split(/\r?\n/).length
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
