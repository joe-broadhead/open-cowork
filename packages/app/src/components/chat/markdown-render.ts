import DOMPurify from 'dompurify'
import { marked } from 'marked'

// Shared marked + DOMPurify markdown core. Both the streaming chat renderer
// (MarkdownContent) and the static <Markdown> component (capabilities skill
// content, bundle files) render through this single sanitizer so the security
// model — the URI allowlist, forbidden tags, and forced rel="noopener" — is
// defined once. This is also why the app ships ONE markdown engine (marked)
// rather than bundling react-markdown/remark alongside it (audit BUNDLE-2).
marked.use({ gfm: true })

const sanitizeConfig = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ['style'],
  FORBID_CONTENTS: ['style', 'script'],
  // Explicit URI allowlist (audit P2-2): http(s)/mailto/tel plus relative paths and #fragments,
  // which blocks javascript:/data:/vbscript: hrefs rather than leaning on DOMPurify's implicit default.
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/|[^:]*$)/i,
}

// Force rel="noopener noreferrer" on every anchor (audit P2-2). The widest untrusted-content surface
// (LLM/channel markdown) must not rely on Chromium's implicit noopener default for target="_blank"
// links; applying it unconditionally also can't regress same-window links (noopener only affects new
// contexts, and dropping the referrer on an external link is a privacy plus). Runs once at module load.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName === 'A') {
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

export function sanitizeHtml(html: string) {
  if (!DOMPurify.isSupported) return ''
  return DOMPurify.sanitize(html, sanitizeConfig)
}

// One-shot (non-streaming) render of a full markdown document to sanitized HTML.
// Used by the static <Markdown> component; the streaming chat path renders block
// by block in MarkdownContent but shares the same sanitizeHtml above.
export function renderMarkdownToSafeHtml(text: string) {
  if (!text) return ''
  try {
    return sanitizeHtml(marked.parse(text) as string)
  } catch {
    return ''
  }
}
