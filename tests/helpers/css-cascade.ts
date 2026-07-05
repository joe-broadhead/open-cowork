// Static cascade-order safety analysis for surface-CSS extraction.
//
// When a set of rules is lifted out of globals.css into the shared injected
// surface stylesheet, those rules move to a LATER source position — the desktop
// renderer injects studioSurfaceStyles() *after* importing globals.css. CSS breaks
// specificity ties by source order, so moving a rule later can only ever let it
// WIN a tie it previously lost. A move is therefore order-UNSAFE only when:
//   a moving rule M and a staying rule S, at EQUAL specificity, both set the same
//   property, can match the same element, and S currently sits AFTER M (so S wins
//   the tie today) — after the move M would win and the computed value could flip.
//
// This module finds exactly those (M, S, property) collisions. An empty result is
// a proof the extraction is cascade-order-safe; a non-empty result is the precise
// list to inspect. Lower-specificity staying rules (e.g. bare element resets) can
// never win a tie, and higher-specificity ones win regardless of order, so both
// are correctly ignored.

export type Specificity = readonly [number, number, number]

type ParsedRule = {
  selector: string
  specificity: Specificity
  decls: Map<string, string>
  order: number
  media: string
}

/** Approximate CSS specificity (a=id, b=class/attr/pseudo-class, c=element/pseudo-element). */
export function specificity(selector: string): Specificity {
  const clean = selector.replace(/\s+/g, ' ').trim()
  const ids = (clean.match(/#[\w-]+/g) || []).length
  const classes = (clean.match(/\.[\w-]+/g) || []).length
  const attrs = (clean.match(/\[[^\]]+\]/g) || []).length
  const pseudoClasses = (clean.match(/:(?!:)[\w-]+(\([^)]*\))?/g) || []).length
  const pseudoElements = (clean.match(/::[\w-]+/g) || []).length
  const elements = (clean.replace(/[.#:[][^\s>+~]*/g, ' ').match(/\b[a-zA-Z][\w-]*\b/g) || []).length
  return [ids, classes + attrs + pseudoClasses, elements + pseudoElements]
}

function eqSpec(a: Specificity, b: Specificity): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

function rightmostCompound(selector: string): string {
  return selector.trim().split(/[\s>+~]+/).pop() || ''
}

/** The rightmost compound selector's element name, if it pins one (else null = "any element"). */
function rightmostElement(selector: string): string | null {
  const lead = rightmostCompound(selector).match(/^[a-zA-Z][\w-]*/)
  return lead ? lead[0].toLowerCase() : null
}

function classesOf(compound: string): string[] {
  return (compound.match(/\.[\w-]+/g) || []).map((c) => c.slice(1))
}

const coOccurKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/**
 * Collect, from React markup, the set of class pairs that appear together on some
 * element (so the cascade analyzer knows which class selectors can actually match
 * the same node). Every class token mentioned inside a single `className=...` span
 * is treated as co-occurring — over-approximating within an attribute (a cn() call
 * may be conditional) which keeps the safety analysis sound (never under-detects).
 */
export function collectCoOccurringClasses(sources: readonly string[]): Set<string> {
  const pairs = new Set<string>()
  for (const src of sources) {
    let i = 0
    while (true) {
      const at = src.indexOf('className', i)
      if (at === -1) break
      let j = src.indexOf('=', at)
      if (j === -1) break
      j += 1
      while (j < src.length && /\s/.test(src[j])) j += 1
      let span = ''
      if (src[j] === '{') {
        let depth = 0
        for (; j < src.length; j += 1) {
          if (src[j] === '{') depth += 1
          else if (src[j] === '}') { depth -= 1; if (depth === 0) { j += 1; break } }
          span += src[j]
        }
      } else if (src[j] === '"' || src[j] === "'" || src[j] === '`') {
        const quote = src[j]
        span += src[j]
        for (j += 1; j < src.length; j += 1) { span += src[j]; if (src[j] === quote) { j += 1; break } }
      }
      const tokens = new Set<string>()
      for (const lit of span.match(/'[^']*'|"[^"]*"|`[^`]*`/g) || []) {
        for (const tok of lit.slice(1, -1).split(/\s+/)) {
          if (/^[\w-]+$/.test(tok)) tokens.add(tok)
        }
      }
      const list = [...tokens]
      for (let a = 0; a < list.length; a += 1) {
        for (let b = a + 1; b < list.length; b += 1) pairs.add(coOccurKey(list[a], list[b]))
      }
      i = j
    }
  }
  return pairs
}

// Two selectors may match the same element unless we can prove they cannot. If
// both rightmost compounds pin DIFFERENT element names, no. If both are
// class-bearing, they co-match only when every cross pair of their classes can
// co-occur on one element (per the markup-derived co-occurrence set); distinct BEM
// component classes that never share an element are thereby excluded. Selectors
// without a class in their rightmost compound fall back to "may match" (sound).
function mayMatchSameElement(a: string, b: string, coOccur: Set<string>): boolean {
  const ea = rightmostElement(a)
  const eb = rightmostElement(b)
  if (ea && eb && ea !== eb) return false
  const ca = classesOf(rightmostCompound(a))
  const cb = classesOf(rightmostCompound(b))
  if (ca.length === 0 || cb.length === 0) return true
  for (const x of ca) {
    for (const y of cb) {
      if (x !== y && !coOccur.has(coOccurKey(x, y))) return false
    }
  }
  return true
}

function parseDecls(body: string): Map<string, string> {
  const decls = new Map<string, string>()
  for (const part of body.split(';')) {
    const colon = part.indexOf(':')
    if (colon === -1) continue
    const prop = part.slice(0, colon).trim().toLowerCase()
    const value = part.slice(colon + 1).trim().replace(/\s+/g, ' ')
    if (prop) decls.set(prop, value)
  }
  return decls
}

function parseRules(css: string): ParsedRule[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules: ParsedRule[] = []
  let order = 0

  function walk(segment: string, media: string): void {
    let i = 0
    while (i < segment.length) {
      const brace = segment.indexOf('{', i)
      if (brace === -1) break
      const prelude = segment.slice(i, brace).trim()
      // find matching close
      let depth = 0
      let close = brace
      for (let j = brace; j < segment.length; j += 1) {
        if (segment[j] === '{') depth += 1
        else if (segment[j] === '}') {
          depth -= 1
          if (depth === 0) { close = j; break }
        }
      }
      const inner = segment.slice(brace + 1, close)
      if (prelude.startsWith('@media') || prelude.startsWith('@supports')) {
        walk(inner, prelude.replace(/\s+/g, ' '))
      } else if (!prelude.startsWith('@')) {
        const decls = parseDecls(inner)
        for (const selector of prelude.split(',').map((s) => s.trim()).filter(Boolean)) {
          rules.push({ selector, specificity: specificity(selector), decls, order: order++, media })
        }
      }
      i = close + 1
    }
  }

  walk(stripped, '')
  return rules
}

export type OrderCollision = {
  property: string
  movingSelector: string
  stayingSelector: string
  media: string
}

/**
 * Find order-unsafe collisions for lifting every rule whose selector satisfies
 * `isMoving` to the end of the cascade. Empty ⇒ the extraction cannot change any
 * computed value through source-order reshuffling.
 */
export function analyzeExtractionOrderSafety(
  css: string,
  isMoving: (selector: string) => boolean,
  coOccur: Set<string> = new Set(),
): OrderCollision[] {
  const rules = parseRules(css)
  const moving = rules.filter((r) => isMoving(r.selector))
  const staying = rules.filter((r) => !isMoving(r.selector))
  const collisions: OrderCollision[] = []

  for (const m of moving) {
    for (const [prop] of m.decls) {
      for (const s of staying) {
        if (s.media !== m.media) continue
        if (!s.decls.has(prop)) continue
        if (!eqSpec(s.specificity, m.specificity)) continue
        if (s.order <= m.order) continue // S already before M: M wins today and after — safe
        if (!mayMatchSameElement(m.selector, s.selector, coOccur)) continue
        collisions.push({ property: prop, movingSelector: m.selector, stayingSelector: s.selector, media: m.media })
      }
    }
  }
  return collisions
}
