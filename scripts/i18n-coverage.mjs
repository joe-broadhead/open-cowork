// i18n coverage engine (I18N-01 / I18N-03).
//
// The renderer's i18n policy is: every `t('key', 'English fallback')`
// call carries an inline English default, and a key missing from the
// active catalog renders that English fallback (see packages/app/src/
// helpers/i18n.ts `t()`). So an untranslated key is never broken UI —
// it is honest English. This engine makes that gap *explicit and
// gated* rather than silent:
//
//   - COVERAGE (I18N-01): every static `t()` key used by the shipping
//     renderer must be EITHER present in the built-in catalogs OR
//     listed in the documented English-only / pending-translation
//     allowlist. A brand-new `t()` key with neither fails the gate, so
//     the translation backlog can only ever shrink or be made visible
//     — it can never silently grow.
//
//   - LIVENESS (I18N-03): every catalog key must still be referenced
//     somewhere in the renderer (directly via `t('key', …)`, indirectly
//     via an object-literal `key:`/`labelKey:` reference, through a
//     documented dynamic `t(`prefix.${x}`)` prefix, or by a test). Dead
//     keys — translated strings no longer used by any surface — fail
//     the gate so the catalogs cannot re-accumulate cruft.
//
// IMPORTANT: this engine never invents translations. Gaps are recorded
// in the allowlist as honest English-fallback keys, not machine-faked
// locale strings.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const APP_SRC = join(ROOT, 'packages/app/src')
const CATALOGS_DIR = join(APP_SRC, 'helpers/i18n-catalogs')
const TESTS_DIR = join(ROOT, 'tests')
const ALLOWLIST_PATH = join(TESTS_DIR, 'i18n-english-only-allowlist.json')
// Reference catalog. tests/i18n-key-parity.test.ts independently proves
// every non-English catalog shares one key set, so a single reference
// is sufficient here.
const REFERENCE_CATALOG = join(CATALOGS_DIR, 'es.ts')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full)
  }
  return out
}

const isTestFile = (f) => /\.test\.(ts|tsx)$/.test(f) || /[\\/]test[\\/]/.test(f)
const isCatalog = (f) => f.startsWith(CATALOGS_DIR)

// Matches t('key', …) and t("key", …) — supports whitespace/newlines
// between `t(` and the key, so multi-line calls are captured.
const STATIC_KEY_RE = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g
// Matches t(`prefix.${…}`) — dynamic keys. We keep the literal prefix
// before the first interpolation.
const DYNAMIC_KEY_RE = /\bt\(\s*`([^`]*)`/g
// A line that defines a catalog entry: 'key': '…' (single-line; the
// parity test proves all catalogs are single-line one-key-per-line).
const CATALOG_KEY_RE = /^\s*(['"])((?:\\.|(?!\1).)*)\1\s*:/

function extractStaticKeys(src, into) {
  STATIC_KEY_RE.lastIndex = 0
  let m
  while ((m = STATIC_KEY_RE.exec(src))) into.add(m[2])
}

function extractDynamicPrefixes(src, into) {
  DYNAMIC_KEY_RE.lastIndex = 0
  let m
  while ((m = DYNAMIC_KEY_RE.exec(src))) {
    const tmpl = m[1]
    const idx = tmpl.indexOf('${')
    const prefix = idx >= 0 ? tmpl.slice(0, idx) : tmpl
    if (prefix) into.add(prefix)
  }
}

export function readCatalogKeys(file = REFERENCE_CATALOG) {
  const src = readFileSync(file, 'utf8')
  const keys = new Set()
  for (const line of src.split('\n')) {
    const m = CATALOG_KEY_RE.exec(line)
    if (m) keys.add(m[2])
  }
  return keys
}

export function loadAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return { policy: '', keys: [] }
  const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'))
  return { policy: parsed.policy || '', keys: Array.isArray(parsed.keys) ? parsed.keys : [] }
}

export function computeI18nCoverage() {
  const allAppFiles = walk(APP_SRC).filter((f) => !isCatalog(f))
  const shippingFiles = allAppFiles.filter((f) => !isTestFile(f))
  const testFiles = [
    ...allAppFiles.filter(isTestFile),
    ...(existsSync(TESTS_DIR) ? walk(TESTS_DIR) : []),
  ]

  // Coverage is gated on the SHIPPING renderer only — keys referenced
  // solely from test fixtures must not force catalog/allowlist entries.
  const usedStatic = new Set()
  const dynamicPrefixes = new Set()
  const livenessParts = []
  for (const file of shippingFiles) {
    const src = readFileSync(file, 'utf8')
    extractStaticKeys(src, usedStatic)
    extractDynamicPrefixes(src, dynamicPrefixes)
    livenessParts.push(src)
  }
  // Liveness, however, also honours test references: a catalog key that
  // a test asserts on is intentionally retained.
  for (const file of testFiles) livenessParts.push(readFileSync(file, 'utf8'))
  const livenessBlob = livenessParts.join('\n')

  const catalogKeys = readCatalogKeys()
  const { policy, keys: allowlistKeys } = loadAllowlist()
  const allowlist = new Set(allowlistKeys)

  const dynPrefixes = [...dynamicPrefixes]
  const coveredByDynamic = (k) => dynPrefixes.some((p) => k.startsWith(p))
  const literalPresent = (k) =>
    livenessBlob.includes(`'${k}'`)
    || livenessBlob.includes(`"${k}"`)
    || livenessBlob.includes('`' + k + '`')
  const isLive = (k) => literalPresent(k) || coveredByDynamic(k)

  const sorted = (set) => [...set].sort()

  // I18N-01: used keys with no translation. These render English via the
  // fallback; the allowlist documents them as a known, accepted gap.
  const missing = sorted(usedStatic).filter((k) => !catalogKeys.has(k))
  // Gate failure: a used key that is neither translated nor allowlisted.
  const uncovered = missing.filter((k) => !allowlist.has(k))
  // Gate failure: allowlist entries that are no longer used by the
  // shipping renderer (stale) or that are now translated (contradiction).
  const staleAllowlist = sorted(allowlist).filter((k) => !usedStatic.has(k))
  const allowlistInCatalog = sorted(allowlist).filter((k) => catalogKeys.has(k))
  // I18N-03: catalog keys no longer referenced anywhere.
  const dead = sorted(catalogKeys).filter((k) => !isLive(k))

  return {
    policy,
    counts: {
      shippingFiles: shippingFiles.length,
      usedStatic: usedStatic.size,
      catalogKeys: catalogKeys.size,
      allowlist: allowlist.size,
      dynamicPrefixes: dynPrefixes.length,
      missing: missing.length,
      uncovered: uncovered.length,
      staleAllowlist: staleAllowlist.length,
      allowlistInCatalog: allowlistInCatalog.length,
      dead: dead.length,
    },
    usedStatic: sorted(usedStatic),
    dynamicPrefixes: dynPrefixes.sort(),
    catalogKeys: sorted(catalogKeys),
    missing,
    uncovered,
    staleAllowlist,
    allowlistInCatalog,
    dead,
  }
}

// The shipped coverage-status module: the renderer surfaces the honest
// translation percentage in the language picker (all translated catalogs
// share one key set — tests/i18n-key-parity.test.ts — so a single global
// figure is accurate for every non-English locale). Generated here so the
// number can never drift from the real backlog: the default check fails
// when the checked-in module disagrees with the computed report.
const COVERAGE_STATUS_PATH = join(APP_SRC, 'helpers', 'i18n-catalogs', 'coverage-status.ts')

export function renderCoverageStatusModule(report) {
  const translated = report.counts.usedStatic - report.counts.missing
  return `// AUTO-GENERATED by \`node scripts/i18n-coverage.mjs --write-status\` — do not edit.
