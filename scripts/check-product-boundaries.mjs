#!/usr/bin/env node
/**
 * Enforce monorepo product partition import boundaries (JOE-905).
 * See docs/adr/product-partitions.md.
 *
 * Forbidden:
 * 1. apps/desktop, packages/app, packages/runtime-host → products/gateway|wiki
 * 2. products/gateway → @open-cowork/app, electron, packages/ui
 * 3. products/wiki → knowledge store / mcps/knowledge internals
 * 4. apps/channel-gateway ↔ products/gateway
 * 5. products/wiki ↔ apps/channel-gateway
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-browser', 'coverage', 'site', 'release', '.git'])

const rules = [
  {
    id: 'desktop-to-products',
    roots: ['apps/desktop', 'packages/app', 'packages/runtime-host'],
    forbid: [
      /(?:from\s+|import\s*\(?\s*)['"][^'"]*products\/gateway/,
      /(?:from\s+|import\s*\(?\s*)['"][^'"]*products\/wiki/,
      /(?:from\s+|import\s*\(?\s*)['"]cowork-gateway['"]/,
      /(?:from\s+|import\s*\(?\s*)['"]cowork-wiki['"]/,
      /(?:from\s+|import\s*\(?\s*)['"]@openwiki\//,
    ],
  },
  {
    id: 'gateway-to-desktop-ui',
    roots: ['products/gateway'],
    forbid: [
      /(?:from\s+|import\s*\(?\s*)['"]@open-cowork\/app/,
      /(?:from\s+|import\s*\(?\s*)['"]@open-cowork\/ui/,
      /(?:from\s+|import\s*\(?\s*)['"]electron['"]/,
      /(?:from\s+|import\s*\(?\s*)['"][^'"]*packages\/app\//,
      /(?:from\s+|import\s*\(?\s*)['"][^'"]*packages\/ui\//,
      /(?:from\s+|import\s*\(?\s*)['"][^'"]*apps\/desktop\//,
      /(?:from\s+|import\s*\(?\s*)['"][^'"]*apps\/channel-gateway\//,
    ],
  },
  {
    id: 'wiki-to-knowledge-store',
    roots: ['products/wiki'],
    forbid: [
      /(?:from\s+|import\s*\(?\s*)['"]@open-cowork\/runtime-host/,
      /(?:from\s+|import\s*\(?\s*)['"][^'"]*packages\/runtime-host\//,
      /(?:from\s+|import\s*\(?\s*)['"][^'"]*mcps\/knowledge\//,
      /(?:from\s+|import\s*\(?\s*)['"][^'"]*apps\/channel-gateway\//,
      /(?:from\s+|import\s*\(?\s*)['"][^'"]*apps\/desktop\//,
      /(?:from\s+|import\s*\(?\s*)['"]@open-cowork\/app/,
    ],
  },
  {
    id: 'channel-gateway-to-products',
    roots: ['apps/channel-gateway'],
    forbid: [
      /(?:from\s+|import\s*\(?\s*)['"][^'"]*products\/gateway/,
      /(?:from\s+|import\s*\(?\s*)['"][^'"]*products\/wiki/,
      /(?:from\s+|import\s*\(?\s*)['"]cowork-gateway['"]/,
      /(?:from\s+|import\s*\(?\s*)['"]@openwiki\//,
    ],
  },
]

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) yield path
  }
}

const violations = []
for (const rule of rules) {
  for (const relRoot of rule.roots) {
    const abs = join(root, relRoot)
    try {
      statSync(abs)
    } catch {
      continue
    }
    for (const file of walk(abs)) {
      const contents = readFileSync(file, 'utf8')
      for (const pattern of rule.forbid) {
        if (pattern.test(contents)) {
          violations.push({
            rule: rule.id,
            file: relative(root, file),
            pattern: String(pattern),
          })
        }
      }
    }
  }
}

if (violations.length) {
  console.error('[product-boundaries] FAILED')
  for (const v of violations) {
    console.error(`  [${v.rule}] ${v.file} matches ${v.pattern}`)
  }
  process.exit(1)
}

console.log('[product-boundaries] ok — no forbidden cross-product imports')
