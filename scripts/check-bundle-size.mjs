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
import { readFileSync, existsSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(repoRoot, 'packages/app/dist-browser')
const manifestPath = join(distDir, '.vite/manifest.json')
const ENTRY_KEY = 'browser.html'

// Informational output goes to stdout via write() (the repo lint forbids
// console.log outside the shared logger); failures use console.error.
const out = (line = '') => process.stdout.write(`${line}\n`)

// Eager startup budget, gzipped bytes. 220 KB — current eager graph is ~209 KB
// (2026-06-28, after dropping the react-markdown/remark engine), leaving modest
// headroom for hash churn and minor additions without masking real regressions.
const BUDGET_BYTES = 220 * 1024

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

function main() {
  ensureBuilt()
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const files = collectEagerFiles(manifest)

  const rows = []
  let total = 0
  for (const file of files) {
    const absolute = join(distDir, file)
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue
    const gz = gzipSync(readFileSync(absolute), { level: 9 }).length
    total += gz
    rows.push({ file, gz })
  }
  rows.sort((a, b) => b.gz - a.gz)

  out('[check-bundle-size] eager browser-renderer startup graph (gzipped):')
  for (const { file, gz } of rows) {
    out(`  ${String(gz).padStart(8)} B  ${file}`)
  }
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`
  out(`  ${'-'.repeat(40)}`)
  out(`  eager chunks: ${rows.length}`)
  out(`  eager total:  ${total} B (${kb(total)})`)
  out(`  budget:       ${BUDGET_BYTES} B (${kb(BUDGET_BYTES)})`)

  if (total > BUDGET_BYTES) {
    console.error(
      `\n[check-bundle-size] FAIL: eager startup bundle ${kb(total)} exceeds budget ${kb(BUDGET_BYTES)} `
      + `by ${kb(total - BUDGET_BYTES)}.\n`
      + 'Reduce the eager graph (lazy-load a heavy view/vendor) or, if the growth is justified, '
      + 'raise BUDGET_BYTES in scripts/check-bundle-size.mjs with a note.',
    )
    process.exit(1)
  }
  out(`\n[check-bundle-size] OK: ${kb(total)} within budget ${kb(BUDGET_BYTES)} (${kb(BUDGET_BYTES - total)} headroom).`)
}

main()
