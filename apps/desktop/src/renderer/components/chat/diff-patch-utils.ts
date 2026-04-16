// Unified-diff parser for SDK SnapshotFileDiff.patch. The SDK emits git-style
// patches (one file per entry, so no "diff --git" / "+++ file" headers are
// guaranteed), produced by OpenCode's snapshot engine. We only care about
// rendering the hunks; file-name headers are already on the outer card.
//
// Output is shaped for a line-oriented renderer: each hunk carries a compact
// "@@" header string plus its rows. A row is one of add / remove / context
// with both old and new line numbers so the renderer can show a split gutter.

export type DiffRowKind = 'context' | 'add' | 'remove'

export interface DiffRow {
  kind: DiffRowKind
  oldLine: number | null
  newLine: number | null
  content: string
}

export interface DiffHunk {
  header: string
  rows: DiffRow[]
}

interface HunkHeader {
  oldStart: number
  newStart: number
  text: string
}

const HUNK_HEADER = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/

function parseHeader(line: string): HunkHeader | null {
  const match = HUNK_HEADER.exec(line)
  if (!match) return null
  return {
    oldStart: Number(match[1]),
    newStart: Number(match[2]),
    text: line,
  }
}

export function parseUnifiedPatch(patch: string): DiffHunk[] {
  if (!patch) return []
  const lines = patch.split('\n')
  const hunks: DiffHunk[] = []
  let current: { header: HunkHeader; rows: DiffRow[] } | null = null
  let oldLine = 0
  let newLine = 0

  for (const line of lines) {
    if (line.startsWith('diff --git') || line.startsWith('index ') ||
        line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue
    }
    const header = parseHeader(line)
    if (header) {
      if (current) hunks.push({ header: current.header.text, rows: current.rows })
      current = { header, rows: [] }
      oldLine = header.oldStart
      newLine = header.newStart
      continue
    }
    if (!current) continue
    if (line.startsWith('\\')) continue // e.g. "\ No newline at end of file"

    if (line.startsWith('+')) {
      current.rows.push({ kind: 'add', oldLine: null, newLine, content: line.slice(1) })
      newLine += 1
    } else if (line.startsWith('-')) {
      current.rows.push({ kind: 'remove', oldLine, newLine: null, content: line.slice(1) })
      oldLine += 1
    } else {
      // Treat bare lines and space-prefixed lines as context.
      const content = line.startsWith(' ') ? line.slice(1) : line
      current.rows.push({ kind: 'context', oldLine, newLine, content })
      oldLine += 1
      newLine += 1
    }
  }

  if (current) hunks.push({ header: current.header.text, rows: current.rows })
  return hunks
}

// Best-effort status inference when SDK didn't tag it explicitly. A patch that
// only adds lines starting from line 1 of the new file with no old-side lines
// is an add; the inverse is a delete.
export function inferStatus(hunks: DiffHunk[], explicit?: 'added' | 'deleted' | 'modified') {
  if (explicit) return explicit
  if (hunks.length === 0) return 'modified'
  const hasAdd = hunks.some((hunk) => hunk.rows.some((row) => row.kind === 'add'))
  const hasRemove = hunks.some((hunk) => hunk.rows.some((row) => row.kind === 'remove'))
  if (hasAdd && !hasRemove) return 'added'
  if (hasRemove && !hasAdd) return 'deleted'
  return 'modified'
}
