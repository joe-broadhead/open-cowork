#!/usr/bin/env node
/**
 * Guard: apps/gateway was renamed to apps/channel-gateway (product partitions ADR).
 * A source-less leftover tree (dist-only / empty) confuses agents and workspace globs.
 * Fail if apps/gateway exists without a real package.json product.
 *
 * Audit 2026-07-21 P2-4.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const ghost = join(root, 'apps', 'gateway')

if (!existsSync(ghost)) {
  console.log('[ghost-apps-gateway] ok — apps/gateway absent')
  process.exit(0)
}

const pkg = join(ghost, 'package.json')
if (existsSync(pkg)) {
  console.error('[ghost-apps-gateway] FAILED: apps/gateway has package.json but Channel Gateway lives at apps/channel-gateway. Remove or finish migration.')
  process.exit(1)
}

// Source-less tree (dist leftovers, node_modules residue, empty dirs).
let entries = []
try {
  entries = readdirSync(ghost)
} catch {
  entries = []
}

const meaningful = entries.filter((name) => name !== '.DS_Store')
if (meaningful.length === 0) {
  console.error('[ghost-apps-gateway] FAILED: empty apps/gateway directory — remove it (use apps/channel-gateway).')
  process.exit(1)
}

// Any presence without package.json is a ghost.
const listing = meaningful.map((name) => {
  const p = join(ghost, name)
  try {
    return statSync(p).isDirectory() ? `${name}/` : name
  } catch {
    return name
  }
})
console.error(`[ghost-apps-gateway] FAILED: source-less apps/gateway residue: ${listing.join(', ')}. Remove apps/gateway; Channel Gateway is apps/channel-gateway.`)
process.exit(1)
