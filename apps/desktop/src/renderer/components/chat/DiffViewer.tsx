import { useState, useEffect, type ReactElement } from 'react'

interface FileDiff {
  file: string
  before: string
  after: string
  additions: number
  deletions: number
}

interface Props {
  sessionId: string
  onClose: () => void
}

export function DiffViewer({ sessionId, onClose }: Props) {
  const [diffs, setDiffs] = useState<FileDiff[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedFile, setExpandedFile] = useState<string | null>(null)

  useEffect(() => {
    ;window.openCowork.session.diff(sessionId).then((data: FileDiff[]) => {
      setDiffs(data || [])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [sessionId])

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div
        className="fixed top-[10%] left-1/2 -translate-x-1/2 z-50 w-[700px] max-h-[75vh] rounded-xl shadow-2xl overflow-hidden flex flex-col theme-popover"
      >

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <div>
            <div className="text-[14px] font-semibold text-text">Changes</div>
            {!loading && <div className="text-[11px] text-text-muted mt-0.5">{diffs.length} file{diffs.length !== 1 ? 's' : ''} changed</div>}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text cursor-pointer text-[18px] leading-none">&times;</button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="px-4 py-8 text-[12px] text-text-muted text-center">Loading changes...</div>
          )}

          {!loading && diffs.length === 0 && (
            <div className="px-4 py-8 text-[12px] text-text-muted text-center">No file changes in this session</div>
          )}

          {diffs.map((diff) => (
            <div key={diff.file} className="border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
              <button
                onClick={() => setExpandedFile(expandedFile === diff.file ? null : diff.file)}
                className="w-full text-left px-4 py-2.5 flex items-center justify-between hover:bg-surface-hover cursor-pointer transition-colors"
              >
                <span className="text-[12px] font-mono text-text">{diff.file}</span>
                <div className="flex items-center gap-2 text-[11px]">
                  {diff.additions > 0 && <span style={{ color: 'var(--color-green)' }}>+{diff.additions}</span>}
                  {diff.deletions > 0 && <span style={{ color: 'var(--color-red)' }}>-{diff.deletions}</span>}
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3"
                    style={{ transform: expandedFile === diff.file ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }}>
                    <polyline points="2.5,3.5 5,6.5 7.5,3.5" />
                  </svg>
                </div>
              </button>

              {expandedFile === diff.file && (
                <div className="px-4 pb-3 overflow-x-auto">
                  <pre className="text-[11px] font-mono leading-relaxed">
                    {renderDiff(diff.before, diff.after)}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function renderDiff(before: string, after: string): ReactElement[] {
  const beforeLines = before ? before.split('\n') : []
  const afterLines = after ? after.split('\n') : []
  const lines: ReactElement[] = []

  // Simple line-by-line diff: show removed lines (red) then added lines (green)
  // For a proper diff we'd use a real diff algorithm, but this covers the basics
  if (before === '') {
    // New file — all additions
    afterLines.forEach((line, i) => {
      lines.push(<div key={`a${i}`} style={{ color: 'var(--color-green)', background: 'color-mix(in srgb, var(--color-green) 10%, transparent)' }}>+ {line}</div>)
    })
  } else if (after === '') {
    // Deleted file — all deletions
    beforeLines.forEach((line, i) => {
      lines.push(<div key={`d${i}`} style={{ color: 'var(--color-red)', background: 'color-mix(in srgb, var(--color-red) 10%, transparent)' }}>- {line}</div>)
    })
  } else {
    // Modified file — show before (red) and after (green) blocks
    // Simple approach: show removed lines then added lines
    const removedLines = beforeLines.filter((line, i) => afterLines[i] !== line)
    const addedLines = afterLines.filter((line, i) => beforeLines[i] !== line)

    if (removedLines.length === 0 && addedLines.length === 0) {
      lines.push(<div key="same" className="text-text-muted">No visible changes (whitespace or encoding only)</div>)
    } else {
      removedLines.forEach((line, i) => {
        lines.push(<div key={`r${i}`} style={{ color: 'var(--color-red)', background: 'color-mix(in srgb, var(--color-red) 10%, transparent)' }}>- {line}</div>)
      })
      addedLines.forEach((line, i) => {
        lines.push(<div key={`a${i}`} style={{ color: 'var(--color-green)', background: 'color-mix(in srgb, var(--color-green) 10%, transparent)' }}>+ {line}</div>)
      })
    }
  }

  return lines
}
