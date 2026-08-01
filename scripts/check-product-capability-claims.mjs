import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PRODUCT_CAPABILITY_MANIFEST } from '../packages/shared/src/product-capability-manifest.ts'
import {
  DESKTOP_PRIMARY_FEATURE_KEYS,
  DESKTOP_SECONDARY_FEATURE_KEYS,
} from '../packages/shared/src/app-config.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const errors = []

function fail(message) {
  errors.push(message)
}

function markdownFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...markdownFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path)
  }
  return files
}

function withoutFencedCode(source) {
  return source.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (block) => (
    block.replace(/[^\n]/g, ' ')
  ))
}

function lineNumberAt(source, index) {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source[cursor] === '\n') line += 1
  }
  return line
}

function matchingClaims(path, patterns) {
  const source = readFileSync(path, 'utf8')
  const searchable = withoutFencedCode(source)
  const matches = []
  const seen = new Set()
  for (const pattern of patterns) {
    for (const match of searchable.matchAll(pattern)) {
      if (match.index === undefined || seen.has(match.index)) continue
      seen.add(match.index)
      const line = lineNumberAt(source, match.index)
      matches.push({
        line,
        lineText: source.split('\n')[line - 1]?.trim() || '',
        text: match[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      })
    }
  }
  return matches.sort((left, right) => left.line - right.line)
}

const numberWord = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?'
const catalogCount = `(?:\\d[\\d,]*(?:\\.\\d+)?\\+?|${numberWord})`
const capabilityNoun = '(?:tools?|skills?|MCPs?|MCP\\s+servers?)'
const staticCatalogModifier = '(?:built[- ]?in|bundled|packaged(?:-source)?|configured|shipped|chart(?:ing)?|catalog(?:ued)?)'
const productSubject = 'Open\\s+Cowork'
const staticCatalogCountPatterns = [
  new RegExp(`\\b${catalogCount}\\s+${capabilityNoun}\\s*·\\s*${catalogCount}\\s+${capabilityNoun}\\b`, 'gi'),
  new RegExp(`\\b${catalogCount}\\s+(?:(?:${staticCatalogModifier})\\s+)+${capabilityNoun}\\b`, 'gi'),
  new RegExp(`\\b${productSubject}\\b[^.!?]{0,80}\\b(?:ships?|bundles?|includes?|provides?)\\b[^.!?]{0,180}\\b${catalogCount}\\s+(?:[a-z-]+\\s+){0,3}${capabilityNoun}\\b`, 'gi'),
  new RegExp(`\\b${catalogCount}\\s+(?:[a-z-]+\\s+){0,3}${capabilityNoun}\\b[^.!?]{0,80}\\bout\\s+of\\s+the\\s+box\\b`, 'gi'),
  new RegExp(`class=["']stat-value["'][^>]*>\\s*${catalogCount}\\s*<[^.!?]{0,240}class=["']stat-label["'][^>]*>[^<]{0,80}\\b${capabilityNoun}\\b`, 'gi'),
]

const catalogClaimFixture = [
  'Open Cowork ships 7 MCPs out of the box.',
  'Open Cowork ships seven MCPs out of the box.',
  'The catalog contains six bundled skills.',
  '7 MCPs · six skills',
  '<div class="stat-value">18+</div><div class="stat-label">Built-in chart tools</div>',
]
for (const [index, fixture] of catalogClaimFixture.entries()) {
  const matched = staticCatalogCountPatterns.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(fixture)
  })
  if (!matched) {
    fail(`product claim checker: static catalog fixture ${index + 1} did not catch its digit, word-form, bundled, or stat-card total.`)
  }
}
const instructionalExample = 'A downstream example can use one MCP + one skill.'
if (staticCatalogCountPatterns.some((pattern) => {
  pattern.lastIndex = 0
  return pattern.test(instructionalExample)
})) {
  fail('product claim checker: instructional count examples must not be treated as shipped catalog totals.')
}

const config = JSON.parse(readFileSync(join(root, 'open-cowork.config.json'), 'utf8'))
const actualCatalog = {
  tools: config.tools?.length || 0,
  skills: config.skills?.length || 0,
  mcpServers: config.mcps?.length || 0,
}

for (const [kind, expected] of Object.entries(PRODUCT_CAPABILITY_MANIFEST.configuredCatalog)) {
  const actual = actualCatalog[kind]
  if (actual !== expected) {
    fail(
      `open-cowork.config.json: configured ${kind} changed from ${expected} to ${actual}; `
      + 'update PRODUCT_CAPABILITY_MANIFEST.configuredCatalog in packages/shared/src/product-capability-manifest.ts '
      + 'and review every public capability claim in the same change.',
    )
  }
}

const surfaceIds = new Set(PRODUCT_CAPABILITY_MANIFEST.surfaces.map((surface) => surface.id))
for (const id of PRODUCT_CAPABILITY_MANIFEST.heroPath) {
  if (!surfaceIds.has(id)) fail(`product manifest: heroPath references missing surface "${id}".`)
}

const routeOwners = new Map()
for (const surface of PRODUCT_CAPABILITY_MANIFEST.surfaces) {
  if (!surface.route) continue
  const previous = routeOwners.get(surface.route)
  if (previous) fail(`product manifest: route "${surface.route}" is owned by both "${previous}" and "${surface.id}".`)
  routeOwners.set(surface.route, surface.id)
}

