import { useState, useEffect, useMemo } from 'react'
import type { SessionFileDiff } from '@open-cowork/shared'
import { inferStatus, parseUnifiedPatch, type DiffHunk } from './diff-patch-utils'

interface Props {
  sessionId: string
  // When present, scopes the diff to changes introduced by a single message
  // (uses SDK session.diff?messageID=). Header label reflects the scope.
  messageId?: string
  onClose: () => void
}

export function DiffViewer({ sessionId, messageId, onClose }: Props) {
  const [diffs, setDiffs] = useState<SessionFileDiff[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedFile, setExpandedFile] = useState<string | null>(null)

  useEffect(() => {
    window.openCowork.session.diff(sessionId, messageId)
      .then((data) => {
        setDiffs(data || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [sessionId, messageId])

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div
        className="fixed top-[8%] left-1/2 -translate-x-1/2 z-50 w-[860px] max-w-[95vw] max-h-[85vh] rounded-xl shadow-2xl overflow-hidden flex flex-col theme-popover"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <div>
            <div className="text-[14px] font-semibold text-text">
              {messageId ? 'Changes from this message' : 'Changes'}
            </div>
            {!loading && (
              <div className="text-[11px] text-text-muted mt-0.5">
                {diffs.length} file{diffs.length !== 1 ? 's' : ''} changed
              </div>
            )}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text cursor-pointer text-[18px] leading-none">&times;</button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="px-4 py-8 text-[12px] text-text-muted text-center">Loading changes...</div>
          )}

          {!loading && diffs.length === 0 && (
            <div className="px-4 py-8 text-[12px] text-text-muted text-center">No file changes in this session</div>
          )}

          {diffs.map((diff) => (
            <DiffFileRow
              key={diff.file}
              diff={diff}
              expanded={expandedFile === diff.file}
              onToggle={() => setExpandedFile(expandedFile === diff.file ? null : diff.file)}
            />
          ))}
        </div>
      </div>
    </>
  )
}

function DiffFileRow({
  diff,
  expanded,
  onToggle,
}: {
  diff: SessionFileDiff
  expanded: boolean
  onToggle: () => void
}) {
  const hunks = useMemo(() => parseUnifiedPatch(diff.patch), [diff.patch])
  const status = inferStatus(hunks, diff.status)

  return (
    <div className="border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
      <button
        onClick={onToggle}
        className="w-full text-left px-4 py-2.5 flex items-center justify-between hover:bg-surface-hover cursor-pointer transition-colors"
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
              No textual diff available (binary file, rename, or whitespace-only change).
            </div>
          ) : (
            <div className="font-mono text-[11px] leading-relaxed">
              {hunks.map((hunk, i) => (
                <HunkBlock key={i} hunk={hunk} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function HunkBlock({ hunk }: { hunk: DiffHunk }) {
  return (
    <div className="mt-2">
      <div
        className="px-4 py-1 text-[10px] font-mono text-text-muted"
        style={{ background: 'var(--color-surface-hover)' }}
      >
        {hunk.header}
      </div>
      <div>
        {hunk.rows.map((row, i) => {
          const background = row.kind === 'add'
            ? 'color-mix(in srgb, var(--color-green) 10%, transparent)'
            : row.kind === 'remove'
              ? 'color-mix(in srgb, var(--color-red) 10%, transparent)'
              : 'transparent'
          const color = row.kind === 'add'
            ? 'var(--color-green)'
            : row.kind === 'remove'
              ? 'var(--color-red)'
              : 'var(--color-text-secondary)'
          const marker = row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '
          return (
            <div key={i} style={{ background }} className="flex">
              <span
                className="shrink-0 text-right text-text-muted select-none"
                style={{ width: 44, paddingRight: 6 }}
              >
                {row.oldLine ?? ''}
              </span>
              <span
                className="shrink-0 text-right text-text-muted select-none"
                style={{ width: 44, paddingRight: 6 }}
              >
                {row.newLine ?? ''}
              </span>
              <span
                className="shrink-0 text-center select-none"
                style={{ width: 14, color }}
              >
                {marker}
              </span>
              <span className="whitespace-pre pr-4" style={{ color }}>{row.content}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: 'added' | 'deleted' | 'modified' }) {
  const label = status === 'added' ? 'New' : status === 'deleted' ? 'Deleted' : 'Modified'
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
