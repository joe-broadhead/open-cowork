import { memo, useCallback, useMemo } from 'react'
import type { SessionFileDiff } from '@open-cowork/shared'
import { t } from '../../helpers/i18n'
import {
  computeHunkGap,
  inferStatus,
  parseUnifiedPatch,
} from './diff-patch-utils'
import {
  diffHunkKey,
  HunkGapRow,
  SplitHunkBlock,
  StatusBadge,
  UnifiedHunkBlock,
} from './DiffViewerRowBlocks'

export type ViewMode = 'unified' | 'split'

// Gaps smaller than this just render hunks back-to-back — collapsing a
// 2-line "hidden" run is noise. Anything larger gets a "Show N unchanged
// lines" affordance so the user can scroll past the churn.
const HUNK_GAP_THRESHOLD = 4

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
