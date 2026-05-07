import { memo, useCallback, useMemo, useState } from 'react'
import type { SessionFileDiff } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import {
  computeHunkGap,
  diffWordsInLinePair,
  inferStatus,
  parseUnifiedPatch,
  type DiffHunk,
  type DiffRow,
  type HunkGap,
  type WordDiffSegment,
} from './diff-patch-utils'

export type ViewMode = 'unified' | 'split'

// Gaps smaller than this just render hunks back-to-back — collapsing a
// 2-line "hidden" run is noise. Anything larger gets a "Show N unchanged
// lines" affordance so the user can scroll past the churn.
const HUNK_GAP_THRESHOLD = 4

function keyFragment(value: string) {
  return `${value.length}:${value.slice(0, 64)}:${value.slice(-64)}`
}

function diffRowKey(row: DiffRow) {
  return `${row.kind}:${row.oldLine ?? '-'}:${row.newLine ?? '-'}:${keyFragment(row.content)}`
}

function diffHunkKey(hunk: DiffHunk) {
  const firstRow = hunk.rows[0] ? diffRowKey(hunk.rows[0]) : 'empty'
  const lastRow = hunk.rows[hunk.rows.length - 1] ? diffRowKey(hunk.rows[hunk.rows.length - 1]!) : 'empty'
  return `${hunk.header}:${hunk.rows.length}:${firstRow}:${lastRow}`
}

export function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (next: ViewMode) => void }) {
  return (
    <div className="inline-flex rounded-md border overflow-hidden" style={{ borderColor: 'var(--color-border-subtle)' }}>
      {(['unified', 'split'] as const).map((option) => {
        const isActive = mode === option
        return (
          <button
            key={option}
            onClick={() => onChange(option)}
            className="px-2.5 py-1 text-[11px] font-medium cursor-pointer transition-colors"
            style={{
              color: isActive ? 'var(--color-text)' : 'var(--color-text-muted)',
              background: isActive ? 'var(--color-surface-active)' : 'transparent',
            }}
          >
            {option === 'unified' ? t('diff.unified', 'Unified') : t('diff.split', 'Split')}
          </button>
        )
      })}
    </div>
  )
}

