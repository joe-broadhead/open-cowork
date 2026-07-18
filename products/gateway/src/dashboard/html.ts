function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escAttr(s: unknown): string {
  return esc(s).replace(/"/g, '&quot;')
}
/**
 * Safe-by-default HTML templating.
 *
 * The dashboard is hand-rolled SSR: escaping used to be OPT-IN via esc()/escAttr()
 * at every interpolation, so a single forgotten call was a stored-XSS hole. The
 * `html` tagged template inverts that: every ${interpolation} is auto-escaped
 * with the SAME rules esc()/escAttr() apply, and trust must be explicit.
 *
 *   html`<div class="t">${userValue}</div>`     // esc(): & < >  (text context)
 *   html`<a href="${attr(userUrl)}">`           // escAttr(): & < > "  (attribute)
 *   html`<div>${trustedHtml(prebuiltMarkup)}</div>` // inserted verbatim
 *
 * A nested `html` fragment (an HtmlSafe) — or an array of them — is inserted
 * verbatim, so composing fragments never double-escapes. `HtmlSafe.toString()`
 * returns the raw markup, so an html fragment also drops cleanly into the legacy
 * raw-template-literal call sites that have not been migrated yet.
 */
class HtmlSafe {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value
  }
}

function isHtmlSafe(value: unknown): value is HtmlSafe {
  return value instanceof HtmlSafe
}

function renderHtmlValue(value: unknown): string {
  if (isHtmlSafe(value)) return value.value
  if (Array.isArray(value)) return value.map(renderHtmlValue).join('')
  return esc(value)
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): HtmlSafe {
  let out = strings[0]!
  for (let i = 0; i < values.length; i++) {
    out += renderHtmlValue(values[i]) + strings[i + 1]!
  }
  return new HtmlSafe(out)
}

/** Escape a value for a double-quoted attribute (mirrors escAttr) and mark it safe. */
export function attr(value: unknown): HtmlSafe {
  return new HtmlSafe(escAttr(value))
}

/**
 * Mark an already-built HTML string as trusted so the `html` tag inserts it
 * verbatim. Only pass markup produced by an escaping path (a legacy render*
 * helper or a controlled constant), never raw external input.
 */
export function trustedHtml(value: string): HtmlSafe {
  return new HtmlSafe(value)
}

export { esc, escAttr, HtmlSafe }
