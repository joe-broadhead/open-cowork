import { createHash } from "node:crypto";
import { renderMarkdown } from "@openwiki/web";

const MARKDOWN_HTML_CACHE_LIMIT = 512;
const markdownHtmlCache = new Map<string, string>();

export function markdownToHtml(markdown: string): string {
  const key = createHash("sha256").update(markdown).digest("base64url");
  const cached = markdownHtmlCache.get(key);
  if (cached !== undefined) {
    markdownHtmlCache.delete(key);
    markdownHtmlCache.set(key, cached);
    return cached;
  }
  const html = renderMarkdown(markdown).html;
  markdownHtmlCache.set(key, html);
  if (markdownHtmlCache.size > MARKDOWN_HTML_CACHE_LIMIT) {
    const oldest = markdownHtmlCache.keys().next().value;
    if (oldest !== undefined) {
      markdownHtmlCache.delete(oldest);
    }
  }
  return html;
}

export function markdownHtmlCacheSize(): number {
  return markdownHtmlCache.size;
}
