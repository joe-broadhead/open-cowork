import test from 'node:test'
import assert from 'node:assert/strict'
import {
  approvalsSurfaceCss,
  artifactsSurfaceCss,
  channelsSurfaceCss,
  controlsSurfaceCss,
  knowledgeGraphCss,
  projectsSurfaceCss,
  studioSurfaceStyles,
  wikiSurfaceCss,
} from '../packages/ui/src/surface-styles.ts'
import { extractCssRules } from './helpers/css-rules.ts'

// A CSS regression net for the single-sourced studio surfaces. The desktop
// renderer injects `studioSurfaceStyles()` (the aggregate); Cloud Web embeds the
// same individual `*SurfaceCss()` functions in its stylesheet. These tests prove
// the two surfaces stay byte-identical and that the shared CSS parses into a
// well-formed rule set — so a future CSS reorganization (e.g. single-sourcing
// Channels/Projects, which splits grouped rules) can be shown output-preserving
// by diffing the extracted rule maps before and after.

const SURFACES = [
  { name: 'controls', css: controlsSurfaceCss() },
  { name: 'artifacts', css: artifactsSurfaceCss() },
  { name: 'approvals', css: approvalsSurfaceCss() },
  { name: 'wiki', css: wikiSurfaceCss() },
  { name: 'graph', css: knowledgeGraphCss() },
  { name: 'channels', css: channelsSurfaceCss() },
  { name: 'projects', css: projectsSurfaceCss() },
] as const

test('each shared surface stylesheet parses into well-formed, non-empty rules', () => {
  for (const surface of SURFACES) {
    const rules = extractCssRules(surface.css)
    assert.ok(rules.size > 0, `${surface.name} surface should contribute CSS rules`)
    for (const [selector, declarations] of rules) {
      assert.ok(selector.trim().length > 0, `${surface.name}: encountered an empty selector`)
      assert.ok(
        declarations.length > 0 || selector.startsWith('@'),
        `${surface.name}: rule "${selector}" parsed with no declarations (malformed CSS?)`,
      )
    }
  }
})

test('studioSurfaceStyles embeds every shared surface verbatim — desktop⇄web CSS parity', () => {
  // Desktop ships `studioSurfaceStyles()`; Cloud Web ships the same individual
  // functions. Proving the aggregate contains each surface verbatim pins the two
  // surfaces to byte-identical shared CSS (and catches a surface being dropped
  // from the aggregate, or the aggregate drifting from the parts).
  const aggregate = studioSurfaceStyles()
  for (const surface of SURFACES) {
    assert.ok(
      aggregate.includes(surface.css),
      `studioSurfaceStyles() must contain the ${surface.name} surface CSS that Cloud Web embeds`,
    )
  }
})

test('shared controlsSurfaceCss defines the primitive controls that were web-missing', () => {
  // The Input / Textarea / Select / MenuButton / SegmentedControl components render
  // `.ui-input` / `.ui-textarea` / `.ui-select-trigger` / `.ui-menu-trigger` /
  // `.ui-segmented-option`. These rules previously lived ONLY in desktop globals.css, so
  // the website rendered the controls with raw browser defaults (no `.ui-input` rule
  // existed anywhere the website consumed). Pinning them into the shared CSS — embedded
  // by the website via styles.ts — keeps web from regressing back to unstyled controls.
  const rules = extractCssRules(controlsSurfaceCss())
  const required = ['.ui-input', '.ui-textarea', '.ui-select-trigger', '.ui-menu-trigger', '.ui-segmented-option'] as const
  for (const selector of required) {
    const declarations = rules.get(selector)
    assert.ok(
      declarations !== undefined && declarations.length > 0,
      `controlsSurfaceCss() must define "${selector}" so web renders it styled (not browser-default)`,
    )
  }
  // The control fill/border/text declarations the website was missing must be present.
  assert.ok(rules.get('.ui-input')?.includes('--color-text'), '.ui-input must set its text color')
  assert.ok(rules.get('.ui-select-trigger')?.includes('--control-h-md'), '.ui-select-trigger must set its control height')
  // `.ui-button--primary` is now single-sourced too: the website previously rendered a flat
  // accent fill that drifted from the desktop's canonical Studio accent-action gradient. Both
  // apps now share this rule (the gradient uses the shared `--accent-action-*` tokens emitted
  // on both apps), so the primary button renders identically. Pin the base + hover.
  assert.ok(
    rules.get('.ui-button--primary')?.includes('--accent-action-fill'),
    'controlsSurfaceCss() must define `.ui-button--primary` with the shared accent-action gradient fill',
  )
  assert.ok(
    rules.get('.ui-button--primary:hover:not(:disabled)')?.includes('--specular-strong'),
    'controlsSurfaceCss() must define the `.ui-button--primary` hover state so desktop⇄web stay identical',
  )
})

test('every keyboard-focusable surface control carries a :focus-visible ring (WCAG 2.4.7)', () => {
  // Clickable cards/rows/chips must show a visible keyboard-focus ring on both
  // apps. Each rule lives in the shared `*SurfaceCss()` so desktop and web get it.
  // The ring reuses the shared `var(--ring-focus)` token (no bespoke outlines).
  const focusable: ReadonlyArray<{ surface: string, css: string, selector: string }> = [
    { surface: 'artifacts', css: artifactsSurfaceCss(), selector: '.studio-artifacts-filter:focus-visible' },
    { surface: 'approvals', css: approvalsSurfaceCss(), selector: '.studio-question-option:focus-visible' },
    { surface: 'wiki', css: wikiSurfaceCss(), selector: '.studio-wiki-space button:focus-visible' },
    { surface: 'projects', css: projectsSurfaceCss(), selector: '.studio-projects-list .studio-object-card:focus-visible' },
    { surface: 'projects', css: projectsSurfaceCss(), selector: '.studio-stage-chips button:focus-visible' },
    { surface: 'projects', css: projectsSurfaceCss(), selector: '.studio-kanban-task-button:focus-visible' },
    { surface: 'graph', css: knowledgeGraphCss(), selector: '.studio-graph-node:focus-visible circle' },
  ]
  for (const { surface, css, selector } of focusable) {
    const rules = extractCssRules(css)
    const declarations = rules.get(selector)
    assert.ok(declarations !== undefined, `${surface}: missing focus ring rule "${selector}"`)
    assert.ok(
      declarations.includes('--ring-focus') || declarations.includes('stroke'),
      `${surface}: "${selector}" must paint a visible focus ring (var(--ring-focus) or stroke)`,
    )
  }
})

test('the extracted rule map round-trips selector grouping and media nesting', () => {
  // Sanity-check the extractor on a known shape so the regression net is trustworthy.
  const rules = extractCssRules(`
    /* comment */
    .a, .b { color: red; gap: 2px }
    @media (max-width: 10px) { .a { color: blue } }
  `)
  assert.equal(rules.get('.a'), 'color: red; gap: 2px')
  assert.equal(rules.get('.b'), 'color: red; gap: 2px')
  assert.equal(rules.get('@media (max-width: 10px) .a'), 'color: blue')
})
