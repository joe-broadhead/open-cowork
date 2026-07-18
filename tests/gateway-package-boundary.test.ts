import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const gatewayPackages = [
  'apps/channel-gateway',
  'packages/gateway-channel',
  'packages/gateway-provider-cli',
  'packages/gateway-provider-discord',
  'packages/gateway-provider-email',
  'packages/gateway-provider-signal',
  'packages/gateway-provider-slack',
  'packages/gateway-provider-telegram',
  'packages/gateway-provider-webhook',
  'packages/gateway-provider-whatsapp',
  'packages/gateway-testing',
] as const

const generatedDirectories = new Set(['dist', 'node_modules', 'coverage'])

const forbiddenImportPatterns = [
  /@opencode-ai\/sdk/,
  /@opencode-gateway\//,
  /packages\/opencode/,
  /packages\/db/,
  /control-plane-store/,
  /postgres-control-plane-store/,
  /node:child_process/,
  /from ['"]child_process/,
  /from ['"]pg['"]/,
  /from ['"]drizzle-orm/,
]

test('gateway package names and imports stay inside channel-adapter boundaries', () => {
  for (const packageDir of gatewayPackages) {
    const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      name?: string
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    // Channel Gateway app package is @open-cowork/channel-gateway; shared channel
    // libs stay under @open-cowork/gateway-* (channel, provider-*, testing).
    assert.match(
      packageJson.name || '',
      /^@open-cowork\/(?:channel-gateway|gateway(?:-|$))/,
    )
    for (const dependencySet of [
      packageJson.dependencies,
      packageJson.devDependencies,
      packageJson.peerDependencies,
      packageJson.optionalDependencies,
    ]) {
      assert.equal(dependencySet?.['@opencode-ai/sdk'], undefined, `${packageDir} must not depend on @opencode-ai/sdk`)
      assert.equal(dependencySet?.['opencode-ai'], undefined, `${packageDir} must not depend on opencode-ai`)
      assert.equal(dependencySet?.pg, undefined, `${packageDir} must not depend on pg`)
      assert.equal(dependencySet?.['drizzle-orm'], undefined, `${packageDir} must not depend on drizzle-orm`)
    }

    for (const filePath of sourceFiles(packageDir)) {
      const contents = readFileSync(filePath, 'utf8')
      for (const pattern of forbiddenImportPatterns) {
        assert.doesNotMatch(contents, pattern, `${relative(process.cwd(), filePath)} must not match ${pattern}`)
      }
    }
  }
})

test('gateway package port excludes generated prototype metadata from source tree', () => {
  for (const packageDir of gatewayPackages) {
    for (const path of allFiles(packageDir)) {
      const localPath = relative(packageDir, path)
      assert.doesNotMatch(localPath, /\.tsbuildinfo$/)
    }
  }
})

function sourceFiles(root: string): string[] {
  return allFiles(join(root, 'src')).filter((path) => path.endsWith('.ts'))
}

function allFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (generatedDirectories.has(entry.name)) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...allFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}
