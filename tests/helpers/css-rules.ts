// A small, dependency-free CSS rule extractor for the studio-surface regression
// net. It parses a CSS string into a normalized map of `selector -> sorted
// declaration string`, expanding grouped selectors and namespacing rules nested
// inside @media/@supports by their prelude — so a CSS reorganization (e.g.
// single-sourcing a surface, which may split grouped rules) can be proven
// output-preserving by comparing the extracted rule maps before and after.

function matchBrace(css: string, open: number): number {
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return css.length
}

function normalizeDeclarations(inner: string): string {
  return inner
    .split(';')
    .map((decl) => decl.trim())
    .filter(Boolean)
    .map((decl) => {
      const colon = decl.indexOf(':')
      if (colon === -1) return decl
      const prop = decl.slice(0, colon).trim()
      const value = decl.slice(colon + 1).trim().replace(/\s+/g, ' ')
      return `${prop}: ${value}`
    })
    .sort()
    .join('; ')
}

function parseBlock(css: string, prefix: string, rules: Map<string, string>): void {
  let i = 0
  while (i < css.length) {
    const braceOpen = css.indexOf('{', i)
    if (braceOpen === -1) break
    const prelude = css.slice(i, braceOpen).trim()
    const close = matchBrace(css, braceOpen)
    const inner = css.slice(braceOpen + 1, close)
    if (prelude.startsWith('@media') || prelude.startsWith('@supports')) {
      parseBlock(inner, `${prelude.replace(/\s+/g, ' ')} `, rules)
    } else if (prelude.startsWith('@')) {
      // @keyframes / @font-face etc. — keep opaque, keyed by prelude.
      rules.set(`${prefix}${prelude.replace(/\s+/g, ' ')}`, inner.trim().replace(/\s+/g, ' '))
    } else {
      const declarations = normalizeDeclarations(inner)
      for (const selector of prelude.split(',').map((entry) => entry.trim()).filter(Boolean)) {
        rules.set(`${prefix}${selector}`, declarations)
      }
    }
    i = close + 1
  }
}

export function extractCssRules(css: string): Map<string, string> {
  const rules = new Map<string, string>()
  parseBlock(css.replace(/\/\*[\s\S]*?\*\//g, ''), '', rules)
  return rules
}

/** Extract only the rules whose (media-namespaced) selector starts with one of the given prefixes. */
export function extractCssRulesForPrefixes(css: string, prefixes: readonly string[]): Map<string, string> {
  const all = extractCssRules(css)
  const filtered = new Map<string, string>()
  for (const [selector, declarations] of all) {
    const bare = selector.includes('} ') ? selector.slice(selector.lastIndexOf('} ') + 2) : selector
    const tail = bare.replace(/^@[^{]+\{?\s*/, '')
    if (prefixes.some((prefix) => tail.includes(prefix))) filtered.set(selector, declarations)
  }
  return filtered
}
