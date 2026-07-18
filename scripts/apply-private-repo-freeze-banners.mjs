#!/usr/bin/env node
/**
 * Apply freeze README banners to local clones of private product repos.
 * Does NOT push, archive, or call GitHub APIs.
 *
 * Usage:
 *   node scripts/apply-private-repo-freeze-banners.mjs
 *   GATEWAY_REPO=/path/to/opencode-gateway WIKI_REPO=/path/to/open-wiki \
 *     node scripts/apply-private-repo-freeze-banners.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const monorepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const planDir = path.join(monorepoRoot, 'docs/evidence/archive-plan')

const defaults = {
  gateway: path.resolve(monorepoRoot, '../../opencode-gateway'),
  wiki: path.resolve(monorepoRoot, '../../open-wiki'),
}

const gatewayRepo = process.env.GATEWAY_REPO || defaults.gateway
const wikiRepo = process.env.WIKI_REPO || defaults.wiki

function applyBanner(repoPath, bannerFile, productLabel) {
  if (!fs.existsSync(repoPath)) {
    console.warn(`[skip] ${productLabel}: repo not found at ${repoPath}`)
    return false
  }
  const readmePath = path.join(repoPath, 'README.md')
  if (!fs.existsSync(readmePath)) {
    console.warn(`[skip] ${productLabel}: no README.md at ${readmePath}`)
    return false
  }
  const banner = fs.readFileSync(path.join(planDir, bannerFile), 'utf8').trim() + '\n\n'
  let readme = fs.readFileSync(readmePath, 'utf8')
  if (readme.includes('DEVELOPMENT MOVED (frozen 2026-07-18)')) {
    console.log(`[ok] ${productLabel}: freeze banner already present`)
    return true
  }
  // Strip a previous shorter moved notice if any
  readme = readme.replace(/^> \*\*DEVELOPMENT MOVED[\s\S]*?\n\n/m, '')
  fs.writeFileSync(readmePath, banner + readme)
  console.log(`[wrote] ${productLabel}: freeze banner → ${readmePath}`)
  return true
}

const g = applyBanner(gatewayRepo, 'freeze-banner-gateway.md', 'opencode-gateway')
const w = applyBanner(wikiRepo, 'freeze-banner-wiki.md', 'open-wiki')

console.log('')
console.log('Next (manual, not run by this script):')
console.log('  1. Review diffs in private clones')
console.log('  2. Commit freeze banners on private default branches when ready')
console.log('  3. Push only with maintainer intent')
console.log('  4. After monorepo master + release gate: gh repo archive …')
console.log('     (see docs/runbooks/product-repo-archive.md)')

if (!g && !w) process.exit(1)
