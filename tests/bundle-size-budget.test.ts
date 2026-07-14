import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// CI-enforced bundle budgets (audit BUNDLE-3 + issue #900). The script builds the
// browser renderer if dist-browser is missing, then enforces the eager graph,
// deliberate lazy boundaries, and the on-demand chunk ceilings:
//   1. the gzipped EAGER startup graph (entry + static/preload closure + the
//      always-run bootstrap, excluding lazy route views and chart vendors),
//   2. manifest guards that keep secondary feature modules out of that graph,
//   3. per-route budgets on each lazily-loaded feature page's own chunk, and
//   4. ceilings on the heavyweight lazy chart/diagram vendors.
test('cloud browser renderer preserves lazy boundaries and stays within bundle budgets', () => {
  const result = spawnSync('node', ['scripts/check-bundle-size.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    // The fallback build can take a while on a cold dist-browser.
    timeout: 5 * 60_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(result.status, 0, `bundle-size budget check failed:\n${output}`)
  // Every gate must have actually run — a silently-skipped gate is a broken
  // budget. Assert each section is present and the run reports overall success.
  assert.match(output, /eager browser-renderer startup graph/)
  assert.match(output, /lazy startup feature boundaries/)
  assert.match(output, /per-route lazy chunk budgets/)
  assert.match(output, /heavyweight lazy vendor ceilings/)
  assert.match(output, /eager, lazy-boundary, per-route, and vendor checks all pass/)
})
