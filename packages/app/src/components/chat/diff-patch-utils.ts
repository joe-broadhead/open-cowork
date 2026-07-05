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

export type WordDiffKind = 'same' | 'removed' | 'added'

export interface WordDiffSegment {
  text: string
  kind: WordDiffKind
}

// Tokenize into runs of word chars and runs of non-word chars (whitespace,
// punctuation). Keeping the separators as tokens means the LCS still aligns
// on exact structure, and the renderer can wrap segments without re-joining
// with artificial spaces.
function tokenize(line: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < line.length) {
    const isWord = /\w/.test(line[i]!)
    let j = i + 1
    while (j < line.length && /\w/.test(line[j]!) === isWord) j += 1
    out.push(line.slice(i, j))
    i = j
  }
  return out
}

// Compact LCS over tokens. We skip the classic O(nm) table when one side
// has more than ~400 tokens — pathologically long lines (minified JS,
// JSON blobs) shouldn't stall the UI. Falls back to full-line removed /
// added treatment in that case, matching the pre-intra-line behavior.
function longestCommonSubsequence(a: string[], b: string[]): number[][] | null {
  if (a.length > 400 || b.length > 400) return null
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      table[i]![j] = a[i - 1] === b[j - 1]
        ? (table[i - 1]![j - 1]! + 1)
        : Math.max(table[i - 1]![j]!, table[i]![j - 1]!)
    }
  }
  return table
}

function mergeAdjacent(segments: WordDiffSegment[]): WordDiffSegment[] {
  const out: WordDiffSegment[] = []
  for (const segment of segments) {
    const last = out[out.length - 1]
    if (last && last.kind === segment.kind) {
      last.text += segment.text
    } else {
      out.push({ ...segment })
    }
  }
  return out
}

// Produce an array of segments describing the transformation from
// `removed` to `added`. Used by the diff renderer to highlight just
// the characters that changed within adjacent -/+ lines, rather than
// painting the whole line red/green.
export function diffWordsInLinePair(removed: string, added: string): {
  removedSegments: WordDiffSegment[]
  addedSegments: WordDiffSegment[]
} {
  const a = tokenize(removed)
  const b = tokenize(added)
  const table = longestCommonSubsequence(a, b)

  if (!table) {
    // Oversized: just mark the whole line as a block change.
    return {
      removedSegments: removed ? [{ text: removed, kind: 'removed' }] : [],
      addedSegments: added ? [{ text: added, kind: 'added' }] : [],
    }
  }

  const removedSegments: WordDiffSegment[] = []
  const addedSegments: WordDiffSegment[] = []
  let i = a.length
  let j = b.length

  // Walk the LCS table backward to classify each token; push in reverse
  // then reverse-splice later so the emitted segments read left-to-right.
  const aRev: WordDiffSegment[] = []
  const bRev: WordDiffSegment[] = []
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      aRev.push({ text: a[i - 1]!, kind: 'same' })
      bRev.push({ text: b[j - 1]!, kind: 'same' })
      i -= 1
      j -= 1
    } else if (table[i - 1]![j]! >= table[i]![j - 1]!) {
      aRev.push({ text: a[i - 1]!, kind: 'removed' })
      i -= 1
    } else {
      bRev.push({ text: b[j - 1]!, kind: 'added' })
      j -= 1
    }
  }
  while (i > 0) {
    aRev.push({ text: a[i - 1]!, kind: 'removed' })
    i -= 1
  }
  while (j > 0) {
    bRev.push({ text: b[j - 1]!, kind: 'added' })
    j -= 1
  }

  for (let k = aRev.length - 1; k >= 0; k -= 1) removedSegments.push(aRev[k]!)
  for (let k = bRev.length - 1; k >= 0; k -= 1) addedSegments.push(bRev[k]!)

  return {
    removedSegments: mergeAdjacent(removedSegments),
    addedSegments: mergeAdjacent(addedSegments),
  }
}

export interface HunkGap {
  kind: 'gap'
  startOldLine: number
  endOldLine: number
  startNewLine: number
  endNewLine: number
  hiddenLines: number
}

// Compute the unchanged gap between each consecutive pair of hunks. If
// the gap is small, return null so the renderer just shows the hunks
// back-to-back; if it's big, callers can surface a "Show N lines"
// affordance whose expansion fetches the actual file contents via IPC.
export function computeHunkGap(prev: DiffHunk, next: DiffHunk): HunkGap | null {
  const prevLast = prev.rows[prev.rows.length - 1]
  const nextFirst = next.rows[0]
  if (!prevLast || !nextFirst) return null

  const prevOldEnd = typeof prevLast.oldLine === 'number' ? prevLast.oldLine : prevLast.newLine
  const prevNewEnd = typeof prevLast.newLine === 'number' ? prevLast.newLine : prevLast.oldLine
  const nextOldStart = typeof nextFirst.oldLine === 'number' ? nextFirst.oldLine : nextFirst.newLine
  const nextNewStart = typeof nextFirst.newLine === 'number' ? nextFirst.newLine : nextFirst.oldLine

  if (prevOldEnd == null || prevNewEnd == null || nextOldStart == null || nextNewStart == null) return null
  const hiddenLines = nextOldStart - prevOldEnd - 1
  if (hiddenLines <= 0) return null

  return {
    kind: 'gap',
    startOldLine: prevOldEnd + 1,
    endOldLine: nextOldStart - 1,
    startNewLine: prevNewEnd + 1,
    endNewLine: nextNewStart - 1,
    hiddenLines,
  }
}
