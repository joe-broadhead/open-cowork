import { marked, type Tokens } from 'marked'
import remend from 'remend'

export type MarkdownBlock = {
  raw: string
  src: string
  mode: 'full' | 'live'
}

function hasReferences(text: string) {
  return /^\[[^\]]+\]:\s+\S+/m.test(text) || /^\[\^[^\]]+\]:\s+/m.test(text)
}

function hasOpenCodeFence(raw: string) {
  const match = raw.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  if (!match) return false
  const marker = match[1]
  if (!marker) return false
  const char = marker[0]
  const size = marker.length
  const last = raw.trimEnd().split('\n').at(-1)?.trim() ?? ''
  return !new RegExp(`^[\\t ]{0,3}${char}{${size},}[\\t ]*$`).test(last)
}

function heal(text: string) {
  return remend(text, { linkMode: 'text-only' })
}

export function streamMarkdown(text: string, live: boolean): MarkdownBlock[] {
  if (!live) return [{ raw: text, src: text, mode: 'full' }]

  const healed = heal(text)
  if (hasReferences(text)) return [{ raw: text, src: healed, mode: 'live' }]

  const tokens = marked.lexer(text)
  const tail = tokens.findLastIndex((token) => token.type !== 'space')
  if (tail < 0) return [{ raw: text, src: healed, mode: 'live' }]

  const last = tokens[tail]
  if (!last || last.type !== 'code') return [{ raw: text, src: healed, mode: 'live' }]

  const code = last as Tokens.Code
  if (!hasOpenCodeFence(code.raw)) return [{ raw: text, src: healed, mode: 'live' }]

  const head = tokens
    .slice(0, tail)
    .map((token) => token.raw)
    .join('')

  if (!head) return [{ raw: code.raw, src: code.raw, mode: 'live' }]

  return [
    { raw: head, src: heal(head), mode: 'live' },
    { raw: code.raw, src: code.raw, mode: 'live' },
  ]
}
