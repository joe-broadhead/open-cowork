import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionFileDiff } from '@open-cowork/shared'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { t } from '../../helpers/i18n'
import { ModalBackdrop } from '../layout/ModalBackdrop'
import { DiffView } from '../ui'
import { DiffFileRow, ViewModeToggle, type ViewMode } from './DiffViewerRows'

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
  const [viewMode, setViewMode] = useState<ViewMode>('unified')

  useEffect(() => {
    // Track mount state so the async diff response doesn't write into an
    // unmounted component when the user closes the viewer mid-fetch.
    let cancelled = false
    setLoading(true)
    window.coworkApi.session.diff(sessionId, messageId)
      .then((data) => {
        if (cancelled) return
        setDiffs(data || [])
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [sessionId, messageId])

  // Stable callback so memoized rows only re-render when their own
  // `diff`/`expanded` props actually change, not on every parent render.
  const handleToggleFile = useCallback((path: string) => {
    setExpandedFile((current) => (current === path ? null : path))
  }, [])

  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, { onEscape: onClose })
  const title = messageId ? t('diff.changesFromMessage', 'Changes from this message') : t('diff.changes', 'Changes')

  return (
    <>
      <ModalBackdrop onDismiss={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed top-[8%] left-1/2 -translate-x-1/2 z-50 w-[960px] max-w-[95vw] max-h-[85vh] rounded-xl shadow-2xl overflow-hidden flex flex-col theme-popover"
      >
        <DiffView
          title={title}
          subtitle={!loading ? t('diff.filesChanged', '{{count}} file(s) changed', { count: String(diffs.length) }) : undefined}
          className="desktop-diff-view flex-1 min-h-0"
          actions={(
            <>
              <ViewModeToggle mode={viewMode} onChange={setViewMode} />
              <button
                onClick={onClose}
                aria-label={t('diff.closeChanges', 'Close changes')}
                title={t('common.close', 'Close')}
                className="text-text-muted hover:text-text cursor-pointer text-[18px] leading-none ps-1"
              >&times;</button>
            </>
          )}
        >
          <div className="flex-1 overflow-y-auto">
            {loading && (
              <div className="px-4 py-8 text-[12px] text-text-muted text-center">{t('diff.loading', 'Loading changes...')}</div>
            )}

            {!loading && diffs.length === 0 && (
              <div className="px-4 py-8 text-[12px] text-text-muted text-center">{t('diff.noChanges', 'No file changes in this session')}</div>
            )}

            {diffs.map((diff) => (
              <DiffFileRow
                key={diff.file}
                sessionId={sessionId}
                diff={diff}
                expanded={expandedFile === diff.file}
                filePath={diff.file}
                onToggle={handleToggleFile}
                viewMode={viewMode}
              />
            ))}
          </div>
        </DiffView>
      </div>
    </>
  )
}
