import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import DOMPurify from 'dompurify'
import morphdom from 'morphdom'
import { marked } from 'marked'
import { streamMarkdown } from './markdown-stream'
import { writeTextToClipboard } from '../../helpers/clipboard'

type CacheEntry = {
  html: string
}

const MAX_CACHE_SIZE = 200
const htmlCache = new Map<string, CacheEntry>()

marked.use({ gfm: true })

const sanitizeConfig = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ['style'],
  FORBID_CONTENTS: ['style', 'script'],
}

function touchCache(key: string, entry: CacheEntry) {
  htmlCache.delete(key)
  htmlCache.set(key, entry)
  if (htmlCache.size <= MAX_CACHE_SIZE) return
  const oldest = htmlCache.keys().next().value
  if (oldest) htmlCache.delete(oldest)
}

function sanitizeHtml(html: string) {
  if (!DOMPurify.isSupported) return ''
  return DOMPurify.sanitize(html, sanitizeConfig)
}

function escapeText(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fallbackHtml(markdown: string) {
  return escapeText(markdown)
    .replace(/\r\n?/g, '\n')
    .replace(/\n/g, '<br>')
}

const iconPaths = {
  copy: 'M6.25 6.25V2.92h10.83v10.83h-3.33M13.75 6.25v10.83H2.92V6.25h10.83Z',
  check: 'M5 11.97 8.38 14.75 15 5.83',
}

function createIcon(path: string, slot: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('data-slot', slot)
  svg.setAttribute('aria-hidden', 'true')

  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  shape.setAttribute('d', path)
  svg.appendChild(shape)
  return svg
}

function setCopyButtonState(button: HTMLButtonElement, copied: boolean) {
  const label = copied ? 'Copied' : 'Copy code'
  if (copied) button.setAttribute('data-copied', 'true')
  else button.removeAttribute('data-copied')
  button.setAttribute('aria-label', label)
  button.setAttribute('title', label)
}

function createCopyButton() {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('data-slot', 'markdown-copy-button')
  button.className = 'flex items-center justify-center'
  setCopyButtonState(button, false)
  button.appendChild(createIcon(iconPaths.copy, 'markdown-copy-icon'))
  button.appendChild(createIcon(iconPaths.check, 'markdown-check-icon'))
  return button
}

function ensureCodeWrappers(root: HTMLDivElement) {
  const blocks = Array.from(root.querySelectorAll('pre'))
  for (const block of blocks) {
    if (!(block instanceof HTMLPreElement)) continue
    const parent = block.parentElement
    if (!parent) continue
    if (parent.getAttribute('data-component') !== 'markdown-code') {
      const wrapper = document.createElement('div')
      wrapper.setAttribute('data-component', 'markdown-code')
      wrapper.className = 'relative group'
      parent.replaceChild(wrapper, block)
      wrapper.appendChild(block)
    }

    const wrapper = block.parentElement
    if (!wrapper) continue
    if (wrapper.querySelector('[data-slot="markdown-copy-button"]')) continue

    wrapper.appendChild(createCopyButton())
  }
}

function extractCodeText(button: HTMLButtonElement) {
  const code = button.closest('[data-component="markdown-code"]')?.querySelector('code')
  return code?.textContent ?? ''
}

function renderHtml(text: string, streaming: boolean) {
  if (!text) return ''

  try {
    return streamMarkdown(text, streaming)
      .map((block, index) => {
        const key = `${streaming ? 'live' : 'full'}:${index}:${block.raw}`
        const cached = htmlCache.get(key)
        if (cached) {
          touchCache(key, cached)
          return cached.html
        }

        const parsed = marked.parse(block.src) as string
        const safe = sanitizeHtml(parsed)
        touchCache(key, { html: safe })
        return safe
      })
      .join('')
  } catch {
    return fallbackHtml(text)
  }
}

export function MarkdownContent({
  text,
  className = '',
  streaming = false,
}: {
  text: string
  className?: string
  streaming?: boolean
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const html = useMemo(() => renderHtml(text, streaming), [text, streaming])

  useLayoutEffect(() => {
    const container = rootRef.current
    if (!container) return

    if (!html) {
      container.innerHTML = ''
      return
    }

    const temp = document.createElement('div')
    temp.innerHTML = html
    ensureCodeWrappers(temp)

    morphdom(container, temp, {
      childrenOnly: true,
      onBeforeElUpdated: (fromEl, toEl) => {
        if (
          fromEl instanceof HTMLButtonElement
          && toEl instanceof HTMLButtonElement
          && fromEl.getAttribute('data-slot') === 'markdown-copy-button'
          && fromEl.getAttribute('data-copied') === 'true'
        ) {
          setCopyButtonState(toEl, true)
        }

        if (fromEl.isEqualNode(toEl)) return false
        return true
      },
    })
  }, [html])

  useEffect(() => {
    const container = rootRef.current
    if (!container) return

    const handleClick = async (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest('[data-slot="markdown-copy-button"]')
      if (!(button instanceof HTMLButtonElement)) return
      const content = extractCodeText(button)
      if (!content) return
      const copied = await writeTextToClipboard(content)
      if (!copied) return
      setCopyButtonState(button, true)
      window.setTimeout(() => {
        setCopyButtonState(button, false)
      }, 2000)
    }

    container.addEventListener('click', handleClick)
    return () => {
      container.removeEventListener('click', handleClick)
    }
  }, [])

  return (
    <div
      ref={rootRef}
      data-component="markdown"
      className={`text-[13px] prose prose-p:my-1 prose-p:last:mb-0 prose-headings:my-2 prose-headings:last:mb-0 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 text-text leading-relaxed ${className}`.trim()}
    />
  )
}
