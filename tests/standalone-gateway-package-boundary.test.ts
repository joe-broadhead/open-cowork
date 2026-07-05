import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const root = process.cwd()
const generatedDirectories = new Set(['dist', 'node_modules', 'coverage'])

test('standalone gateway is a separate execution authority package', () => {
  const standalonePackage = readPackage('apps/standalone-gateway/package.json')
  assert.equal(standalonePackage.name, '@open-cowork/standalone-gateway')
  assert.equal(standalonePackage.private, true)
  assert.equal(standalonePackage.dependencies?.['@opencode-ai/sdk'], '1.15.5')
  assert.equal(standalonePackage.dependencies?.pg, '^8.22.0')
  assert.equal(standalonePackage.dependencies?.['@open-cowork/cloud-client'], undefined)

  const cloudGatewayPackage = readPackage('apps/gateway/package.json')
  assert.equal(cloudGatewayPackage.dependencies?.['@opencode-ai/sdk'], undefined)
  assert.equal(cloudGatewayPackage.dependencies?.['opencode-ai'], undefined)
  assert.equal(cloudGatewayPackage.dependencies?.pg, undefined)
})

test('standalone SDK and Postgres access stays in named adapter modules', () => {
  const sdkImportPaths: string[] = []
  const pgImportPaths: string[] = []
  for (const filePath of sourceFiles(join(root, 'apps/standalone-gateway/src'))) {
    const relativePath = relative(root, filePath)
    const source = readFileSync(filePath, 'utf8')
    if (/@opencode-ai\/sdk/.test(source)) sdkImportPaths.push(relativePath)
    if (/\bimport\s*\(\s*['"]pg['"]\s*\)|\bfrom\s+['"]pg['"]/.test(source)) pgImportPaths.push(relativePath)
  }
  assert.deepEqual(sdkImportPaths, ['apps/standalone-gateway/src/opencode.ts'])
  assert.deepEqual(pgImportPaths, ['apps/standalone-gateway/src/postgres-repository.ts'])
})

test('cloud channel gateway still fails closed for standalone product mode', () => {
  const deploymentTemplate = readFileSync(join(root, 'helm/open-cowork-gateway/templates/deployment.yaml'), 'utf8')
  assert.match(deploymentTemplate, /productMode/)
  assert.match(deploymentTemplate, /cloud_channel/)
  assert.match(deploymentTemplate, /standalone gateway chart\/app/)

  const appConfig = readFileSync(join(root, 'packages/shared/src/app-config.ts'), 'utf8')
  assert.match(appConfig, /assertCloudChannelGatewayProductMode/)
  assert.match(appConfig, /assertStandaloneGatewayProductMode/)
})

function readPackage(path: string): {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
} {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as {
    name?: string
    private?: boolean
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
}

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (generatedDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (entry.isFile() && ['.ts', '.tsx', '.js', '.mjs'].includes(extname(path))) files.push(path)
  }
  return files
}
