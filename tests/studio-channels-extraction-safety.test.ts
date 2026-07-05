import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  analyzeExtractionOrderSafety,
  collectCoOccurringClasses,
  specificity,
} from './helpers/css-cascade.ts'

// Phase 1 — proving the now-decoupled Channels CSS is safe to LIFT into the shared
// injected surface stylesheet. The desktop renderer injects studioSurfaceStyles()
// after globals.css, so lifted rules move to a later source position; at equal
// specificity CSS breaks ties by source order, so a move can only flip a value if a
// moving rule and a staying rule, at equal specificity, set the same property on
// the SAME element with the staying rule currently later. The utility-class
// decoupling removed every such same-element clash; this test proves none remain.

function tsxSources(dir: string): string[] {
  let out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) out = out.concat(tsxSources(path))
    else if (entry.name.endsWith('.tsx')) out.push(readFileSync(path, 'utf8'))
  }
  return out
}

const globalsCss = readFileSync(
  fileURLToPath(new URL('../packages/app/src/styles/globals.css', import.meta.url)),
  'utf8',
)
const coOccur = collectCoOccurringClasses(
  tsxSources(fileURLToPath(new URL('../packages/ui/src', import.meta.url))),
)
const isChannel = (selector: string) => /\.studio-channel(-|__|\b)/.test(selector)

function rightmostHasClass(selector: string): boolean {
  const compound = selector.trim().split(/[\s>+~]+/).pop() || ''
  return /\.[\w-]+/.test(compound)
}

// --- analyzer self-checks (so the gate below is trustworthy) ---

test('specificity counts ids/classes/elements', () => {
  assert.deepEqual(specificity('.a'), [0, 1, 0])
  assert.deepEqual(specificity('.a .b'), [0, 2, 0])
  assert.deepEqual(specificity('.a h3'), [0, 1, 1])
  assert.deepEqual(specificity('#x div.a'), [1, 1, 1])
})

test('analyzer flags a real same-element co-occurring collision and clears a non-co-occurring one', () => {
  // .a and .b set color at equal specificity, .b after .a.
  const css = '.a { color: red; } .b { color: blue; }'
  // When .a and .b can co-occur on one element, moving .a after .b would flip color.
  assert.equal(analyzeExtractionOrderSafety(css, (s) => s === '.a', new Set(['a|b'])).length, 1)
  // When they never co-occur, there is no element where the order matters.
  assert.equal(analyzeExtractionOrderSafety(css, (s) => s === '.a', new Set()).length, 0)
  // Lower-specificity staying rule can never win a tie → not a collision.
  const css2 = '.a { color: red; } div { color: blue; }'
  assert.equal(analyzeExtractionOrderSafety(css2, (s) => s === '.a', new Set()).length, 0)
})

// --- the gate ---

test('lifting Channels CSS introduces no same-element shared-class cascade-order collision', () => {
  const collisions = analyzeExtractionOrderSafety(globalsCss, isChannel, coOccur)
  // The dangerous class: BOTH sides class-bearing on their rightmost compound and
  // (per mayMatchSameElement) able to land on the same element — a shared
  // modifier/utility clash, exactly what the decoupling eliminated. The benign
  // residual (bare-element descendants in other containers, :focus/::scrollbar
  // pseudos) always has a non-class rightmost compound on the staying side.
  const dangerous = collisions.filter(
    (c) => rightmostHasClass(c.movingSelector) && rightmostHasClass(c.stayingSelector),
  )
  assert.deepEqual(dangerous, [], `unexpected same-element class collisions: ${JSON.stringify(dangerous)}`)
})