export const DiffFileRow = memo(function DiffFileRow({
  sessionId,
  diff,
  expanded,
  filePath,
  onToggle,
  viewMode,
}: {
  sessionId: string
  diff: SessionFileDiff
  expanded: boolean
  filePath: string
  onToggle: (path: string) => void
  viewMode: ViewMode
}) {
  const hunks = useMemo(() => parseUnifiedPatch(diff.patch), [diff.patch])
  const status = inferStatus(hunks, diff.status)
  const handleClick = useCallback(() => { onToggle(filePath) }, [onToggle, filePath])

  return (
    <div className="border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
      <button
        onClick={handleClick}
        className="w-full text-start px-4 py-2.5 flex items-center justify-between hover:bg-surface-hover cursor-pointer transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <StatusBadge status={status} />
          <span className="text-[12px] font-mono text-text truncate">{diff.file}</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] shrink-0">
          {diff.additions > 0 && <span style={{ color: 'var(--color-green)' }}>+{diff.additions}</span>}
          {diff.deletions > 0 && <span style={{ color: 'var(--color-red)' }}>−{diff.deletions}</span>}
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3"
            style={{ transform: expanded ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }}>
            <polyline points="2.5,3.5 5,6.5 7.5,3.5" />
          </svg>
        </div>
      </button>

      {expanded && (
        <div className="pb-3 overflow-x-auto">
          {hunks.length === 0 ? (
            <div className="px-4 py-3 text-[11px] text-text-muted">
              {t('diff.noTextual', 'No textual diff available (binary file, rename, or whitespace-only change).')}
            </div>
          ) : (
            <div className="font-mono text-[11px] leading-relaxed">
              {hunks.map((hunk, i) => {
                const prev = i > 0 ? hunks[i - 1] : null
                const gap = prev ? computeHunkGap(prev, hunk) : null
                const gapBig = gap && gap.hiddenLines >= HUNK_GAP_THRESHOLD
                return (
                  <div key={diffHunkKey(hunk)}>
                    {gapBig ? (
                      <HunkGapRow
                        sessionId={sessionId}
                        filePath={filePath}
                        gap={gap}
                      />
                    ) : null}
                    {viewMode === 'unified'
                      ? <UnifiedHunkBlock hunk={hunk} />
                      : <SplitHunkBlock hunk={hunk} />}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
})

// Columns reused across both views so gutters align regardless of mode.
const OLD_GUTTER = 44
const MARKER_COL = 14

function UnifiedHunkBlock({ hunk }: { hunk: DiffHunk }) {
  // Walk rows pairwise so adjacent -/+ can be rendered with intra-line
  // highlighting on both sides. Pure adds and pure removes stay block
  // red/green — there's no partner to diff against.
  const pairs = useMemo(() => pairAdjacentChanges(hunk.rows), [hunk.rows])
  return (
    <div className="mt-2">
      <div
        className="px-4 py-1 text-[10px] font-mono text-text-muted"
        style={{ background: 'var(--color-surface-hover)' }}
      >
        {hunk.header}
      </div>
      <div>
        {pairs.map((entry) => {
          if (entry.kind === 'pair') {
            const wordDiff = diffWordsInLinePair(entry.remove.content, entry.add.content)
            return (
              <div key={`pair:${diffRowKey(entry.remove)}:${diffRowKey(entry.add)}`}>
                <UnifiedRow row={entry.remove} segments={wordDiff.removedSegments} />
                <UnifiedRow row={entry.add} segments={wordDiff.addedSegments} />
              </div>
            )
          }
          return <UnifiedRow key={`single:${diffRowKey(entry.row)}`} row={entry.row} />
        })}
      </div>
    </div>
  )
}

function UnifiedRow({ row, segments }: { row: DiffRow; segments?: WordDiffSegment[] }) {
  const background = row.kind === 'add'
    ? 'color-mix(in srgb, var(--color-green) 10%, transparent)'
    : row.kind === 'remove'
      ? 'color-mix(in srgb, var(--color-red) 10%, transparent)'
      : 'transparent'
  const baseColor = row.kind === 'add'
    ? 'var(--color-green)'
    : row.kind === 'remove'
      ? 'var(--color-red)'
      : 'var(--color-text-secondary)'
  const marker = row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '
  return (
    <div style={{ background }} className="flex">
      <LineNumberCell value={row.oldLine} />
      <LineNumberCell value={row.newLine} />
      <span className="shrink-0 text-center select-none" style={{ width: MARKER_COL, color: baseColor }}>{marker}</span>
      <span className="whitespace-pre pr-4" style={{ color: baseColor }}>
        {segments ? renderSegments(segments, row.kind) : row.content}
      </span>
    </div>
  )
}

function SplitHunkBlock({ hunk }: { hunk: DiffHunk }) {
  const columns = useMemo(() => alignForSplit(hunk.rows), [hunk.rows])
  return (
    <div className="mt-2">
      <div
        className="px-4 py-1 text-[10px] font-mono text-text-muted"
        style={{ background: 'var(--color-surface-hover)' }}
      >
        {hunk.header}
      </div>
      <div>
        {columns.map((entry) => (
          <SplitRowPair
            key={`split:${entry.left ? diffRowKey(entry.left) : 'blank'}:${entry.right ? diffRowKey(entry.right) : 'blank'}`}
            entry={entry}
          />
        ))}
      </div>
    </div>
  )
}

function SplitRowPair({ entry }: { entry: SplitPair }) {
  // Compute optional intra-line segments when both sides are a real
  // edit — a pure add-only or remove-only pair can't meaningfully word
  // diff against whitespace.
  const wordDiff = entry.left?.kind === 'remove' && entry.right?.kind === 'add'
    ? diffWordsInLinePair(entry.left.content, entry.right.content)
    : null
  return (
    <div className="flex">
      <SplitSide row={entry.left} side="left" segments={wordDiff?.removedSegments} />
      <SplitSide row={entry.right} side="right" segments={wordDiff?.addedSegments} />
    </div>
  )
}

function SplitSide({
  row,
  side,
  segments,
}: {
  row: DiffRow | null
  side: 'left' | 'right'
  segments?: WordDiffSegment[]
}) {
  const isLeft = side === 'left'
  // Empty cell: show a muted diagonal stripe so the unbalanced hunk
  // reads as an intentional gap rather than a rendering glitch.
  const emptyBackground = 'repeating-linear-gradient(-45deg, transparent 0 6px, color-mix(in srgb, var(--color-text-muted) 8%, transparent) 6px 7px)'

  if (!row) {
    return (
      <div
        className="flex-1 basis-1/2 min-w-0 flex"
        style={{
          background: emptyBackground,
          borderRight: isLeft ? '1px solid var(--color-border-subtle)' : 'none',
        }}
      >
        <LineNumberCell value={null} />
        <span className="shrink-0 text-center select-none" style={{ width: MARKER_COL }}> </span>
        <span className="flex-1" />
      </div>
    )
  }

  const background = row.kind === 'add'
    ? 'color-mix(in srgb, var(--color-green) 10%, transparent)'
    : row.kind === 'remove'
      ? 'color-mix(in srgb, var(--color-red) 10%, transparent)'
      : 'transparent'
  const baseColor = row.kind === 'add'
    ? 'var(--color-green)'
    : row.kind === 'remove'
      ? 'var(--color-red)'
      : 'var(--color-text-secondary)'
  const marker = row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '
  const lineNumber = isLeft ? row.oldLine : row.newLine

  return (
    <div
      className="flex-1 basis-1/2 min-w-0 flex overflow-hidden"
      style={{
        background,
        borderRight: isLeft ? '1px solid var(--color-border-subtle)' : 'none',
      }}
    >
      <LineNumberCell value={lineNumber} />
      <span className="shrink-0 text-center select-none" style={{ width: MARKER_COL, color: baseColor }}>{marker}</span>
      <span className="whitespace-pre pr-4 truncate" style={{ color: baseColor }}>
        {segments ? renderSegments(segments, row.kind) : row.content}
      </span>
    </div>
  )
}

function LineNumberCell({ value }: { value: number | null }) {
  return (
    <span
      className="shrink-0 text-right text-text-muted select-none"
      style={{ width: OLD_GUTTER, paddingRight: 6 }}
    >
      {value ?? ''}
    </span>
  )
}

function renderSegments(segments: WordDiffSegment[], ownedKind: 'remove' | 'add' | 'context') {
  let offset = 0
  return segments.map((segment) => {
    const key = `${segment.kind}:${offset}:${keyFragment(segment.text)}`
    offset += segment.text.length
    if (segment.kind === 'same') return <span key={key}>{segment.text}</span>
    // Only render our own side's changed segments as emphasized — the
    // cross-side segment is ignored so we don't leak highlight onto
    // an incorrect side.
    if (ownedKind === 'remove' && segment.kind === 'removed') {
      return (
        <span
          key={key}
          style={{
            background: 'color-mix(in srgb, var(--color-red) 24%, transparent)',
            fontWeight: 600,
          }}
        >
          {segment.text}
        </span>
      )
    }
    if (ownedKind === 'add' && segment.kind === 'added') {
      return (
        <span
          key={key}
          style={{
            background: 'color-mix(in srgb, var(--color-green) 24%, transparent)',
            fontWeight: 600,
          }}
        >
          {segment.text}
        </span>
      )
    }
    return null
  })
}

type SplitPair = { left: DiffRow | null; right: DiffRow | null }

// Align removes and adds into side-by-side columns. Context rows appear
// on both sides at the same row. Removes and adds pair up when they're
// adjacent (matching the unified intra-line pairing), otherwise they
// leave the opposite column blank.
function alignForSplit(rows: DiffRow[]): SplitPair[] {
  const out: SplitPair[] = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]!
    if (row.kind === 'context') {
      out.push({ left: row, right: row })
      i += 1
      continue
    }
    // Collect a run of alternating removes/adds and pair them off in
    // order. This mirrors how unified-diff tools group a single logical
    // edit into -/+ blocks.
    const removes: DiffRow[] = []
    const adds: DiffRow[] = []
    while (i < rows.length && (rows[i]!.kind === 'remove' || rows[i]!.kind === 'add')) {
      if (rows[i]!.kind === 'remove') removes.push(rows[i]!)
      else adds.push(rows[i]!)
      i += 1
    }
    const pairCount = Math.max(removes.length, adds.length)
    for (let p = 0; p < pairCount; p += 1) {
      out.push({
        left: removes[p] || null,
        right: adds[p] || null,
      })
    }
  }
  return out
}

type UnifiedEntry =
  | { kind: 'pair'; remove: DiffRow; add: DiffRow }
  | { kind: 'single'; row: DiffRow }

// Walk rows and emit a pair when a remove is immediately followed by an
// add (typical edit). Otherwise emit a single. The pairing is only
// used to scope intra-line highlighting; line order is preserved.
function pairAdjacentChanges(rows: DiffRow[]): UnifiedEntry[] {
  const out: UnifiedEntry[] = []
  let i = 0
  while (i < rows.length) {
    const current = rows[i]!
    const next = rows[i + 1]
    if (current.kind === 'remove' && next?.kind === 'add') {
      out.push({ kind: 'pair', remove: current, add: next })
      i += 2
      continue
    }
    out.push({ kind: 'single', row: current })
    i += 1
  }
  return out
}

function HunkGapRow({
  sessionId,
  filePath,
  gap,
}: {
  sessionId: string
  filePath: string
  gap: HunkGap
}) {
  const [expanded, setExpanded] = useState(false)
  const [snippet, setSnippet] = useState<string[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onExpand = async () => {
    if (loading || expanded) return
    setLoading(true)
    setError(null)
    try {
      const lines = await window.coworkApi.session.fileSnippet({
        sessionId,
        filePath,
        startLine: gap.startNewLine,
        endLine: gap.endNewLine,
      })
      setSnippet(lines)
      setExpanded(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('diff.couldNotLoad', 'Could not load file content'))
    } finally {
      setLoading(false)
    }
  }

  if (expanded && snippet) {
    return (
      <div>
        {snippet.map((content, snippetOffset) => {
          const oldLine = gap.startOldLine + snippetOffset
          const newLine = gap.startNewLine + snippetOffset
          return (
            <div key={`snippet:${oldLine}:${newLine}`} className="flex">
              <LineNumberCell value={oldLine} />
              <LineNumberCell value={newLine} />
              <span className="shrink-0 text-center select-none" style={{ width: MARKER_COL }}> </span>
              <span className="whitespace-pre pr-4" style={{ color: 'var(--color-text-secondary)' }}>{content}</span>
            </div>
          )
        })}
        <button
          onClick={() => setExpanded(false)}
          className="w-full text-center text-[10px] py-1 text-text-muted hover:text-text cursor-pointer"
          style={{ background: 'var(--color-surface-hover)' }}
        >
          {t('diff.collapse', 'Collapse')}
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={() => void onExpand()}
      disabled={loading}
      className="w-full flex items-center justify-center gap-2 py-1 text-[10px] text-text-muted hover:text-text cursor-pointer transition-colors"
      style={{ background: 'var(--color-surface-hover)' }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3">
        <polyline points="2.5,4 5,6.5 7.5,4" />
      </svg>
      <span>
        {loading
          ? t('common.loading', 'Loading…')
          : error
            ? t('diff.couldNotLoadWithError', 'Could not load: {{error}}', { error })
            : t('diff.showHiddenLines', 'Show {{count}} unchanged line(s)', { count: String(gap.hiddenLines) })}
      </span>
    </button>
  )
}

function StatusBadge({ status }: { status: 'added' | 'deleted' | 'modified' }) {
  const label = status === 'added' ? t('diff.statusNew', 'New') : status === 'deleted' ? t('diff.statusDeleted', 'Deleted') : t('diff.statusModified', 'Modified')
  const color = status === 'added'
    ? 'var(--color-green)'
    : status === 'deleted'
      ? 'var(--color-red)'
      : 'var(--color-accent)'
  return (
    <span
      className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium uppercase tracking-[0.04em]"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
    >
      {label}
    </span>
  )
}
