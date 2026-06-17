import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { CLOUD_ELECTRON_SHIM_EXPORTS } from '../scripts/cloud-electron-shim-exports.mjs'

// The server→Electron boundary. The cloud image ships NO Electron: the cloud
// entrypoints reuse desktop config/runtime/control-plane modules, and the cloud
// build (scripts/build-cloud.mjs) replaces `import … from 'electron'` with an
// undefined-valued shim those modules guard at runtime. This test statically
// walks the cloud server's transitive source-import graph and proves two things
// the build alone can't guarantee at unit-test speed:
//   1. every Electron VALUE name the reachable graph imports is one the shim
//      stubs — importing an unstubbed name (e.g. `clipboard`) would ship
//      `undefined` to the cloud server;
//   2. the cloud-specific layer (main/cloud/**) never reaches for Electron
//      directly — the build would silently shim such an import, so only a test
//      can keep that layer host-process-free.

const root = process.cwd()
const CLOUD_ENTRYPOINTS = ['scripts/open-cowork-cloud.ts', 'scripts/open-cowork-cloud-migrate.ts']
const shim = new Set(CLOUD_ELECTRON_SHIM_EXPORTS)

/** Resolve a relative import specifier to an existing repo `.ts` source, or null for a package/bare/non-source import (a boundary we don't walk). */
function resolveLocalSource(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const target = resolve(dirname(fromFile), spec)
  const candidates = target.endsWith('.ts')
    ? [target]
    : target.endsWith('.js')
      ? [target.replace(/\.js$/, '.ts'), target]
      : [`${target}.ts`, join(target, 'index.ts')]
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null
}

/** Every module specifier referenced by a source file (import / export-from / dynamic import / side-effect import). */
function moduleSpecifiers(source: string): string[] {
  const specs: string[] = []
  for (const match of source.matchAll(/(?:^|[\s;}])(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]/g)) specs.push(match[1]!)
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(match[1]!)
  for (const match of source.matchAll(/(?:^|[\s;])import\s*['"]([^'"]+)['"]/g)) specs.push(match[1]!)
  return specs
}

/** The Electron VALUE binding names a source imports (type-only imports erase at compile and need no runtime shim; default/namespace imports are covered by the shim's default export). */
function electronValueImports(source: string): string[] {
  const names: string[] = []
  const pattern = /import\s+(type\s+)?(\{[^}]*\}|[A-Za-z_$][\w$]*(?:\s*,\s*\{[^}]*\})?|\*\s+as\s+[A-Za-z_$][\w$]*)\s+from\s*['"]electron['"]/g
  for (const match of source.matchAll(pattern)) {
    if (match[1]) continue // `import type { … } from 'electron'` — erased
    const clause = match[2]!
    const braces = clause.match(/\{([^}]*)\}/)
    if (!braces) continue // default or `* as ns` import — covered by the shim default export
    for (const raw of braces[1]!.split(',')) {
      const spec = raw.trim()
      if (!spec || spec.startsWith('type ')) continue // inline type-only specifier
      names.push(spec.split(/\s+as\s+/)[0]!.trim())
    }
  }
  return names
}

function walkCloudGraph() {
  const visited = new Set<string>()
  const electronImporters: Array<{ file: string, names: string[] }> = []
  const queue = CLOUD_ENTRYPOINTS.map((entry) => resolve(root, entry))
  while (queue.length > 0) {
    const file = queue.pop()!
    if (visited.has(file) || !existsSync(file)) continue
    visited.add(file)
    const source = readFileSync(file, 'utf8')
    const names = electronValueImports(source)
    if (names.length > 0 || /from\s*['"]electron['"]/.test(source)) electronImporters.push({ file: relative(root, file), names })
    for (const spec of moduleSpecifiers(source)) {
      const resolved = resolveLocalSource(file, spec)
      if (resolved && !visited.has(resolved)) queue.push(resolved)
    }
  }
  return { visited, electronImporters }
}

test('the cloud server bundle stubs every Electron value import its source graph reaches', () => {
  const { visited, electronImporters } = walkCloudGraph()

  // Non-vacuity: the cloud entrypoints reach the desktop control-plane / session /
  // runtime substrate, so a healthy walk visits a large graph. A tiny number would
  // mean the resolver silently stopped and the assertions below proved nothing.
  assert.ok(visited.size > 100, `cloud import-graph walk only reached ${visited.size} modules — the resolver likely broke`)

  const offenders: string[] = []
  for (const { file, names } of electronImporters) {
    for (const name of names) {
      if (!shim.has(name)) offenders.push(`${file}: import { ${name} } from 'electron'`)
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `cloud-reachable modules import Electron names the build shim does not stub (would be undefined in the cloud server). `
      + `Add them to scripts/cloud-electron-shim-exports.mjs or remove the import:\n${offenders.join('\n')}`,
  )
})

test('the cloud-specific layer (main/cloud/**) never imports Electron directly', () => {
  // The build would silently shim an Electron import here, so the cloud server
  // would still bundle — only this test keeps the cloud-specific code host-free.
  const cloudRoot = resolve(root, 'apps/desktop/src/main/cloud')
  const offenders: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts') && /from\s*['"]electron['"]/.test(readFileSync(full, 'utf8'))) {
        offenders.push(relative(root, full))
      }
    }
  }
  walk(cloudRoot)
  assert.deepEqual(offenders, [], `main/cloud modules must not import 'electron' (use a shared, guarded desktop module instead):\n${offenders.join('\n')}`)
})

test('the single-sourced Electron shim list and the build plugin stay in agreement', () => {
  // The shim list feeds both the build plugin and this test; pin that the build
  // actually consumes it (so the two can't silently drift apart).
  const buildSource = readFileSync(resolve(root, 'scripts/build-cloud.mjs'), 'utf8')
  assert.match(buildSource, /CLOUD_ELECTRON_SHIM_EXPORTS/, 'build-cloud.mjs must build its Electron shim from the single-sourced list')
  assert.ok(shim.has('safeStorage'), 'the shim must stub safeStorage (BYOK secret handling reaches it)')
  assert.ok(shim.has('app'), 'the shim must stub app (config/runtime modules reach it)')
})
