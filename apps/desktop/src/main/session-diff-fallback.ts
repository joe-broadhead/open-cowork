import type {
  SessionChangeSummary,
  SessionFileDiff,
  SessionView,
  ToolCall,
} from '@open-cowork/shared'
import { relative, resolve } from 'path'
import { readTextFileCheckedSync } from './fs-read.ts'

const WRITE_LIKE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'str_replace', 'apply_patch'])
const MAX_SYNTHETIC_DIFF_BYTES = 256 * 1024

type SessionArtifactCandidate = {
  filePath: string
  order: number
}

const SESSION_DIFF_STATUSES = new Set<NonNullable<SessionFileDiff['status']>>(['added', 'deleted', 'modified'])

function normalizeSessionDiffStatus(status: unknown): SessionFileDiff['status'] | undefined {
  return typeof status === 'string' && SESSION_DIFF_STATUSES.has(status as NonNullable<SessionFileDiff['status']>)
    ? status as NonNullable<SessionFileDiff['status']>
    : undefined
}

function normalizeSessionDiffNumber(value: unknown) {
  const next = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(next) ? Math.max(0, Math.trunc(next)) : 0
}

function normalizeSessionFileDiff(value: unknown): SessionFileDiff | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const file = typeof record.file === 'string' ? record.file.trim() : ''
  if (!file) return null
  const status = normalizeSessionDiffStatus(record.status)

  return {
    file,
    patch: typeof record.patch === 'string' ? record.patch : '',
    additions: normalizeSessionDiffNumber(record.additions),
    deletions: normalizeSessionDiffNumber(record.deletions),
    source: 'sdk',
    ...(status ? { status } : {}),
  }
}

export function normalizeSessionFileDiffs(values: readonly unknown[]): SessionFileDiff[] {
  return values
    .map((value) => normalizeSessionFileDiff(value))
    .filter((value): value is SessionFileDiff => Boolean(value))
}

function artifactPathFromTool(tool: ToolCall): string | null {
  if (!WRITE_LIKE_TOOLS.has(tool.name)) return null
  const input = tool.input || {}
  const candidate = typeof input.filePath === 'string'
    ? input.filePath
    : typeof input.path === 'string'
      ? input.path
      : null
  return candidate && candidate.startsWith('/') ? candidate : null
}

function collectWriteArtifacts(view: SessionView): SessionArtifactCandidate[] {
  const latestByPath = new Map<string, SessionArtifactCandidate>()
  const maybeAdd = (tool: ToolCall) => {
    const filePath = artifactPathFromTool(tool)
    if (!filePath) return
    const existing = latestByPath.get(filePath)
    if (!existing || tool.order > existing.order) {
      latestByPath.set(filePath, { filePath, order: tool.order })
    }
  }

  for (const tool of view.toolCalls) maybeAdd(tool)
  for (const taskRun of view.taskRuns) {
    for (const tool of taskRun.toolCalls) maybeAdd(tool)
  }

  return Array.from(latestByPath.values()).sort((left, right) => right.order - left.order)
}

function isContainedPath(rootDir: string, absolutePath: string) {
  const realRoot = resolve(rootDir)
  const realPath = resolve(absolutePath)
  return realPath === realRoot || realPath.startsWith(`${realRoot}/`)
}

function toDisplayPath(rootDir: string, absolutePath: string) {
  const display = relative(rootDir, absolutePath)
  return display && !display.startsWith('..') && display !== '' ? display : absolutePath
}

function buildAddedFilePatch(contents: string) {
  const trimmed = contents.endsWith('\n') ? contents.slice(0, -1) : contents
  if (!trimmed) return { patch: '', additions: 0 }
  const lines = trimmed.split('\n')
  return {
    patch: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n'),
    additions: lines.length,
  }
}

function buildSyntheticDiff(rootDir: string, candidate: SessionArtifactCandidate): SessionFileDiff | null {
  const absolutePath = resolve(candidate.filePath)
  if (!isContainedPath(rootDir, absolutePath)) return null
  let contents: string
  try {
    const file = readTextFileCheckedSync(absolutePath, { maxBytes: MAX_SYNTHETIC_DIFF_BYTES })
    contents = file.content
  } catch (error) {
    if ((error as Error).name !== 'FileTooLargeError') return null
    return {
      file: toDisplayPath(rootDir, absolutePath),
      patch: '',
      additions: 0,
      deletions: 0,
      status: 'added',
      source: 'synthetic',
      synthetic: true,
    }
  }

  if (contents.includes('\u0000')) {
    return {
      file: toDisplayPath(rootDir, absolutePath),
      patch: '',
      additions: 0,
      deletions: 0,
      status: 'added',
      source: 'synthetic',
      synthetic: true,
    }
  }

  const { patch, additions } = buildAddedFilePatch(contents)
  return {
    file: toDisplayPath(rootDir, absolutePath),
    patch,
    additions,
    deletions: 0,
    status: 'added',
    source: 'synthetic',
    synthetic: true,
  }
}

export function buildSyntheticSessionDiffs(view: SessionView, rootDir: string): SessionFileDiff[] {
  return collectWriteArtifacts(view)
    .map((candidate) => buildSyntheticDiff(rootDir, candidate))
    .filter((entry): entry is SessionFileDiff => Boolean(entry))
}

export function mergeSessionDiffsWithSynthetic(
  sdkDiffs: SessionFileDiff[],
  view: SessionView,
  rootDir: string,
): SessionFileDiff[] {
  const merged = [...sdkDiffs]
  const seenFiles = new Set(sdkDiffs.map((diff) => diff.file))

  for (const synthetic of buildSyntheticSessionDiffs(view, rootDir)) {
    if (seenFiles.has(synthetic.file)) continue
    seenFiles.add(synthetic.file)
    merged.push(synthetic)
  }

  return merged
}

export function summarizeSessionDiffs(diffs: SessionFileDiff[]): SessionChangeSummary | null {
  if (diffs.length === 0) return null
  const syntheticFiles = diffs.filter((diff) => diff.synthetic || diff.source === 'synthetic').length

  const summary = diffs.reduce<SessionChangeSummary>((current, diff) => ({
    additions: current.additions + diff.additions,
    deletions: current.deletions + diff.deletions,
    files: current.files + 1,
  }), {
    additions: 0,
    deletions: 0,
    files: 0,
  })
  return syntheticFiles > 0
    ? {
        ...summary,
        source: syntheticFiles === diffs.length ? 'synthetic' : 'mixed',
        synthetic: true,
      }
    : summary
}
