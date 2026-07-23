#!/usr/bin/env node
/**
 * Preflight for JOE-915 private-repo archive.
 * Does NOT archive anything — only checks monorepo source-of-truth readiness.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

function exists(rel) {
  return fs.existsSync(path.join(root, rel))
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function must(rel, label = rel) {
  if (!exists(rel)) failures.push(`missing ${label}`)
  else notes.push(`ok: ${label}`)
}

function mustContain(rel, pattern, label) {
  if (!exists(rel)) {
    failures.push(`missing ${rel} (need ${label})`)
    return
  }
  const text = read(rel)
  const ok = typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)
  if (!ok) failures.push(`${rel} missing required content: ${label}`)
  else notes.push(`ok: ${label}`)
}

// Import provenance
must('products/gateway/.import-source-commit')
must('products/gateway/.import-source-repo')
must('products/wiki/.import-source-commit')
must('products/wiki/.import-source-repo')

// Product packages
mustContain('products/gateway/package.json', '"name": "cowork-gateway"', 'gateway package name')
mustContain('products/wiki/package.json', 'cowork-wiki-workspace', 'wiki workspace name')
must('products/gateway/scripts/standalone-smoke.mjs')
must('products/wiki/scripts/standalone-smoke.mjs')

// CI + release (no Electron)
must('.github/workflows/ci-gateway.yml')
must('.github/workflows/ci-wiki.yml')
must('.github/workflows/release-gateway.yml')
must('.github/workflows/release-wiki.yml')
mustContain('.github/workflows/release-gateway.yml', 'standalone-smoke', 'gateway release smoke')
mustContain('.github/workflows/release-wiki.yml', 'standalone-smoke', 'wiki release smoke')

// Freeze / archive docs
must('docs/runbooks/product-repo-archive.md')
must('docs/runbooks/archive-plan/freeze-banner-gateway.md')
must('docs/runbooks/archive-plan/freeze-banner-wiki.md')
mustContain('docs/runbooks/product-repo-archive.md', '2026-07-18', 'freeze date')
mustContain('docs/runbooks/product-repo-archive.md', 'products/gateway', 'gateway monorepo path')
mustContain('docs/runbooks/product-repo-archive.md', 'products/wiki', 'wiki monorepo path')

// Operator-facing product pages
mustContain('docs/opencode-gateway.md', 'products/gateway', 'Gateway docs monorepo path')
mustContain('docs/openwiki.md', 'products/wiki', 'Wiki docs monorepo path')

// Support pointer
mustContain('SUPPORT.md', 'products/gateway', 'SUPPORT mentions gateway partition')
mustContain('SUPPORT.md', 'products/wiki', 'SUPPORT mentions wiki partition')

// Boundaries still present
must('scripts/check-product-boundaries.mjs')

// Secret-scan evidence from import
must('deploy/archive/secret-scans/README.md')

const report = {
  schemaVersion: 1,
  id: 'product_archive_readiness',
  freezeDate: '2026-07-18',
  status: failures.length ? 'fail' : 'pass',
  notes,
  failures,
  safeNextAction: failures.length
    ? 'Fix missing monorepo archive prerequisites before freezing/archiving private repos.'
    : 'Monorepo SoT checks passed. Apply README banners to private clones, merge monorepo to master, run product release/smoke, then archive with maintainer approval (see docs/runbooks/product-repo-archive.md).',
  archiveNotExecuted: true,
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`product archive readiness: ${report.status}`)
  for (const n of notes) console.log(`  - ${n}`)
  for (const f of failures) console.error(`  FAIL: ${f}`)
  console.log(report.safeNextAction)
}

process.exit(failures.length ? 1 : 0)
