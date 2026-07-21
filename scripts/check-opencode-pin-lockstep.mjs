#!/usr/bin/env node
/**
 * JOE-945: fail closed if OpenCode package pins diverge across monorepo
 * consumers. Authority packages must keep @opencode-ai/sdk (and opencode-ai
 * where present) on the same version string.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const AUTHORITY_PACKAGE_JSONS = [
  'apps/desktop/package.json',
  'apps/standalone-gateway/package.json',
  'packages/cloud-server/package.json',
  'packages/runtime-host/package.json',
  'products/gateway/package.json',
]

function readDeps(rel) {
  const pkg = JSON.parse(readFileSync(resolve(root, rel), 'utf8'))
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  return {
    path: rel,
    sdk: deps['@opencode-ai/sdk'] || null,
    runtime: deps['opencode-ai'] || null,
  }
}

const rows = AUTHORITY_PACKAGE_JSONS.map(readDeps)
const failures = []

const sdkVersions = new Set(rows.map((r) => r.sdk).filter(Boolean))
if (sdkVersions.size === 0) {
  failures.push('no @opencode-ai/sdk pin found in authority packages')
} else if (sdkVersions.size > 1) {
  failures.push(`@opencode-ai/sdk pin skew: ${[...sdkVersions].join(', ')}`)
  for (const r of rows) {
    failures.push(`  ${r.path}: ${r.sdk ?? '(missing)'}`)
  }
}

for (const r of rows) {
  if (!r.sdk) failures.push(`${r.path} missing @opencode-ai/sdk`)
}

// Packages that ship the OpenCode binary must pin opencode-ai to the same
// version as @opencode-ai/sdk.
const runtimeRows = rows.filter((r) => r.runtime)
for (const r of runtimeRows) {
  if (r.runtime !== r.sdk) {
    failures.push(`${r.path}: opencode-ai=${r.runtime} != @opencode-ai/sdk=${r.sdk}`)
  }
}

// Workspace catalog / overrides (pnpm-workspace.yaml) must not advertise a
// different catalog version when present.
try {
  const workspace = readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8')
  const sdkMatch = workspace.match(/['"]@opencode-ai\/sdk@([^'"]+)['"]/)
  const runtimeMatch = workspace.match(/['"]opencode-ai@([^'"]+)['"]/)
  const expected = [...sdkVersions][0]
  if (expected && sdkMatch && sdkMatch[1] !== expected) {
    failures.push(`pnpm-workspace catalog @opencode-ai/sdk@${sdkMatch[1]} != package pins ${expected}`)
  }
  if (expected && runtimeMatch && runtimeMatch[1] !== expected) {
    failures.push(`pnpm-workspace catalog opencode-ai@${runtimeMatch[1]} != package pins ${expected}`)
  }
} catch {
  // optional file
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ status: failures.length ? 'fail' : 'pass', rows, failures }, null, 2))
} else {
  const expected = [...sdkVersions][0] || 'unknown'
  console.log(`OpenCode pin lockstep: sdk=${expected} packages=${rows.length}`)
  for (const r of rows) {
    console.log(`  ${r.path}: sdk=${r.sdk}${r.runtime ? ` runtime=${r.runtime}` : ''}`)
  }
  if (failures.length) {
    console.error('OpenCode pin lockstep failed:\n' + failures.map((f) => `  - ${f}`).join('\n'))
    process.exit(1)
  }
  console.log('OpenCode pin lockstep OK')
}
