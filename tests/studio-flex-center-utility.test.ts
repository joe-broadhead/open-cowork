import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { extractCssRules } from './helpers/css-rules.ts'
import { cloudWebsiteStudioPrimitiveStyles } from '../apps/website/src/style-studio-primitives.ts'

// Phase 1 — utility-class decoupling. The Channels/Projects surfaces previously
// got `display:flex; align-items:center` by being grouped, *by surface selector*,
// into a single cross-surface rule alongside six unrelated surfaces (shell,
// composer, people, deliverables, status, trait-slider). That entanglement is
// why the channels/projects CSS could not be single-sourced without a cascade
// reorder. They now opt in via the `studio-u-flex-center` class in the shared
// markup instead, so the surface selectors are free of the cross-surface group.
// This test locks that invariant on BOTH stylesheets + the shared markup.

const FLEX_CENTER = 'align-items: center; display: flex'
const CARD_TITLE =
  'color: var(--color-text); display: block; font-size: var(--text-sm); font-weight: 700; line-height: var(--lh-sm); margin: 0'
const CARD_TEXT =
  'color: var(--color-text-muted); font-size: var(--text-xs); line-height: var(--lh-xs); margin: 0'

const globalsCss = readFileSync(
  fileURLToPath(new URL('../apps/desktop/src/renderer/styles/globals.css', import.meta.url)),
  'utf8',
)
const websiteCss = cloudWebsiteStudioPrimitiveStyles()
const primitivesTsx = readFileSync(
  fileURLToPath(new URL('../packages/ui/src/StudioPrimitives.tsx', import.meta.url)),
  'utf8',
)
const kanbanTsx = readFileSync(
  fileURLToPath(new URL('../packages/ui/src/ProjectsKanbanSurface.tsx', import.meta.url)),
  'utf8',
)

for (const [label, css] of [
  ['desktop globals.css', globalsCss],
  ['website studio-primitives', websiteCss],
] as const) {
  test(`${label}: .studio-u-flex-center defines the shared flex-center declarations`, () => {
    assert.equal(extractCssRules(css).get('.studio-u-flex-center'), FLEX_CENTER)
  })

  test(`${label}: channels/projects selectors are decoupled from the cross-surface flex-center group`, () => {
    const rules = extractCssRules(css)
    // The surface selectors no longer carry the grouped flex-center declarations
    // directly — they inherit them through the utility class in shared markup.
    assert.notEqual(rules.get('.studio-channel-row'), FLEX_CENTER)
    assert.notEqual(rules.get('.studio-kanban-task-card__foot'), FLEX_CENTER)
  })

  test(`${label}: card typography utilities define the title/text declarations`, () => {
    const rules = extractCssRules(css)
    assert.equal(rules.get('.studio-u-card-title'), CARD_TITLE)
    assert.equal(rules.get('.studio-u-card-text'), CARD_TEXT)
  })

  test(`${label}: channels/projects inner typography is decoupled from the cross-surface descendant groups`, () => {
    const rules = extractCssRules(css)
    // The descendant typography selectors are gone — these elements get their
    // title/text styling from the utility classes in shared markup instead.
    assert.equal(rules.has('.studio-channel-row h3'), false)
    assert.equal(rules.has('.studio-channel-row p'), false)
    assert.equal(rules.has('.studio-kanban-task-card h4'), false)
    assert.equal(rules.has('.studio-kanban-task-card p'), false)
  })
}

// Direct-class channel-row groups (copy/icon/row-surface), decoupled via the
// group-member-swap trick — the utility joins the exact same rule, so the swap is
// provably cascade-identical. These three have identical declarations on both
// apps, so they are genuine cross-app shared utilities (a real parity guarantee).
const desktopRules = extractCssRules(globalsCss)
const websiteRules = extractCssRules(websiteCss)

for (const util of [
  '.studio-u-fill-min',
  '.studio-u-icon-chip',
  '.studio-u-row-surface',
  '.studio-u-progress-track',
  '.studio-u-progress-fill',
]) {
  test(`${util} is a true shared utility — identical declarations on desktop and website`, () => {
    const desktop = desktopRules.get(util)
    assert.ok(desktop && desktop.length > 0, `${util} missing on desktop`)
    assert.equal(desktop, websiteRules.get(util))
  })
}

test('channel-row + project-progress inner selectors are decoupled from their cross-surface groups', () => {
  for (const rules of [desktopRules, websiteRules]) {
    assert.equal(rules.has('.studio-channel-row__copy'), false)
    assert.equal(rules.has('.studio-channel-row__icon'), false)
    // project-progress's track/fill no longer ride the working-style-bars group.
    assert.equal(rules.has('.studio-project-progress span'), false)
    assert.equal(rules.has('.studio-project-progress i'), false)
  }
})

test('shared markup applies the flex-center utility to the decoupled surfaces', () => {
  assert.match(primitivesTsx, /className="studio-kanban-task-card__foot studio-u-flex-center"/)
  assert.match(primitivesTsx, /studio-channel-row studio-u-flex-center studio-u-row-surface/)
})

test('shared markup applies the row/icon/fill utilities to channel-row', () => {
  assert.match(primitivesTsx, /studio-channel-row__icon studio-u-icon-chip/)
  assert.match(primitivesTsx, /studio-channel-row__copy studio-u-fill-min/)
})

test('both project-progress markups apply the track/fill utilities', () => {
  for (const tsx of [primitivesTsx, kanbanTsx]) {
    assert.match(tsx, /className="studio-u-progress-track"/)
    assert.match(tsx, /className="studio-u-progress-fill"/)
  }
})

test('shared markup applies the card typography utilities to the decoupled inner elements', () => {
  // channel-row title/description + kanban-task-card title/description.
  assert.match(primitivesTsx, /<h3 className="studio-u-card-title">{title}<\/h3>/)
  assert.match(primitivesTsx, /<h4 className="studio-u-card-title">{task\.title}<\/h4>/)
  assert.match(primitivesTsx, /<p className="studio-u-card-text">{description}<\/p>/)
  assert.match(primitivesTsx, /<p className="studio-u-card-text">{task\.description}<\/p>/)
})
