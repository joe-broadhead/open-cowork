import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

type PackageJson = {
  dependencies?: Record<string, string>
  version?: string
}

type MermaidManifest = {
  package?: string
  packageVersion?: string
  packageDependency?: string
  source?: string
  bundle?: string
  generatedBy?: string
  bundler?: string
  bundlerVersion?: string
  bytes?: number
  sha256?: string
}

test('docs Mermaid vendor manifest matches the locked workspace dependency', () => {
  const rendererPackage = readJson<PackageJson>('packages/app/package.json')
  const mermaidPackage = readJson<PackageJson>('packages/app/node_modules/mermaid/package.json')
  const esbuildPackage = readJson<PackageJson>('node_modules/esbuild/package.json')
  const manifest = readJson<MermaidManifest>('docs/javascripts/vendor/mermaid-manifest.json')
  const bundle = readFileSync(new URL('../docs/javascripts/vendor/mermaid.min.js', import.meta.url))
  const source = bundle.toString('utf8')

  assert.equal(manifest.package, 'mermaid')
  assert.equal(manifest.packageVersion, mermaidPackage.version)
  assert.equal(manifest.packageDependency, rendererPackage.dependencies?.mermaid)
  assert.equal(manifest.source, 'packages/app/node_modules/mermaid/dist/mermaid.esm.min.mjs')
  assert.equal(manifest.bundle, 'docs/javascripts/vendor/mermaid.min.js')
  assert.equal(manifest.generatedBy, 'node scripts/build-docs-mermaid-vendor.mjs')
  assert.equal(manifest.bundler, 'esbuild')
  assert.equal(manifest.bundlerVersion, esbuildPackage.version)
  assert.equal(manifest.bytes, bundle.byteLength)
  assert.equal(manifest.sha256, createHash('sha256').update(bundle).digest('hex'))
  assert.equal(source.includes(String(mermaidPackage.version)), true)
  assert.equal(source.includes('11.14.0'), false)
})

test('docs Mermaid vendor check passes when the generated bundle matches the manifest', () => {
  const mermaidPackage = readJson<PackageJson>('packages/app/node_modules/mermaid/package.json')
  const result = spawnSync(process.execPath, ['scripts/build-docs-mermaid-vendor.mjs', '--check'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.includes(`matches mermaid ${String(mermaidPackage.version)}`), true, result.stdout)
})

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')) as T
}
