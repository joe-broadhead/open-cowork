import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error — plain-JS engine shared with `pnpm i18n:check`.
import { computeI18nCoverage } from '../scripts/i18n-coverage.mjs'

// i18n coverage + liveness gate (I18N-01 / I18N-03).
//
// Policy: every `t('key', 'English fallback')` in the shipping renderer
// renders its English fallback when the active catalog lacks the key
// (verified by tests/i18n-runtime.test.ts), so an untranslated key is
// honest English, never broken UI. This gate makes that translation gap
// EXPLICIT and prevents silent drift:
//   - a new `t()` key with neither a catalog entry nor an allowlist
//     entry fails CI (coverage), and
//   - a catalog key no longer referenced anywhere fails CI (liveness),
// so the English-only allowlist and the catalogs stay honest over time.
//
// The allowlist (tests/i18n-english-only-allowlist.json) records the
// current real gaps as English-fallback keys — it never holds
// machine-fabricated translations.

const report = computeI18nCoverage() as {
  counts: Record<string, number>
  uncovered: string[]
  dead: string[]
  staleAllowlist: string[]
  allowlistInCatalog: string[]
  missing: string[]
}

test('every shipping t() key is translated or on the documented English-only allowlist (I18N-01)', () => {
  assert.deepEqual(
    report.uncovered,
    [],
    `New t() key(s) used in packages/app/src with no catalog translation and no `
    + `allowlist entry. Either translate the key in every locale catalog, or add it `
    + `to tests/i18n-english-only-allowlist.json (run \`pnpm i18n:check\` to regenerate `
    + `the gap list). Do NOT invent translations.\n  ${report.uncovered.join('\n  ')}`,
  )
})

test('no dead translation keys ship in the catalogs (I18N-03)', () => {
  assert.deepEqual(
    report.dead,
    [],
    `Catalog key(s) no longer referenced by any renderer surface (directly via `
    + `t('key', …), indirectly via an object-literal key, a dynamic t(\`prefix.\${x}\`) `
    + `prefix, or a test). Remove them from every locale catalog.\n  ${report.dead.join('\n  ')}`,
  )
})

test('the English-only allowlist stays honest (no stale or now-translated entries)', () => {
  assert.deepEqual(
    report.staleAllowlist,
    [],
    `Allowlist key(s) no longer used by the shipping renderer — remove from `
    + `tests/i18n-english-only-allowlist.json:\n  ${report.staleAllowlist.join('\n  ')}`,
  )
  assert.deepEqual(
    report.allowlistInCatalog,
    [],
    `Allowlist key(s) that now have a catalog translation — remove from the `
    + `English-only allowlist:\n  ${report.allowlistInCatalog.join('\n  ')}`,
  )
})

test('the allowlist documents exactly the current untranslated set', () => {
  // Coverage (uncovered === []) proves missing ⊆ allowlist; honesty checks
  // prove allowlist ⊆ missing. Together the allowlist is precisely the gap.
  assert.equal(
    report.counts.missing,
    report.counts.allowlist,
    'allowlist size must equal the count of used-but-untranslated keys',
  )
  assert.ok(report.counts.allowlist > 0, 'expected a non-empty documented translation backlog')
})
