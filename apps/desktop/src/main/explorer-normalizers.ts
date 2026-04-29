import type {
  ExplorerSymbol,
  FileContent,
  FileNode,
  FileStatus,
  TextMatch,
} from '@open-cowork/shared'
import {
  asArray,
  asRecord,
  readNumber,
  readRecordNumber,
  readRecordString,
} from './normalizer-utils.ts'

// Explorer normalizers (SDK find.* + file.*)
//
// Keep renderer callers off snake_case (`line_number`), URI tuples, and
// optional-everywhere SDK shapes. One place to update when SDK file/find
// response types drift.

export function normalizeFileNode(value: unknown): FileNode | null {
  const record = asRecord(value)
  const name = readRecordString(record, ['name'])
  const path = readRecordString(record, ['path'])
  const absolute = readRecordString(record, ['absolute'])
  const type = readRecordString(record, ['type'])
  if (!name || !path || !absolute) return null
  if (type !== 'file' && type !== 'directory') return null
  return {
    name,
    path,
    absolute,
    type,
    ignored: record.ignored === true,
  }
}

export function normalizeFileNodes(value: unknown): FileNode[] {
  return asArray(value)
    .map(normalizeFileNode)
    .filter((node): node is FileNode => node !== null)
}

export function normalizeFileContent(value: unknown): FileContent | null {
  const record = asRecord(value)
  const type = readRecordString(record, ['type'])
  if (type !== 'text' && type !== 'binary') return null
  const content = typeof record.content === 'string' ? record.content : ''
  return {
    type,
    content,
    diff: readRecordString(record, ['diff']),
    // `patch` can be an object on v2; flatten to the reconstructed unified
    // diff string when possible, otherwise fall back to the string form.
    patch: readRecordString(record, ['patch']) ?? flattenPatch(record.patch),
    encoding: readRecordString(record, ['encoding']),
  }
}

function flattenPatch(value: unknown): string | null {
  const record = asRecord(value)
  if (Object.keys(record).length === 0) return null
  const hunks = asArray(record.hunks)
  if (hunks.length === 0) return null
  const out: string[] = []
  for (const hunk of hunks) {
    const h = asRecord(hunk)
    const oldStart = readRecordNumber(h, ['oldStart']) ?? 0
    const oldLines = readRecordNumber(h, ['oldLines']) ?? 0
    const newStart = readRecordNumber(h, ['newStart']) ?? 0
    const newLines = readRecordNumber(h, ['newLines']) ?? 0
    out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`)
    for (const line of asArray(h.lines)) {
      if (typeof line === 'string') out.push(line)
    }
  }
  return out.join('\n')
}

export function normalizeFileStatus(value: unknown): FileStatus | null {
  const record = asRecord(value)
  const path = readRecordString(record, ['path'])
  if (!path) return null
  const status = readRecordString(record, ['status'])
  if (status !== 'added' && status !== 'deleted' && status !== 'modified') return null
  return {
    path,
    added: readRecordNumber(record, ['added']) ?? 0,
    removed: readRecordNumber(record, ['removed']) ?? 0,
    status,
  }
}

export function normalizeFileStatuses(value: unknown): FileStatus[] {
  return asArray(value)
    .map(normalizeFileStatus)
    .filter((entry): entry is FileStatus => entry !== null)
}

function normalizeRangePos(value: unknown) {
  const record = asRecord(value)
  return {
    line: readNumber(record.line) ?? 0,
    col: readRecordNumber(record, ['col', 'character', 'column']) ?? 0,
  }
}

export function normalizeExplorerSymbol(value: unknown): ExplorerSymbol | null {
  const record = asRecord(value)
  const name = readRecordString(record, ['name'])
  if (!name) return null
  const location = asRecord(record.location)
  const uri = readRecordString(location, ['uri']) || ''
  const path = uri.startsWith('file://') ? uri.slice('file://'.length) : uri
  const range = asRecord(location.range)
  return {
    name,
    kind: readRecordNumber(record, ['kind']) ?? 0,
    path,
    range: {
      start: normalizeRangePos(range.start),
      end: normalizeRangePos(range.end),
    },
  }
}

export function normalizeExplorerSymbols(value: unknown): ExplorerSymbol[] {
  return asArray(value)
    .map(normalizeExplorerSymbol)
    .filter((entry): entry is ExplorerSymbol => entry !== null)
}

export function normalizeTextMatch(value: unknown): TextMatch | null {
  const record = asRecord(value)
  const pathRec = asRecord(record.path)
  const path = readRecordString(pathRec, ['text'])
  if (!path) return null
  const linesRec = asRecord(record.lines)
  const lineText = readRecordString(linesRec, ['text']) ?? ''
  const lineNumber = readRecordNumber(record, ['line_number', 'lineNumber']) ?? 0
  const submatches = asArray(record.submatches).flatMap((entry) => {
    const sub = asRecord(entry)
    const match = asRecord(sub.match)
    const text = readRecordString(match, ['text'])
    const start = readRecordNumber(sub, ['start'])
    const end = readRecordNumber(sub, ['end'])
    if (text === null || start === null || end === null) return []
    return [{ text, start, end }]
  })
  return { path, lineNumber, lineText, submatches }
}

export function normalizeTextMatches(value: unknown): TextMatch[] {
  return asArray(value)
    .map(normalizeTextMatch)
    .filter((entry): entry is TextMatch => entry !== null)
}
