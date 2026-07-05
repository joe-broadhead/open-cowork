import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// CI-enforced eager bundle budget (audit BUNDLE-3). The script builds the browser
// renderer if dist-browser is missing, sums the gzipped EAGER startup graph (entry
// + its static/preload closure + the always-run bootstrap, excluding lazy route
// views and chart vendors), and exits non-zero if it exceeds the documented budget.
test('cloud browser renderer eager startup bundle stays within budget', () => {
  const result = spawnSync('node', ['scripts/check-bundle-size.mjs'], {
    cwd: repoRoot,
    encoding: 'utf8',
    // The fallback build can take a while on a cold dist-browser.
    timeout: 5 * 60_000,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(result.status, 0, `bundle-size budget check failed:\n${output}`)
  assert.match(output, /within budget/)
})
