#!/usr/bin/env node
// Bundle-size budget for the cloud browser renderer (audit BUNDLE-3).
//
// chunkSizeWarningLimit only logs a warning; this is the CI-enforced gate. It
// sums the EAGER startup graph of the served SPA — the bytes a browser fetches
// on first load, before any route or chart is opened — gzipped, and fails if it
// exceeds BUDGET_BYTES.
//
// What counts as "eager": the browser.html entry chunk + its static-import /
// modulepreload closure + CSS, PLUS the entry's single dynamic bootstrap
// (browser-main.tsx unconditionally `import('../index')`s the renderer) and that
// bootstrap's static closure. Deeper dynamic imports are NOT followed, so the
// lazy route views (ChatView / CapabilitiesPage / AgentsPage / SettingsPanel)
// and the heavy chart vendors (vega / mermaid diagrams / cytoscape / katex) are
// excluded — they only load on demand and must not count against startup.
//
// Set BUDGET_BYTES just above the current eager size; ratchet it DOWN as the
// startup graph shrinks, never silently up.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(repoRoot, 'packages/app/dist-browser')
const assetsDir = join(distDir, 'assets')
const manifestPath = join(distDir, '.vite/manifest.json')
const ENTRY_KEY = 'browser.html'

// Informational output goes to stdout via write() (the repo lint forbids
// console.log outside the shared logger); failures use console.error.
const out = (line = '') => process.stdout.write(`${line}\n`)
const kb = (n) => `${(n / 1024).toFixed(1)} KB`

// Eager startup budget, gzipped bytes. 220 KB — current eager graph is ~216 KB
// (2026-07, after admin control-plane + typed-approvals work), leaving modest
// headroom for hash churn and minor additions without masking real regressions.
const BUDGET_BYTES = 220 * 1024

// Per-route lazy-chunk budgets, gzipped bytes, keyed by the STABLE vite manifest
// source key (not the hashed emitted filename). These gate the OWN code of each
// lazily-loaded feature page so a single heavy route can't balloon on demand even
// though it's kept off the eager startup graph above. Set just above the current
// measured size; ratchet DOWN as a route shrinks, and only raise with a note.
// Measured 2026-07 (gzipped): ChatView 42.6 KB, CapabilitiesPage 25.3 KB,
// AgentsPage 24.3 KB, SettingsPanel 18.7 KB, StudioUtilityPages 12.9 KB (approvals
// + artifacts + channels), AdminPage 11.1 KB, KnowledgePage 8.0 KB.
const PER_ROUTE_BUDGETS = [
  { key: 'src/components/chat/ChatView.tsx', label: 'ChatView', budget: 47 * 1024 },
  { key: 'src/components/capabilities/CapabilitiesPage.tsx', label: 'CapabilitiesPage', budget: 28 * 1024 },
  { key: 'src/components/agents/AgentsPage.tsx', label: 'AgentsPage', budget: 27 * 1024 },
  { key: 'src/components/sidebar/SettingsPanel.tsx', label: 'SettingsPanel', budget: 21 * 1024 },
  { key: 'src/components/studio/StudioUtilityPages.tsx', label: 'StudioUtilityPages (artifacts/approvals/channels)', budget: 15 * 1024 },
  { key: 'src/components/admin/AdminPage.tsx', label: 'AdminPage', budget: 13 * 1024 },
  { key: 'src/components/studio/KnowledgePage.tsx', label: 'KnowledgePage', budget: 10 * 1024 },
]

// Heavyweight lazy VENDOR ceilings, gzipped bytes, matched by emitted-file
// basename prefix. These stay OFF the eager graph (the budget above proves that);
// the ceiling here catches gross bloat — an accidental duplicate copy, or a major
// version that doubles a diagram/chart engine. Headroom is generous (~15-20%) so
// routine dependabot patch bumps don't trip it; a real doubling still does.
// Measured 2026-07 (gzipped): vendor-vega-core 179.8 KB, cytoscape 136.6 KB,
// vendor-vega-embed 98.2 KB, katex 75.8 KB.
const VENDOR_CEILINGS = [
  { prefix: 'vendor-vega-core', label: 'vega core (charts)', budget: 205 * 1024 },
  { prefix: 'cytoscape.esm', label: 'cytoscape (mermaid graph layout)', budget: 158 * 1024 },
  { prefix: 'vendor-vega-embed', label: 'vega-embed (charts)', budget: 115 * 1024 },
  { prefix: 'katex', label: 'katex (math)', budget: 88 * 1024 },
]

function gzipSizeOf(file) {
  return gzipSync(readFileSync(join(distDir, file)), { level: 9 }).length
}

function findAssetByPrefix(prefix) {
  if (!existsSync(assetsDir)) return null
  return readdirSync(assetsDir).find(
    (name) => name.startsWith(`${prefix}-`) && name.endsWith('.js'),
  ) ?? null
}

