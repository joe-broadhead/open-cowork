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

function countTableCells(row: string) {
  const trimmed = row.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null

  let pipes = 0
  let escaped = false
  for (const char of trimmed) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '|') pipes += 1
  }

  return pipes >= 2 ? pipes - 1 : null
}

function readTableSeparatorRow(source: string) {
  if (!source.startsWith('|')) return null

  let cursor = 1
  let cells = 0
  let end = -1
  while (cursor < source.length) {
    const pipe = source.indexOf('|', cursor)
    if (pipe < 0) break
    const cell = source.slice(cursor, pipe).trim()
    if (!/^:?-{3,}:?$/.test(cell)) break
    cells += 1
    end = pipe + 1
    cursor = pipe + 1
  }

  if (cells === 0 || end < 0) return null
  return {
    cells,
    row: source.slice(0, end).trim(),
    rest: source.slice(end).trimStart(),
  }
}

function readCollapsedTableRows(source: string, cells: number) {
  const rows: string[] = []
  let cursor = 0

  while (cursor < source.length) {
    while (cursor < source.length && /[ \t]/.test(source[cursor] ?? '')) cursor += 1
    if (cursor >= source.length) break
    if (source[cursor] !== '|') return null

    let pipes = 0
    let escaped = false
    let end = -1
    for (let index = cursor; index < source.length; index += 1) {
      const char = source[index]
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char !== '|') continue
      pipes += 1
      if (pipes === cells + 1) {
        end = index + 1
        break
      }
    }

    if (end < 0) return null
    const row = source.slice(cursor, end).trim()
    if (countTableCells(row) !== cells) return null
    rows.push(row)
    cursor = end
  }

  return rows.length > 0 ? rows : null
}

function isTableSeparatorLine(line: string) {
  const trimmed = line.trim()
  const cells = countTableCells(trimmed)
  if (!cells) return false
  const body = trimmed.slice(1, -1)
  return body.split('|').every((cell) => /^:?-{3,}:?$/.test(cell.trim()))
}

function looksLikeTableHeader(line: string) {
  return /^[ \t]*\|/.test(line) && /[A-Za-z]/.test(line.replace(/\\\|/g, ''))
}

function separatorForTableRow(line: string, cells: number) {
  const leading = line.match(/^\s*/)?.[0] ?? ''
  return `${leading}| ${Array.from({ length: cells }, () => '---').join(' | ')} |`
}

function normalizeCollapsedTableLine(line: string) {
  const leading = line.match(/^\s*/)?.[0] ?? ''
  const content = line.slice(leading.length)
  if (!content.startsWith('|') || !content.includes('---')) return line

  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '|') continue
    const separatorCandidate = content.slice(index + 1)
    const whitespace = separatorCandidate.match(/^[ \t]+/)
    if (!whitespace) continue
    const rest = separatorCandidate.slice(whitespace[0].length)
    const separator = readTableSeparatorRow(rest)
    if (!separator) continue

    const header = content.slice(0, index + 1).trim()
    if (countTableCells(header) !== separator.cells) continue

    const rows = readCollapsedTableRows(separator.rest, separator.cells)
    if (!rows) return line

    return [
      header,
      separator.row,
      ...rows,
    ].map((row) => `${leading}${row}`).join('\n')
  }

  return line
}

function normalizeMissingSeparatorTableLines(text: string) {
  if (!text.includes('|')) return text

  const lines = text.split('\n')
  const out: string[] = []
  let openFence: FenceMatch | null = null
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''

    if (openFence) {
      out.push(line)
      if (matchFenceClose(line, openFence.char, openFence.size)) {
        openFence = null
      }
      index += 1
      continue
    }

    const fence = matchFenceOpen(line)
    if (fence) {
      openFence = fence
      out.push(line)
      index += 1
      continue
    }

    const cells = countTableCells(line)
    const next = lines[index + 1] ?? ''
    const nextCells = countTableCells(next)
    if (
      cells
      && nextCells === cells
      && !isTableSeparatorLine(lines[index - 1] ?? '')
      && !isTableSeparatorLine(next)
      && looksLikeTableHeader(line)
    ) {
      const tableRows = [line]
      let cursor = index + 1
      while (cursor < lines.length) {
        const row = lines[cursor] ?? ''
        if (isTableSeparatorLine(row)) break
        if (countTableCells(row) !== cells) break
        tableRows.push(row)
        cursor += 1
      }

      if (tableRows.length >= 2) {
        out.push(tableRows[0] ?? line, separatorForTableRow(line, cells), ...tableRows.slice(1))
        index = cursor
        continue
      }
    }

    out.push(line)
    index += 1
  }

  return out.join('\n')
}

export function normalizeCollapsedMarkdownTables(text: string) {
  if (!text.includes('|')) return text

  const lines = text.split('\n')
  let openFence: FenceMatch | null = null

  const normalized = lines.map((line) => {
    if (openFence) {
      if (matchFenceClose(line, openFence.char, openFence.size)) {
        openFence = null
      }
      return line
    }

    const fence = matchFenceOpen(line)
    if (fence) {
      openFence = fence
      return line
    }

    return normalizeCollapsedTableLine(line)
  }).join('\n')

  return normalizeMissingSeparatorTableLines(normalized)
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
  const normalized = normalizeCollapsedMarkdownTables(normalizeFencedCodeBlocks(text))
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
