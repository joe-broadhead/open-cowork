// Design-system tier guard: "semantic tokens only" for component code.
//
// The design system has three tiers (see docs/design-system.md):
//   1. primitive  — raw literal values, single-sourced in the token layer
//   2. semantic   — themeable CSS custom properties emitted from the token layer
//   3. component  — packages/ui/src component code + its CSS-in-TS
//
// Tier-3 component code must consume color through the semantic tokens
// (`var(--color-*)`, `color-mix(...)`, brand variables) rather than hardcoding
// raw color literals, so a downstream retint of the primitive/brand tokens
// re-skins every component without editing component source.
//
// This gate scans the shared component library (`packages/ui/src`, including the
// CSS-in-TS in `surface-styles.ts`) for raw hex / rgb() / hsl() color literals.
//
// Scoping (kept real but green):
//   - Pure ink/white hexes (#fff / #ffffff / #000 / #000000) are allowed: they
//     are used inside `color-mix()` for physical-material specular and overlay
//     math, and there is deliberately no semantic token for pure black/white.
//   - Two files are Tier-1 primitive palette sources and are allowlisted by
//     path: `knowledge-hues.ts` and `utils.ts` single-source the categorical
//     knowledge-space and entity-identity hue rings (data-viz palettes), the
//     same role `design-tokens.ts` plays for the semantic theme.
// Everything else in component code must go through tokens.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const scanRoot = join(root, 'packages/ui/src')

// Tier-1 primitive palette sources: literal categorical hue rings, single-sourced.
const primitivePaletteFiles = new Set([
  'packages/ui/src/knowledge-hues.ts',
  'packages/ui/src/utils.ts',
  // Provider logo glyphs are identity artwork, not theme chrome. Keep the
  // literal brand colors in one explicit source rather than counting them as
  // app component token debt.
  'packages/app/src/components/plugins/PluginIcon.tsx',
])

// Pure ink/white are allowed inside material math (no semantic token exists).
const allowedInkHexes = new Set(['#fff', '#ffff', '#ffffff', '#000', '#0000', '#000000'])

const hexPattern = /#[0-9a-fA-F]{3,8}\b/g
const functionalColorPattern = /\b(?:rgba?|hsla?)\s*\(/g
const validHexLengths = new Set([3, 4, 6, 8])

const errors = []

function scan(dir, sink) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      scan(fullPath, sink)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) continue
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue
    lintFile(fullPath, sink)
  }
}

// Real color literals live inside string/template literals (e.g. background: '#1c1d26'); a `#` in a
// comment is almost always a GitHub issue reference like (#905) — which is valid 3-digit hex and
// would false-positive. Only flag matches that sit inside a quoted string on their line.
function isInsideStringLiteral(line, index) {
  let inSingle = false
  let inDouble = false
  let inTemplate = false
  for (let i = 0; i < index; i += 1) {
    if (line[i - 1] === '\\') continue
    const ch = line[i]
    if (ch === "'" && !inDouble && !inTemplate) inSingle = !inSingle
    else if (ch === '"' && !inSingle && !inTemplate) inDouble = !inDouble
    else if (ch === '`' && !inSingle && !inDouble) inTemplate = !inTemplate
  }
  return inSingle || inDouble || inTemplate
}

function lintFile(fullPath, sink) {
  const relPath = relative(root, fullPath).split('\\').join('/')
  if (primitivePaletteFiles.has(relPath)) return

  const lines = readFileSync(fullPath, 'utf8').split('\n')
  lines.forEach((line, index) => {
    const lineNo = index + 1

    for (const match of line.matchAll(hexPattern)) {
      const literal = match[0]
      const digits = literal.length - 1
      if (!validHexLengths.has(digits)) continue
      if (allowedInkHexes.has(literal.toLowerCase())) continue
      if (!isInsideStringLiteral(line, match.index)) continue
      sink.push(
        `${relPath}:${lineNo} raw hex color literal "${literal}" — use a semantic token `
        + `(var(--color-*) / color-mix) instead so downstream retints apply.`,
      )
    }

    for (const match of line.matchAll(functionalColorPattern)) {
      if (!isInsideStringLiteral(line, match.index)) continue
      sink.push(
        `${relPath}:${lineNo} raw ${match[0].replace(/\s*\($/, '')}() color literal — use a semantic token `
        + `(var(--color-*) / color-mix) instead so downstream retints apply.`,
      )
    }
  })
}

try {
  statSync(scanRoot)
} catch {
  console.error(`check-design-token-usage: ${scanRoot} not found`)
  process.exit(1)
}

scan(scanRoot, errors)

if (errors.length) {
  console.error('Design token usage check failed:\n' + errors.map((entry) => `- ${entry}`).join('\n'))
  process.exit(1)
}

// packages/app now has a zero raw-color baseline. Keep the ratchet here so any
// newly introduced app raw color fails loudly and has to move to semantic
// tokens (var(--color-*) / color-mix) or an explicit primitive artwork allowlist.
const APP_RAW_COLOR_BASELINE = 0
const appScanRoot = join(root, 'packages/app/src')
const appErrors = []
scan(appScanRoot, appErrors)
if (appErrors.length > APP_RAW_COLOR_BASELINE) {
  console.error(
    `Design token usage ratchet failed: packages/app/src has ${appErrors.length} raw color literals `
    + `but the baseline is ${APP_RAW_COLOR_BASELINE}. A new raw color was added — use a semantic token `
    + `(var(--color-*) / color-mix). New offenders include:\n`
    + appErrors.slice(0, 20).map((entry) => `- ${entry}`).join('\n'),
  )
  process.exit(1)
}
if (appErrors.length < APP_RAW_COLOR_BASELINE) {
  console.error(
    `Design token usage ratchet: packages/app/src is down to ${appErrors.length} raw color literals `
    + `(baseline ${APP_RAW_COLOR_BASELINE}). Lower APP_RAW_COLOR_BASELINE in scripts/check-design-token-usage.mjs `
    + `to ${appErrors.length} to lock in the improvement.`,
  )
  process.exit(1)
}

process.stdout.write(
  `Design token usage check passed (packages/ui/src fully tokenized; packages/app/src raw-color ratchet at ${appErrors.length}/${APP_RAW_COLOR_BASELINE}).\n`,
)