function ensureBuilt() {
  if (existsSync(manifestPath)) return
  out('[check-bundle-size] dist-browser manifest missing — building browser bundle…')
  const result = spawnSync('pnpm', ['--filter', '@open-cowork/app', 'build:browser'], {
    cwd: repoRoot,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error('[check-bundle-size] browser build failed')
    process.exit(result.status ?? 1)
  }
  if (!existsSync(manifestPath)) {
    console.error(`[check-bundle-size] manifest still missing at ${manifestPath} after build`)
    process.exit(1)
  }
}

// Collect the eager file set: static-import closure of the entry, plus the
// entry's direct dynamic bootstrap and ITS static closure (no deeper dynamics).
function collectEagerFiles(manifest) {
  const files = new Set()
  const seen = new Set()
  const visit = (key, followDynamic) => {
    if (seen.has(key)) return
    seen.add(key)
    const chunk = manifest[key]
    if (!chunk) return
    if (chunk.file) files.add(chunk.file)
    for (const css of chunk.css ?? []) files.add(css)
    for (const imp of chunk.imports ?? []) visit(imp, false)
    if (followDynamic) {
      for (const dyn of chunk.dynamicImports ?? []) visit(dyn, false)
    }
  }
  if (!manifest[ENTRY_KEY]) {
    console.error(`[check-bundle-size] entry '${ENTRY_KEY}' not found in manifest`)
    process.exit(1)
  }
  visit(ENTRY_KEY, true)
  return files
}

function checkEagerBudget(manifest, failures) {
  const files = collectEagerFiles(manifest)
  const rows = []
  let total = 0
  for (const file of files) {
    const absolute = join(distDir, file)
    // Read directly and skip on error rather than existsSync()/statSync()-then-read,
    // which is a TOCTOU race: a missing path throws ENOENT and a directory throws
    // EISDIR, both caught here — matching the old "skip non-regular/absent file".
    let content
    try {
      content = readFileSync(absolute)
    } catch {
      continue
    }
    const gz = gzipSync(content, { level: 9 }).length
    total += gz
    rows.push({ file, gz })
  }
  rows.sort((a, b) => b.gz - a.gz)

  out('[check-bundle-size] eager browser-renderer startup graph (gzipped):')
  for (const { file, gz } of rows) {
    out(`  ${String(gz).padStart(8)} B  ${file}`)
  }
  out(`  ${'-'.repeat(40)}`)
  out(`  eager chunks: ${rows.length}`)
  out(`  eager total:  ${total} B (${kb(total)})`)
  out(`  budget:       ${BUDGET_BYTES} B (${kb(BUDGET_BYTES)})`)

  if (total > BUDGET_BYTES) {
    failures.push(
      `eager startup bundle ${kb(total)} exceeds budget ${kb(BUDGET_BYTES)} by ${kb(total - BUDGET_BYTES)}. `
      + 'Reduce the eager graph (lazy-load a heavy view/vendor) or, if the growth is justified, '
      + 'raise BUDGET_BYTES in scripts/check-bundle-size.mjs with a note.',
    )
  } else {
    out(`  OK: ${kb(total)} within budget (${kb(BUDGET_BYTES - total)} headroom).`)
  }
}

function checkPerRouteBudgets(manifest, failures) {
  out('\n[check-bundle-size] per-route lazy chunk budgets (gzipped):')
  for (const { key, label, budget } of PER_ROUTE_BUDGETS) {
    const chunk = manifest[key]
    if (!chunk?.file) {
      failures.push(
        `route chunk '${label}' (${key}) is missing from the manifest — the source moved or stopped `
        + 'being a lazy import. Update PER_ROUTE_BUDGETS in scripts/check-bundle-size.mjs.',
      )
      out(`  ${'MISSING'.padStart(10)}  ${label}`)
      continue
    }
    const gz = gzipSizeOf(chunk.file)
    const over = gz > budget
    out(`  ${String(gz).padStart(8)} B / ${kb(budget).padStart(8)}  ${label}${over ? '  <-- OVER' : ''}`)
    if (over) {
      failures.push(
        `route '${label}' chunk ${kb(gz)} exceeds its budget ${kb(budget)} by ${kb(gz - budget)}. `
        + 'Split the page (extract sub-features into their own lazy chunks) or, if justified, '
        + 'raise its entry in PER_ROUTE_BUDGETS in scripts/check-bundle-size.mjs with a note.',
      )
    }
  }
}

function checkVendorCeilings(failures) {
  out('\n[check-bundle-size] heavyweight lazy vendor ceilings (gzipped):')
  for (const { prefix, label, budget } of VENDOR_CEILINGS) {
    const file = findAssetByPrefix(prefix)
    if (!file) {
      // A missing vendor chunk means it is no longer emitted (dropped or renamed);
      // that is a leanness WIN, not a regression — note it and move on.
      out(`  ${'(absent)'.padStart(10)}  ${label} — no '${prefix}-*.js' chunk emitted`)
      continue
    }
    const gz = gzipSizeOf(join('assets', file))
    const over = gz > budget
    out(`  ${String(gz).padStart(8)} B / ${kb(budget).padStart(8)}  ${label}${over ? '  <-- OVER' : ''}`)
    if (over) {
      failures.push(
        `vendor '${label}' chunk ${kb(gz)} exceeds its ceiling ${kb(budget)} by ${kb(gz - budget)}. `
        + 'Check for a duplicated copy or an unexpectedly heavy version; if the growth is a legitimate '
        + 'major bump, raise its entry in VENDOR_CEILINGS in scripts/check-bundle-size.mjs with a note.',
      )
    }
  }
}

function main() {
  ensureBuilt()
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const failures = []

  checkEagerBudget(manifest, failures)
  checkPerRouteBudgets(manifest, failures)
  checkVendorCeilings(failures)

  if (failures.length > 0) {
    console.error('\n[check-bundle-size] FAIL:')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  out('\n[check-bundle-size] OK: eager, per-route, and vendor budgets all within limits.')
}

main()