// Honest translation coverage for the built-in non-English locale catalogs
// (they share one key set, so one figure covers all of them). Surfaced in
// the language picker; the i18n:check gate fails if this file drifts from
// the computed report.
export const BUILT_IN_TRANSLATION_COVERAGE = {
  translatedKeys: ${translated},
  totalStaticKeys: ${report.counts.usedStatic},
} as const
`
}

// CLI: print a report and exit non-zero on any gate failure. Useful for
// humans regenerating the allowlist or auditing the backlog locally.
if (import.meta.url === `file://${process.argv[1]}`) {
  const out = (line = '') => process.stdout.write(line + '\n')
  const r = computeI18nCoverage()
  const c = r.counts
  if (process.argv.includes('--write-status')) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(COVERAGE_STATUS_PATH, renderCoverageStatusModule(r))
    out(`wrote ${COVERAGE_STATUS_PATH}`)
    process.exit(0)
  }
  out('i18n coverage report')
  out(`  shipping files scanned : ${c.shippingFiles}`)
  out(`  static t() keys used   : ${c.usedStatic}`)
  out(`  catalog keys (ref)     : ${c.catalogKeys}`)
  out(`  dynamic key prefixes   : ${c.dynamicPrefixes}`)
  out(`  translated             : ${c.usedStatic - c.missing}`)
  out(`  English-only (allowed) : ${c.allowlist}`)
  out(`  untranslated total     : ${c.missing}`)
  const fails = []
  const expectedStatus = renderCoverageStatusModule(r)
  const actualStatus = existsSync(COVERAGE_STATUS_PATH) ? readFileSync(COVERAGE_STATUS_PATH, 'utf8') : null
  if (actualStatus !== expectedStatus) {
    fails.push('coverage-status.ts is out of sync with the computed report — run `node scripts/i18n-coverage.mjs --write-status`')
  }
  if (c.uncovered) fails.push(`${c.uncovered} uncovered key(s) (used, untranslated, not allowlisted):\n    ${r.uncovered.join('\n    ')}`)
  if (c.dead) fails.push(`${c.dead} dead catalog key(s) (translated but unused):\n    ${r.dead.join('\n    ')}`)
  if (c.staleAllowlist) fails.push(`${c.staleAllowlist} stale allowlist key(s) (no longer used):\n    ${r.staleAllowlist.join('\n    ')}`)
  if (c.allowlistInCatalog) fails.push(`${c.allowlistInCatalog} allowlist key(s) now translated (remove from allowlist):\n    ${r.allowlistInCatalog.join('\n    ')}`)
  if (fails.length) {
    console.error('\nFAIL:\n' + fails.map((f) => '  - ' + f).join('\n'))
    process.exit(1)
  }
  out('\nOK: i18n coverage + liveness gate green.')
}
