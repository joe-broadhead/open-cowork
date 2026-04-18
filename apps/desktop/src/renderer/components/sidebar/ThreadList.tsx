import { useState, useRef, useEffect, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useSessionStore } from '../../stores/session'
import { loadSessionMessages } from '../../helpers/loadSessionMessages'
import { DiffViewer } from '../chat/DiffViewer'
import { confirmSessionDelete } from '../../helpers/destructive-actions'
import { t } from '../../helpers/i18n'

// Kick in virtualization only above this count. Below it, plain
// rendering is a wash (~8ms mount for 50 rows) and avoids the
// absolute-position overhead for users with small histories.
const VIRTUALIZE_THRESHOLD = 50

// Estimate conservatively so initial scrollbar length is close to
// real — the virtualizer corrects on measurement. Rows shrink when
// a thread has no directory / change summary below the title.
const ESTIMATED_ROW_HEIGHT = 48

export function ThreadList({ onSelect, searchQuery }: { onSelect?: () => void; searchQuery?: string }) {
  const sessions = useSessionStore((s) => s.sessions)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const renameSession = useSessionStore((s) => s.renameSession)
  const removeSession = useSessionStore((s) => s.removeSession)
  const busySessions = useSessionStore((s) => s.busySessions)
  const awaitingQuestionSessions = useSessionStore((s) => s.awaitingQuestionSessions)

  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [diffSessionId, setDiffSessionId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => (
    searchQuery
      ? sessions.filter(s => (s.title || s.id).toLowerCase().includes(searchQuery.toLowerCase()))
      : sessions
  ), [searchQuery, sessions])

  const virtualize = filtered.length > VIRTUALIZE_THRESHOLD
  const virtualizer = useVirtualizer({
    count: virtualize ? filtered.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
  })

  // When the active thread changes, keep it visible. Plays nice with
  // both virtualized and non-virtualized modes — in non-virtualized
  // mode the row is a real DOM node and `scrollIntoView` works; in
  // virtualized mode we ask the virtualizer to scroll by index.
  useEffect(() => {
    if (!currentSessionId) return
    const index = filtered.findIndex((session) => session.id === currentSessionId)
    if (index < 0) return
    if (virtualize) {
      virtualizer.scrollToIndex(index, { align: 'auto' })
    }
  }, [currentSessionId, filtered, virtualize, virtualizer])

  // Close menu on click outside
  useEffect(() => {
    if (!menuId) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuId(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuId])

  if (sessions.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-text-muted text-center">{t('sidebar.noThreads', 'No threads yet')}</div>
  }

  if (searchQuery && filtered.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-text-muted text-center">{t('sidebar.noMatches', 'No matches')}</div>
  }

  const handleSelect = async (sessionId: string) => {
    if (editingId) return
    if (sessionId === currentSessionId) { onSelect?.(); return }
    onSelect?.()
    await loadSessionMessages(sessionId)
  }

  const handleRename = async (id: string) => {
    if (!editTitle.trim()) { setEditingId(null); return }
    const ok = await window.coworkApi.session.rename(id, editTitle.trim())
    if (ok) renameSession(id, editTitle.trim())
    setEditingId(null)
    setMenuId(null)
  }

  const handleDelete = async (id: string) => {
    const confirmation = await confirmSessionDelete(id)
    if (!confirmation) {
      setMenuId(null)
      return
    }
    const ok = await window.coworkApi.session.delete(id, confirmation.token)
    if (ok) removeSession(id)
    setMenuId(null)
  }

  const openMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    e.stopPropagation()
    // Clamp so the menu doesn't go off-screen
    const y = Math.min(e.clientY, window.innerHeight - 140)
    const x = Math.min(e.clientX, window.innerWidth - 170)
    setMenuPos({ x, y })
    setMenuId(menuId === sessionId ? null : sessionId)
  }

  const renderRow = (session: typeof filtered[number]) => {
    const isActive = session.id === currentSessionId
    const isEditing = editingId === session.id
    const isAwaitingQuestion = awaitingQuestionSessions.has(session.id)
    const isBusy = busySessions.has(session.id) && !isAwaitingQuestion
    return (
      <div key={session.id} className="relative group">
        {isEditing ? (
              <div className="px-1">
                <input autoFocus type="text" value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleRename(session.id); if (e.key === 'Escape') setEditingId(null) }}
                  onBlur={() => handleRename(session.id)}
                  className="w-full px-2 py-[6px] rounded-md text-[13px] bg-elevated border border-accent text-text outline-none" />
              </div>
            ) : (
              <button onClick={() => handleSelect(session.id)}
                onContextMenu={(e) => openMenu(e, session.id)}
                className={`w-full text-left px-3 py-[7px] rounded-md text-[13px] truncate transition-colors cursor-pointer flex items-center justify-between gap-1 ${isActive ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
                <span className="truncate flex-1">
                  <span className="flex items-center gap-1.5">
                    {isAwaitingQuestion ? (
                      <span
                        title={t('threadList.waitingForAnswer', 'Waiting for your answer')}
                        aria-label={t('threadList.waitingForAnswer', 'Waiting for your answer')}
                        className="shrink-0 inline-flex items-center justify-center w-[14px] h-[14px] rounded-full text-[9px] font-semibold leading-none"
                        style={{
                          background: 'color-mix(in srgb, var(--color-warning) 24%, transparent)',
                          color: 'var(--color-warning)',
                        }}
                      >
                        ?
                      </span>
                    ) : isBusy ? (
                      <span
                        title={t('threadList.working', 'Working')}
                        aria-label={t('threadList.working', 'Working')}
                        className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0"
                      />
                    ) : null}
                    {session.parentSessionId && (
                      <span
                        title={t('threadList.forkedFrom', 'Forked from another thread')}
                        aria-label={t('threadList.forked', 'Forked thread')}
                        className="shrink-0 text-[11px] leading-none text-text-muted"
                      >
                        ⑂
                      </span>
                    )}
                    {session.title || t('sidebar.threadFallback', 'Thread {{id}}', { id: session.id.slice(0, 6) })}
                  </span>
                  <span className="flex items-center gap-1.5 mt-px">
                    {session.directory && (
                      <span className="text-[9px] text-text-muted truncate">
                        {session.directory.split('/').slice(-2).join('/')}
                      </span>
                    )}
                    {session.changeSummary && session.changeSummary.files > 0 && (
                      <span
                        title={t('diff.filesChanged', '{{count}} file(s) changed', { count: String(session.changeSummary.files) })}
                        className="shrink-0 inline-flex items-center gap-1 text-[9px] leading-none"
                      >
                        <span style={{ color: 'var(--color-green)' }}>+{session.changeSummary.additions}</span>
                        <span style={{ color: 'var(--color-red)' }}>−{session.changeSummary.deletions}</span>
                      </span>
                    )}
                    {session.revertedMessageId && (
                      <span
                        title={t('threadList.revertedTitle', 'Session is reverted to an earlier message')}
                        className="shrink-0 text-[9px] uppercase tracking-[0.04em] px-1 py-px rounded"
                        style={{
                          color: 'var(--color-warning)',
                          background: 'color-mix(in srgb, var(--color-warning) 12%, transparent)',
                        }}
                      >
                        {t('threadList.reverted', 'reverted')}
                      </span>
                    )}
                  </span>
                </span>
                {/* Left-click affordance for the context menu. Can't
                    be a real <button> (illegal nesting inside the row
                    button above); keyboard users reach the same menu
                    via the row's onContextMenu handler — native
                    "context-menu key" / Shift+F10 path works because
                    the outer button owns that listener. */}
                {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
                <span onClick={(e) => openMenu(e, session.id)}
                  className="opacity-0 group-hover:opacity-100 shrink-0 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-secondary transition-opacity cursor-pointer">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="6" cy="3" r="1"/><circle cx="6" cy="6" r="1"/><circle cx="6" cy="9" r="1"/></svg>
                </span>
              </button>
            )}
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
      {virtualize ? (
        <div
          style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}
        >
          {virtualizer.getVirtualItems().map((vRow) => {
            const session = filtered[vRow.index]
            if (!session) return null
            return (
              <div
                key={session.id}
                data-index={vRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vRow.start}px)`,
                }}
              >
                {renderRow(session)}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-px">
          {filtered.map((session) => renderRow(session))}
        </div>
      )}

      {/* Context menu — rendered as portal at fixed position */}
      {menuId && (
        <div ref={menuRef}
          className="fixed z-50 w-40 py-1.5 rounded-xl theme-popover"
          style={{
            left: menuPos.x,
            top: menuPos.y,
          }}>
          <button onClick={() => {
            const selectedSession = sessions.find((session) => session.id === menuId)
            setEditTitle(selectedSession?.title || '')
            setEditingId(menuId)
            setMenuId(null)
          }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text cursor-pointer transition-colors">
            {t('thread.rename', 'Rename')}
          </button>
          <button onClick={async () => {
            const md = await window.coworkApi.session.export(menuId)
            if (md) {
              const selectedSession = sessions.find((session) => session.id === menuId)
              const blob = new Blob([md], { type: 'text/markdown' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url; a.download = `${(selectedSession?.title || 'thread').replace(/[^a-z0-9]/gi, '-')}.md`
              a.click(); URL.revokeObjectURL(url)
            }
            setMenuId(null)
          }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text cursor-pointer transition-colors">
            {t('thread.exportMarkdown', 'Export Markdown')}
          </button>
          <button onClick={async () => {
            const url = await window.coworkApi.session.share(menuId)
            if (url) {
              navigator.clipboard.writeText(url)
              // Brief visual feedback
              const btn = document.activeElement as HTMLElement
              if (btn) btn.textContent = t('thread.linkCopied', 'Link copied!')
              setTimeout(() => setMenuId(null), 800)
            } else {
              setMenuId(null)
            }
          }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text cursor-pointer transition-colors">
            {t('thread.shareLink', 'Share Link')}
          </button>
          {sessions.find(s => s.id === menuId)?.directory && (
            <button onClick={() => { setDiffSessionId(menuId); setMenuId(null) }}
              className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text cursor-pointer transition-colors">
              {t('thread.viewChanges', 'View Changes')}
            </button>
          )}
          <div className="my-1 border-t" style={{ borderColor: 'var(--color-border-subtle)' }} />
          <button onClick={() => {
            void handleDelete(menuId)
          }}
            className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-hover cursor-pointer transition-colors"
            style={{ color: 'var(--color-red)' }}>
            {t('thread.delete', 'Delete')}
          </button>
        </div>
      )}
      {diffSessionId && (
        <DiffViewer sessionId={diffSessionId} onClose={() => setDiffSessionId(null)} />
      )}
    </div>
  )
}
