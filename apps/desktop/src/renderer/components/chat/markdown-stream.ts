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

type FenceMatch = {
  indent: string
  char: '`' | '~'
  size: number
  suffix: string
}

function matchFenceOpen(line: string): FenceMatch | null {
  const match = line.match(/^([ \t]{0,3})(`{3,}|~{3,})(.*)$/)
  if (!match) return null
  const marker = match[2]
  if (!marker) return null
  const char = marker[0]
  if (char !== '`' && char !== '~') return null
  return {
    indent: match[1] ?? '',
    char,
    size: marker.length,
    suffix: match[3] ?? '',
  }
}

function matchFenceClose(line: string, char: '`' | '~', size: number) {
  const match = line.match(new RegExp(`^([ \\t]{0,3})(${char}{${size},})[ \\t]*$`))
  if (!match) return null
  return {
    indent: match[1] ?? '',
    size: (match[2] ?? '').length,
  }
}

function leadingFenceSize(line: string, char: '`' | '~') {
  const match = line.match(new RegExp(`^[ \\t]{0,3}(${char}{3,})`))
  return match?.[1]?.length ?? 0
}

function nextMeaningfulLine(lines: string[], start: number) {
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim()
    if (trimmed) return trimmed
  }
  return null
}

function looksLikeCodeLine(line: string) {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/^(`{3,}|~{3,})/.test(trimmed)) return true
  if (/^(\/\/|\/\*|\*\/|"""|'''|[{[(]|[)}\]])/.test(trimmed)) return true
  if (/^(function|struct|class|interface|enum|def|fn|const|let|var|if|else|for|while|return|import|export|using|package|module|public|private|protected|switch|case|break|continue|try|catch|finally|end|begin)\b/.test(trimmed)) return true
  if (/^[A-Za-z_][\w.]*\s*(::|:=|=>|==|!=|<=|>=|=)\s*\S/.test(trimmed)) return true
  if (/^[A-Za-z_][\w.]*\(.*\)\s*$/.test(trimmed)) return true
  return false
}

function shouldCloseFence(lines: string[], index: number) {
  const next = nextMeaningfulLine(lines, index)
  if (!next) return true
  if (/^([`~]{3,}|#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|)/.test(next)) return true
  return !looksLikeCodeLine(next)
}

function rewriteFence(line: string, char: '`' | '~', size: number, suffix = '') {
  const indent = line.match(/^[ \t]{0,3}/)?.[0] ?? ''
  return `${indent}${char.repeat(size)}${suffix}`
}

export function normalizeFencedCodeBlocks(text: string) {
  if (!text || (!text.includes('```') && !text.includes('~~~'))) return text

  const lines = text.split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    const open = matchFenceOpen(lines[index] ?? '')
    if (!open) continue

    const suspiciousClosers: number[] = []
    let closeIndex = -1

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const close = matchFenceClose(lines[cursor] ?? '', open.char, open.size)
      if (!close) continue

      if (shouldCloseFence(lines, cursor)) {
        closeIndex = cursor
        break
      }

      suspiciousClosers.push(cursor)
    }

    if (suspiciousClosers.length === 0) {
      if (closeIndex >= 0) {
        index = closeIndex
      }
      continue
    }

    let widened = open.size
    const blockEnd = closeIndex >= 0 ? closeIndex : lines.length
    for (let cursor = index + 1; cursor < blockEnd; cursor += 1) {
      widened = Math.max(widened, leadingFenceSize(lines[cursor] ?? '', open.char))
    }
    widened += 1

    lines[index] = rewriteFence(lines[index] ?? '', open.char, widened, open.suffix)
    if (closeIndex >= 0) {
      lines[closeIndex] = rewriteFence(lines[closeIndex] ?? '', open.char, widened)
      index = closeIndex
    } else {
      break
    }
  }

  return lines.join('\n')
}

export function streamMarkdown(text: string, live: boolean): MarkdownBlock[] {
  const normalized = normalizeFencedCodeBlocks(text)
  if (!live) return [{ raw: normalized, src: normalized, mode: 'full' }]

  const healed = heal(normalized)
  if (hasReferences(normalized)) return [{ raw: normalized, src: healed, mode: 'live' }]

  const tokens = marked.lexer(normalized)
  const tail = tokens.findLastIndex((token) => token.type !== 'space')
  if (tail < 0) return [{ raw: normalized, src: healed, mode: 'live' }]

  const last = tokens[tail]
  if (!last || last.type !== 'code') return [{ raw: normalized, src: healed, mode: 'live' }]

  const code = last as Tokens.Code
  if (!hasOpenCodeFence(code.raw)) return [{ raw: normalized, src: healed, mode: 'live' }]

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
