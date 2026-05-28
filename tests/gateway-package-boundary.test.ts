import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const gatewayPackages = [
  'apps/gateway',
  'packages/gateway-channel',
  'packages/gateway-provider-telegram',
  'packages/gateway-provider-webhook',
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
    const packageJson = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { name?: string }
    assert.match(packageJson.name || '', /^@open-cowork\/gateway(?:-|$)/)

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
  const entries = readdirSync(root)
  const files: string[] = []
  for (const entry of entries) {
    if (generatedDirectories.has(entry)) continue
    const path = join(root, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...allFiles(path))
    else files.push(path)
  }
  return files
}
