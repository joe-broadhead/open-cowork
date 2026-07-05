import { useMemo } from 'react'
import { renderMarkdownToSafeHtml } from './markdown-render'

// Static markdown renderer for non-streaming surfaces (e.g. Capabilities skill
// content and skill-bundle files). Renders through the same marked + DOMPurify
// core as the chat (markdown-render.ts), so the app ships a single markdown
// engine instead of a second react-markdown/remark stack (audit BUNDLE-2). The
// HTML is sanitized before it reaches dangerouslySetInnerHTML.
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdownToSafeHtml(text), [text])
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
}
