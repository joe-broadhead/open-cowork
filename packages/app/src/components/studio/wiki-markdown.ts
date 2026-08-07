/**
 * Wiki surface markdown helpers.
 *
 * Wiki pages use OpenWiki wikilinks (`[[Target Page]]`, `[[Target Page#anchor]]`,
 * `[[Target Page|alias]]`, or `[[page:id:...]]`). The stock chat markdown renderer
 * (marked + DOMPurify) has no idea what a wikilink is, so before rendering we
 * rewrite wikilinks into safe, in-app anchors. The Wiki surface passes the
 * rewritten markdown into <MarkdownContent rewrite=... /> and resolves clicks
 * through its onInternalLink callback.
 *
 * Unresolved links are still interactive: they render as dimmed anchors that can
 * open a search when clicked (the surface decides what to do).
 */

/** Wikilink: [[target]], [[target#anchor]], [[target|alias]], [[target#anchor|alias]]. */
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Rewrite `[[...]]` wikilinks into clickable anchors.
 *
 * `resolve` maps a raw wikilink target to a page id (or null when unresolved).
 */
export function rewriteWikiWikilinks(
  markdown: string,
  resolve: (target: string) => string | null,
): string {
  if (!markdown || !markdown.includes('[[')) return markdown
  return markdown.replace(WIKILINK_RE, (full, rawTarget: string, anchor?: string, alias?: string) => {
    const target = String(rawTarget ?? '').trim()
    const resolved = resolve(target)
    const text = (alias || anchor || target).trim()
    const safeText = escapeAttr(text)
    if (resolved) {
      return `<a href="#wiki-${encodeURIComponent(resolved)}" data-wiki-link="${escapeAttr(resolved)}"${
        alias ? ` data-wiki-alias="1"` : ''
      } class="wiki-internal-link">${safeText}</a>`
    }
    return `<a href="#wiki-unresolved" data-wiki-link-unresolved="${escapeAttr(target)}" class="wiki-unresolved-link">[[${safeText}]]</a>`
  })
}

/** Unique page titles/ids from a page index, for resolving wikilink targets. */
export function buildWikilinkResolver(
  pages: ReadonlyArray<{ id: string; title: string; path: string }>,
): (target: string) => string | null {
  const byId = new Map<string, string>()
  const byTitle = new Map<string, string>()
  const byPath = new Map<string, string>()
  for (const page of pages) {
    if (!byId.has(page.id)) byId.set(page.id, page.id)
    if (page.title) {
      const k = page.title.trim().toLowerCase()
      if (!byTitle.has(k)) byTitle.set(k, page.id)
    }
    if (page.path) {
      const k = page.path.toLowerCase()
      if (!byPath.has(k)) byPath.set(k, page.id)
      const base = page.path.split('/').pop() ?? ''
      if (base) {
        const baseKey = base.toLowerCase().replace(/\.md$/, '')
        if (!byTitle.has(baseKey)) byTitle.set(baseKey, page.id)
      }
    }
  }
  return (target: string) => {
    const t = target.trim()
    if (!t) return null
    if (byId.has(t)) return byId.get(t)!
    const k = t.toLowerCase()
    if (byTitle.has(k)) return byTitle.get(k)!
    if (byPath.has(k)) return byPath.get(k)!
    // last-chance: title contains match, prefer exact-ish
    if (byTitle.size > 0) {
      const match = byTitle.get(k) ?? byTitle.get(k.replace(/-+/g, ' ')) ?? null
      if (match) return match
    }
    return null
  }
}