const appRoutesSource = readFileSync(join(root, 'packages/app/src/components/layout/AppRoutes.tsx'), 'utf8')
const sidebarSource = readFileSync(join(root, 'packages/app/src/components/layout/Sidebar.tsx'), 'utf8')
for (const surface of PRODUCT_CAPABILITY_MANIFEST.surfaces) {
  if (!surface.route) continue
  const route = surface.route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`\\bview\\s*===\\s*['"]${route}['"]`).test(appRoutesSource)) {
    fail(`product manifest: route "${surface.route}" has no renderer coverage in AppRoutes.tsx.`)
  }
}
for (const id of PRODUCT_CAPABILITY_MANIFEST.heroPath) {
  const surface = PRODUCT_CAPABILITY_MANIFEST.surfaces.find((entry) => entry.id === id)
  if (!surface) continue
  if (surface.route) {
    const route = surface.route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const sidebarEntry = new RegExp(`(?:\\bview\\s*:\\s*|\\bonViewChange\\(\\s*)['"]${route}['"]`)
    if (!sidebarEntry.test(sidebarSource)) {
      fail(`product manifest: hero route "${surface.route}" has no sidebar navigation entry or work-entry action.`)
    }
    continue
  }
  const label = surface.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const idPattern = surface.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`t\\(\\s*['"]sidebar\\.${idPattern}['"]\\s*,\\s*['"]${label}['"]`).test(sidebarSource)) {
    fail(`product manifest: route-less hero surface "${surface.id}" has no derived sidebar entry point.`)
  }
}

const expectedPrimary = PRODUCT_CAPABILITY_MANIFEST.surfaces
  .filter((surface) => surface.availability === 'default-on')
  .map((surface) => surface.featureKey)
const expectedSecondary = PRODUCT_CAPABILITY_MANIFEST.surfaces
  .filter((surface) => surface.availability === 'default-off')
  .map((surface) => surface.featureKey)
if (JSON.stringify(expectedPrimary) !== JSON.stringify(DESKTOP_PRIMARY_FEATURE_KEYS)) {
  fail('product manifest: derived primary feature keys do not match default-on surfaces.')
}
if (JSON.stringify(expectedSecondary) !== JSON.stringify(DESKTOP_SECONDARY_FEATURE_KEYS)) {
  fail('product manifest: derived secondary feature keys do not match default-off surfaces.')
}

for (const key of DESKTOP_SECONDARY_FEATURE_KEYS) {
  if (config.features?.[key] === true) {
    fail(`open-cowork.config.json: default public config must not enable secondary feature "${key}".`)
  }
}

const publicMarkdown = [join(root, 'README.md'), ...markdownFiles(join(root, 'docs'))]
for (const path of publicMarkdown) {
  for (const match of matchingClaims(path, staticCatalogCountPatterns)) {
    fail(
      `${relative(root, path)}:${match.line}: static catalog count "${match.text}" duplicates runtime/config truth; `
      + 'use non-numeric wording in docs and render workspace counts from the catalog API in product UI.',
    )
  }
}

const desktopGuide = readFileSync(join(root, 'docs/desktop-app.md'), 'utf8')
const documentedFeatureBlock = /Feature keys:\s*([\s\S]*?)\. Primary keys/.exec(desktopGuide)?.[1] || ''
const documentedFeatureKeys = [...documentedFeatureBlock.matchAll(/`([^`]+)`/g)].map((match) => match[1])
const manifestFeatureKeys = PRODUCT_CAPABILITY_MANIFEST.surfaces
  .flatMap((surface) => surface.featureKey ? [surface.featureKey] : [])
if (JSON.stringify(documentedFeatureKeys) !== JSON.stringify(manifestFeatureKeys)) {
  fail(
    'docs/desktop-app.md: canonical Feature keys list must match the capability manifest in order; '
    + `expected ${manifestFeatureKeys.join(', ') || '(none)'}, found ${documentedFeatureKeys.join(', ') || '(none)'}.`,
  )
}

const obsoleteProjectsLanguage = '(?:history\\s+and\\s+recall|indexed\\s+history|searchable\\s+history|history\\s*(?:/|and)\\s*facets?|full[- ]history|full[- ]text|saved\\s+filters?|thread[- ]index|search\\s*/\\s*tags?)'
const obsoleteProjectsClaimPatterns = [
  new RegExp(`\\bProjects\\b[^.!?]{0,120}\\b${obsoleteProjectsLanguage}\\b`, 'gi'),
  new RegExp(`\\b${obsoleteProjectsLanguage}\\b[^.!?]{0,120}\\bProjects\\b`, 'gi'),
]
for (const path of publicMarkdown) {
  for (const match of matchingClaims(path, obsoleteProjectsClaimPatterns)) {
    const context = `${match.lineText} ${match.text}`
    if (/Kanban-only|do not|not\s+(?:a\s+)?(?:full[- ]?)?(?:history|text)|separate from|rather than/i.test(context)) continue
    fail(
      `${relative(root, path)}:${match.line}: obsolete Projects claim "${match.text}"; `
      + `the manifest promises only ${PRODUCT_CAPABILITY_MANIFEST.projects.provides.join(', ')}.`,
    )
  }
}

if (errors.length > 0) {
  console.error(`Product capability claim check failed:\n${errors.map((error) => `- ${error}`).join('\n')}`)
  process.exit(1)
}

process.stdout.write(
  `Product capability claims match manifest v${PRODUCT_CAPABILITY_MANIFEST.version} `
  + `(${actualCatalog.tools} configured tools, ${actualCatalog.skills} skills, ${actualCatalog.mcpServers} MCP servers).\n`,
)
