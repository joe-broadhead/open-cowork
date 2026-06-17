import { useState, useRef, useEffect, useMemo, type CSSProperties } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID, normalizeWorkspaceId, sessionWorkspaceKey } from '../../stores/session-workspace-keys'
import { loadSessionMessages } from '../../helpers/loadSessionMessages'
import { DiffViewer } from '../chat/DiffViewer'
import { confirmSessionDelete } from '../../helpers/destructive-actions'
import { t } from '../../helpers/i18n'
import { writeTextToClipboard } from '../../helpers/clipboard'
import { ViewErrorBoundary } from '../layout/ViewErrorBoundary'
import { ModalBackdrop } from '../layout/ModalBackdrop'
import type { CloudProjectSourceSummary, SessionImportInventory, SessionImportSelection, WorkspaceInfo } from '@open-cowork/shared'
import type { Session } from '../../stores/session'

// Kick in virtualization only above this count. Below it, plain
// rendering is a wash (~8ms mount for 50 rows) and avoids the
// absolute-position overhead for users with small histories.
const VIRTUALIZE_THRESHOLD = 50

// Estimate conservatively so initial scrollbar length is close to
// real — the virtualizer corrects on measurement. Rows shrink when
// a thread has no directory / change summary below the title.
const ESTIMATED_ROW_HEIGHT = 48
const ESTIMATED_GROUP_HEADER_HEIGHT = 32

type ThreadGroup = {
  id: string
  label: string
  description: string
  kind: 'sandbox' | 'project'
  sessions: Session[]
}

type ThreadListItem =
  | { type: 'group'; group: ThreadGroup }
  | { type: 'session'; session: Session; rowIndex: number }

function pathSegments(directory: string) {
  return directory.split('/').map((segment) => segment.trim()).filter(Boolean)
}

function compactPathLabel(directory: string) {
  const segments = pathSegments(directory)
  return segments.slice(-2).join('/') || directory
}

function projectSourceGroupForSession(session: Session, source: CloudProjectSourceSummary): Omit<ThreadGroup, 'sessions'> {
  if (source.kind === 'git') {
    const repo = source.repositoryUrl || t('sidebar.gitRepository', 'Git repository')
    const label = repo.split('/').filter(Boolean).pop()?.replace(/\.git$/, '') || repo
    return {
      id: `project:git:${source.repositoryUrl || session.id}:${source.ref || ''}:${source.subdirectory || ''}`,
      label,
      description: [source.repositoryUrl, source.subdirectory].filter(Boolean).join(' · ') || t('sidebar.gitRepository', 'Git repository'),
      kind: 'project',
    }
  }
  return {
    id: `project:snapshot:${source.snapshotId || session.id}`,
    label: source.title || t('sidebar.uploadedSnapshot', 'Uploaded snapshot'),
    description: source.snapshotId ? t('sidebar.snapshotDescription', 'Uploaded project snapshot') : t('sidebar.cloudProject', 'Cloud project'),
    kind: 'project',
  }
}

function threadGroupForSession(session: Session, activeWorkspaceIsLocal: boolean): Omit<ThreadGroup, 'sessions'> {
  if (session.projectSource) return projectSourceGroupForSession(session, session.projectSource)

  const directory = session.directory?.trim()
  if (!directory) {
    if (!activeWorkspaceIsLocal) {
      return {
        id: 'chat-only',
        label: t('sidebar.chatOnly', 'Chat-only'),
        description: t('sidebar.chatOnlyDescription', 'No project source'),
        kind: 'sandbox',
      }
    }
    return {
      id: 'sandbox',
      label: t('sidebar.sandbox', 'Sandbox'),
      description: t('sidebar.sandboxDescription', 'Chat-only work'),
      kind: 'sandbox',
    }
  }

  const segments = pathSegments(directory)
  const lastSegment = segments[segments.length - 1] || directory
  const sandboxPath = segments.some((segment) => segment === 'Open Cowork Sandbox') || /^thread-\d{4}-\d{2}-\d{2}-/.test(lastSegment)
  if (sandboxPath) {
    return {
      id: 'sandbox',
      label: t('sidebar.sandbox', 'Sandbox'),
      description: compactPathLabel(directory),
      kind: 'sandbox',
    }
  }

  return {
    id: `project:${directory}`,
    label: lastSegment,
    description: compactPathLabel(directory),
    kind: 'project',
  }
}

function groupedThreadItems(sessions: Session[], activeWorkspaceIsLocal: boolean): ThreadListItem[] {
  const groups = new Map<string, ThreadGroup>()
  for (const session of sessions) {
    const groupInfo = threadGroupForSession(session, activeWorkspaceIsLocal)
    const existing = groups.get(groupInfo.id)
    if (existing) {
      existing.sessions.push(session)
    } else {
      groups.set(groupInfo.id, { ...groupInfo, sessions: [session] })
    }
  }

  const items: ThreadListItem[] = []
  let rowIndex = 0
  for (const group of groups.values()) {
    items.push({ type: 'group', group })
    for (const session of group.sessions) {
      items.push({ type: 'session', session, rowIndex })
      rowIndex += 1
    }
  }
  return items
}

export function ThreadList({ onSelect, searchQuery }: { onSelect?: () => void; searchQuery?: string }) {
  const sessions = useSessionStore((s) => s.sessions)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const activeWorkspaceId = useSessionStore((s) => s.activeWorkspaceId)
  const renameSession = useSessionStore((s) => s.renameSession)
  const removeSession = useSessionStore((s) => s.removeSession)
  const setActiveWorkspace = useSessionStore((s) => s.setActiveWorkspace)
  const setSessions = useSessionStore((s) => s.setSessions)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const addGlobalError = useSessionStore((s) => s.addGlobalError)
  const busySessions = useSessionStore((s) => s.busySessions)
  const awaitingQuestionSessions = useSessionStore((s) => s.awaitingQuestionSessions)
  const activeWorkspaceIsLocal = normalizeWorkspaceId(activeWorkspaceId) === LOCAL_WORKSPACE_ID

  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [diffSessionId, setDiffSessionId] = useState<string | null>(null)
  const [copyDialog, setCopyDialog] = useState<{
    sessionId: string
    inventory: SessionImportInventory
    cloudWorkspaces: WorkspaceInfo[]
    targetWorkspaceId: string
    selection: SessionImportSelection
    busy: boolean
  } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const closeMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const focusRowTimerRef = useRef<number | null>(null)

  const interactiveSessions = useMemo(
    () => sessions.filter((session) => (session.kind || 'interactive') === 'interactive'),
    [sessions],
  )

  const filtered = useMemo(() => (
    searchQuery
      ? interactiveSessions.filter(s => (s.title || s.id).toLowerCase().includes(searchQuery.toLowerCase()))
      : interactiveSessions
  ), [interactiveSessions, searchQuery])
  const groupedItems = useMemo(() => groupedThreadItems(filtered, activeWorkspaceIsLocal), [activeWorkspaceIsLocal, filtered])

  const virtualize = filtered.length > VIRTUALIZE_THRESHOLD
  const virtualizer = useVirtualizer({
    count: virtualize ? groupedItems.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => groupedItems[index]?.type === 'group' ? ESTIMATED_GROUP_HEADER_HEIGHT : ESTIMATED_ROW_HEIGHT,
    overscan: 8,
  })

  useEffect(() => {
    if (!virtualize) return
    const frame = window.requestAnimationFrame(() => virtualizer.measure())
    return () => window.cancelAnimationFrame(frame)
  }, [groupedItems.length, virtualize, virtualizer])

  // When the active thread changes, keep it visible. Plays nice with
  // both virtualized and non-virtualized modes — in non-virtualized
  // mode the row is a real DOM node and `scrollIntoView` works; in
  // virtualized mode we ask the virtualizer to scroll by index.
  useEffect(() => {
    if (!currentSessionId) return
    const index = groupedItems.findIndex((item) => item.type === 'session' && item.session.id === currentSessionId)
    if (index < 0) return
    if (virtualize) {
      virtualizer.scrollToIndex(index, { align: 'auto' })
    }
  }, [currentSessionId, groupedItems, virtualize, virtualizer])

  // Close menu on click outside
  useEffect(() => {
    if (!menuId) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuId(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuId])

  useEffect(() => {
    if (!menuId) return
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
  }, [menuId])

  useEffect(() => () => {
    if (closeMenuTimerRef.current) clearTimeout(closeMenuTimerRef.current)
    if (focusRowTimerRef.current) window.clearTimeout(focusRowTimerRef.current)
  }, [])

  useEffect(() => {
    if (activeWorkspaceIsLocal) return
    setMenuId(null)
    setEditingId(null)
    setDiffSessionId(null)
  }, [activeWorkspaceIsLocal])

  if (interactiveSessions.length === 0) {
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
    if (!activeWorkspaceIsLocal) { setEditingId(null); setMenuId(null); return }
    if (!editTitle.trim()) { setEditingId(null); return }
    const ok = await window.coworkApi.session.rename(id, editTitle.trim())
    if (ok) renameSession(id, editTitle.trim())
    setEditingId(null)
    setMenuId(null)
  }

  const handleDelete = async (id: string) => {
    if (!activeWorkspaceIsLocal) { setMenuId(null); return }
    const confirmation = await confirmSessionDelete(id)
    if (!confirmation) {
      setMenuId(null)
      return
    }
    const ok = await window.coworkApi.session.delete(id, confirmation.token)
    if (ok) removeSession(id)
    setMenuId(null)
  }

  const openCopyToCloud = async (id: string) => {
    if (!activeWorkspaceIsLocal) return
    setMenuId(null)
    try {
      const [inventory, workspaces] = await Promise.all([
        window.coworkApi.session.importInventory(id),
        window.coworkApi.workspace.list(),
      ])
      const cloudWorkspaces = workspaces.filter((workspace) => workspace.kind === 'cloud' && workspace.status === 'online')
      if (cloudWorkspaces.length === 0) {
        addGlobalError(t('thread.copyToCloudNoWorkspace', 'Sign in to a cloud workspace before copying a local thread.'))
        return
      }
      setCopyDialog({
        sessionId: id,
        inventory,
        cloudWorkspaces,
        targetWorkspaceId: cloudWorkspaces[0]?.id || '',
        selection: { ...inventory.defaults },
        busy: false,
      })
    } catch (error) {
      addGlobalError(error instanceof Error ? error.message : String(error))
    }
  }

  const updateCopySelection = (patch: Partial<SessionImportSelection>) => {
    setCopyDialog((current) => current
      ? {
          ...current,
          selection: {
            ...current.selection,
            ...patch,
          },
        }
      : current)
  }

  const confirmCopyToCloud = async () => {
    if (!copyDialog || !copyDialog.targetWorkspaceId || copyDialog.busy) return
    setCopyDialog({ ...copyDialog, busy: true })
    try {
      const result = await window.coworkApi.session.copyToCloud(copyDialog.sessionId, {
        targetWorkspaceId: copyDialog.targetWorkspaceId,
        selection: copyDialog.selection,
      })
      const activated = await window.coworkApi.workspace.activate(result.workspaceId)
      setActiveWorkspace(activated.id)
      const cloudSessions = await window.coworkApi.session.list({ workspaceId: activated.id })
      setSessions(cloudSessions)
      setCurrentSession(result.sessionId)
      setCopyDialog(null)
      onSelect?.()
      await loadSessionMessages(result.sessionId)
    } catch (error) {
      setCopyDialog((current) => current ? { ...current, busy: false } : current)
      addGlobalError(error instanceof Error ? error.message : String(error))
    }
  }

  const openMenuAt = (xInput: number, yInput: number, sessionId: string) => {
    if (!activeWorkspaceIsLocal) return
    // Clamp so the menu doesn't go off-screen
    const y = Math.min(yInput, window.innerHeight - 140)
    const x = Math.min(xInput, window.innerWidth - 170)
    setMenuPos({ x, y })
    setMenuId(menuId === sessionId ? null : sessionId)
  }

  const openMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    e.stopPropagation()
    openMenuAt(e.clientX, e.clientY, sessionId)
  }

  const openMenuFromKeyboard = (e: React.KeyboardEvent<HTMLElement>, sessionId: string) => {
    if (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10')) return
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    openMenuAt(rect.right - 12, rect.top + 12, sessionId)
  }

  const focusThreadRow = (sessionId: string) => {
    if (focusRowTimerRef.current) window.clearTimeout(focusRowTimerRef.current)
    focusRowTimerRef.current = window.setTimeout(() => {
      focusRowTimerRef.current = null
      rowRefs.current.get(sessionId)?.focus()
    }, 0)
  }

  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!menuId) return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    if (items.length === 0) return
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement)

    if (e.key === 'Tab') {
      setMenuId(null)
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      setMenuId(null)
      focusThreadRow(menuId)
      return
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const offset = e.key === 'ArrowDown' ? 1 : -1
      const nextIndex = currentIndex >= 0
        ? (currentIndex + offset + items.length) % items.length
        : 0
      items[nextIndex]?.focus()
      return
    }

    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus()
    }
  }

  const renderRow = (session: typeof filtered[number], rowIndex?: number) => {
    const isActive = session.id === currentSessionId
    const isEditing = editingId === session.id
    const sessionKey = sessionWorkspaceKey(activeWorkspaceId, session.id)
    const isAwaitingQuestion = awaitingQuestionSessions.has(sessionKey)
    const isBusy = busySessions.has(sessionKey) && !isAwaitingQuestion
    const staggered = typeof rowIndex === 'number' && rowIndex < 20
    const rowStyle = staggered
      ? ({ '--polish-row-index': rowIndex } as CSSProperties)
      : undefined
    return (
      <div key={session.id} className="relative group">
        {isEditing ? (
              <div className="px-1">
                <input autoFocus type="text" value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') void handleRename(session.id); if (e.key === 'Escape') setEditingId(null) }}
                  onBlur={() => handleRename(session.id)}
                  className="w-full px-2 py-[6px] rounded-md text-[13px] bg-elevated border border-accent text-text outline-none" />
              </div>
            ) : (
              <button type="button"
                ref={(node) => {
                  if (node) rowRefs.current.set(session.id, node)
                  else rowRefs.current.delete(session.id)
                }}
                onClick={() => handleSelect(session.id)}
                onContextMenu={activeWorkspaceIsLocal ? (e) => openMenu(e, session.id) : undefined}
                onKeyDown={activeWorkspaceIsLocal ? (e) => openMenuFromKeyboard(e, session.id) : undefined}
                aria-haspopup={activeWorkspaceIsLocal ? 'menu' : undefined}
                aria-expanded={activeWorkspaceIsLocal ? menuId === session.id : undefined}
                data-active={isActive ? 'true' : undefined}
                data-polish-stagger={staggered ? 'true' : undefined}
                style={rowStyle}
                className={`ui-polish-list-row w-full text-start px-3 py-[7px] rounded-md text-[13px] truncate cursor-pointer flex items-center justify-between gap-1 ${isActive ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'}`}>
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
                        title={session.changeSummary.synthetic
                          ? t('diff.estimatedFilesChanged', '{{count}} estimated file(s) changed from projection data', { count: String(session.changeSummary.files) })
                          : t('diff.filesChanged', '{{count}} file(s) changed', { count: String(session.changeSummary.files) })}
                        className="shrink-0 inline-flex items-center gap-1 text-[9px] leading-none"
                      >
                        {session.changeSummary.synthetic && <span className="text-text-muted">est</span>}
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
                {activeWorkspaceIsLocal && (
                  <span onClick={(e) => openMenu(e, session.id)}
                    aria-hidden="true"
                    className="opacity-0 group-hover:opacity-100 shrink-0 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-secondary transition-opacity cursor-pointer">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="6" cy="3" r="1"/><circle cx="6" cy="6" r="1"/><circle cx="6" cy="9" r="1"/></svg>
                  </span>
                )}
              </button>
            )}
      </div>
    )
  }

  const renderGroup = (group: ThreadGroup) => (
    <div key={`group:${group.id}`} className="thread-group-header px-2 pb-1 pt-2">
      <div className="flex min-w-0 items-center justify-between gap-2 rounded-md px-1.5 py-1 text-[10px] font-semibold uppercase tracking-widest text-text-muted">
        <span className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden="true" className="text-[11px] leading-none">{group.kind === 'sandbox' ? 'S' : 'P'}</span>
          <span className="truncate">{group.label}</span>
        </span>
        <span className="shrink-0 rounded border border-border-subtle px-1 py-px text-[9px] normal-case tracking-normal text-text-muted">
          {group.sessions.length}
        </span>
      </div>
      <div className="truncate px-1.5 text-[9px] text-text-muted">{group.description}</div>
    </div>
  )

  const renderItem = (item: ThreadListItem) => (
    item.type === 'group'
      ? renderGroup(item.group)
      : renderRow(item.session, item.rowIndex)
  )

  return (
    <div ref={scrollRef} className="min-h-[96px] flex-1 overflow-y-auto">
      {virtualize ? (
        <div
          style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}
        >
          {virtualizer.getVirtualItems().map((vRow) => {
            const item = groupedItems[vRow.index]
            if (!item) return null
            return (
              <div
                key={item.type === 'group' ? `group:${item.group.id}` : item.session.id}
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
                {renderItem(item)}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-px">
          {groupedItems.map(renderItem)}
        </div>
      )}

      {/* Context menu — rendered as portal at fixed position */}
      {menuId && (
        <div ref={menuRef}
          role="menu"
          aria-label={t('thread.menuLabel', 'Thread actions')}
          onKeyDown={handleMenuKeyDown}
          className="fixed z-50 w-40 py-1.5 rounded-xl theme-popover"
          style={{
            left: menuPos.x,
            top: menuPos.y,
          }}>
          <button type="button" onClick={() => {
            const selectedSession = interactiveSessions.find((session) => session.id === menuId)
            setEditTitle(selectedSession?.title || '')
            setEditingId(menuId)
            setMenuId(null)
          }}
            role="menuitem"
            className="w-full text-start px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text cursor-pointer transition-colors">
            {t('thread.rename', 'Rename')}
          </button>
          <button type="button" onClick={async () => {
            const md = await window.coworkApi.session.export(menuId)
            if (md) {
              const selectedSession = interactiveSessions.find((session) => session.id === menuId)
              const blob = new Blob([md], { type: 'text/markdown' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url; a.download = `${(selectedSession?.title || 'thread').replace(/[^a-z0-9]/gi, '-')}.md`
              a.click(); URL.revokeObjectURL(url)
            }
            setMenuId(null)
          }}
            role="menuitem"
            className="w-full text-start px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text cursor-pointer transition-colors">
            {t('thread.exportMarkdown', 'Export Markdown')}
          </button>
          <button type="button" onClick={async () => {
            const url = await window.coworkApi.session.share(menuId)
            if (url) {
              const copied = await writeTextToClipboard(url)
              // Brief visual feedback
              const btn = document.activeElement as HTMLElement
              if (btn) btn.textContent = copied ? t('thread.linkCopied', 'Link copied!') : t('thread.linkCopyFailed', 'Copy failed')
              if (closeMenuTimerRef.current) clearTimeout(closeMenuTimerRef.current)
              closeMenuTimerRef.current = setTimeout(() => {
                closeMenuTimerRef.current = null
                setMenuId(null)
              }, 800)
            } else {
              setMenuId(null)
            }
          }}
            role="menuitem"
            className="w-full text-start px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text cursor-pointer transition-colors">
            {t('thread.shareLink', 'Share Link')}
          </button>
          <button type="button" onClick={() => {
            void openCopyToCloud(menuId)
          }}
            role="menuitem"
            className="w-full text-start px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text cursor-pointer transition-colors">
            {t('thread.copyToCloud', 'Copy to Cloud...')}
          </button>
          {interactiveSessions.find(s => s.id === menuId)?.directory && (
            <button type="button" onClick={() => { setDiffSessionId(menuId); setMenuId(null) }}
              role="menuitem"
              className="w-full text-start px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text cursor-pointer transition-colors">
              {t('thread.viewChanges', 'View Changes')}
            </button>
          )}
          <div className="my-1 border-t" style={{ borderColor: 'var(--color-border-subtle)' }} />
          <button type="button" onClick={() => {
            void handleDelete(menuId)
          }}
            role="menuitem"
            className="w-full text-start px-3 py-1.5 text-[12px] hover:bg-surface-hover cursor-pointer transition-colors"
            style={{ color: 'var(--color-red)' }}>
            {t('thread.delete', 'Delete')}
          </button>
        </div>
      )}
      {diffSessionId && (
        <ViewErrorBoundary
          resetKey={`diff-viewer:${diffSessionId}`}
          title={t('error.panelErrorTitle', 'This panel failed to render.')}
          body={t('error.panelErrorBody', 'The rest of the app recovered. Close this panel and try again.')}
          actionLabel={t('error.closePanel', 'Close panel')}
          onBackHome={() => setDiffSessionId(null)}
        >
          <DiffViewer sessionId={diffSessionId} onClose={() => setDiffSessionId(null)} />
        </ViewErrorBoundary>
      )}
      {copyDialog && (
        <>
          <ModalBackdrop onDismiss={() => { if (!copyDialog.busy) setCopyDialog(null) }} className="fixed inset-0 z-40 bg-black/45" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('thread.copyToCloudDialog', 'Copy thread to cloud')}
            className="fixed top-[12%] left-1/2 z-50 w-[520px] max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden rounded-lg theme-popover shadow-2xl"
          >
            <div className="border-b border-border-subtle px-4 py-3">
              <div className="text-[14px] font-semibold text-text">{t('thread.copyToCloud', 'Copy to Cloud...')}</div>
              <div className="mt-1 text-[12px] text-text-muted">
                {t('thread.copyToCloudSubtitle', 'Creates a new cloud thread. The local thread stays unchanged.')}
              </div>
            </div>
            <div className="max-h-[60vh] overflow-y-auto px-4 py-3">
              <label className="block text-[11px] font-medium text-text-muted">
                {t('thread.copyToCloudTarget', 'Cloud workspace')}
                <select
                  value={copyDialog.targetWorkspaceId}
                  disabled={copyDialog.busy}
                  onChange={(event) => setCopyDialog({ ...copyDialog, targetWorkspaceId: event.target.value })}
                  className="mt-1 w-full rounded-md border border-border-subtle bg-elevated px-2 py-2 text-[12px] text-text outline-none focus:border-border"
                >
                  {copyDialog.cloudWorkspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>{workspace.label}</option>
                  ))}
                </select>
              </label>

              <div className="mt-4 grid grid-cols-2 gap-2 text-[12px]">
                <div className="rounded-md border border-border-subtle px-3 py-2">
                  <div className="text-text-muted">{t('thread.copyMessages', 'Messages')}</div>
                  <div className="mt-0.5 font-medium text-text">{copyDialog.inventory.counts.messages}</div>
                </div>
                <div className="rounded-md border border-border-subtle px-3 py-2">
                  <div className="text-text-muted">{t('thread.copyArtifacts', 'Artifacts')}</div>
                  <div className="mt-0.5 font-medium text-text">{copyDialog.inventory.counts.artifacts}</div>
                </div>
                <div className="rounded-md border border-border-subtle px-3 py-2">
                  <div className="text-text-muted">{t('thread.copyAttachments', 'Attachments')}</div>
                  <div className="mt-0.5 font-medium text-text">{copyDialog.inventory.counts.attachments}</div>
                </div>
                <div className="rounded-md border border-border-subtle px-3 py-2">
                  <div className="text-text-muted">{t('thread.copyExcluded', 'Excluded')}</div>
                  <div className="mt-0.5 font-medium text-text">{copyDialog.inventory.counts.excluded}</div>
                </div>
              </div>

              <div className="mt-4 space-y-2">
                <label className="flex items-start gap-2 text-[12px] text-text-secondary">
                  <input
                    type="checkbox"
                    checked={copyDialog.selection.includeMessages !== false}
                    disabled={copyDialog.busy}
                    onChange={(event) => updateCopySelection({ includeMessages: event.target.checked })}
                    className="mt-0.5"
                  />
                  <span>{t('thread.copyMessagesCheckbox', 'Copy redacted user and assistant message history')}</span>
                </label>
                <label className="flex items-start gap-2 text-[12px] text-text-secondary">
                  <input
                    type="checkbox"
                    checked={copyDialog.selection.includeAttachments === true}
                    disabled={copyDialog.busy || copyDialog.inventory.counts.attachments === 0}
                    onChange={(event) => updateCopySelection({ includeAttachments: event.target.checked })}
                    className="mt-0.5"
                  />
                  <span>{t('thread.copyAttachmentsCheckbox', 'Copy data attachments already present in the thread')}</span>
                </label>
                <label className="flex items-start gap-2 text-[12px] text-text-secondary">
                  <input
                    type="checkbox"
                    checked={copyDialog.selection.includeArtifacts === true}
                    disabled={copyDialog.busy || copyDialog.inventory.counts.artifacts === 0}
                    onChange={(event) => updateCopySelection({ includeArtifacts: event.target.checked })}
                    className="mt-0.5"
                  />
                  <span>{t('thread.copyArtifactsCheckbox', 'Upload selected Cowork artifacts to cloud object storage')}</span>
                </label>
                <label className="flex items-start gap-2 text-[12px] text-text-muted">
                  <input type="checkbox" checked={false} disabled className="mt-0.5" />
                  <span>{t('thread.copyProjectSourceDisabled', 'Local project source and host paths are excluded in v1')}</span>
                </label>
              </div>

              {(copyDialog.inventory.warnings.length > 0 || copyDialog.inventory.excluded.length > 0) && (
                <div className="mt-4 rounded-md border border-border-subtle px-3 py-2">
                  {copyDialog.inventory.warnings.map((warning) => (
                    <div key={warning.code} className="text-[11px] text-text-secondary">{warning.message}</div>
                  ))}
                  {copyDialog.inventory.excluded.map((item) => (
                    <div key={item.kind} className="mt-1 text-[11px] text-text-muted">{item.reason}</div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-border-subtle px-4 py-3">
              <button
                type="button"
                disabled={copyDialog.busy}
                onClick={() => setCopyDialog(null)}
                className="rounded-md border border-border-subtle px-3 py-2 text-[12px] text-text-secondary hover:bg-surface-hover disabled:opacity-60"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                disabled={copyDialog.busy || !copyDialog.targetWorkspaceId}
                onClick={() => void confirmCopyToCloud()}
                className="rounded-md px-3 py-2 text-[12px] font-medium disabled:cursor-wait disabled:opacity-60"
                style={{
                  background: 'var(--color-accent)',
                  color: 'var(--color-accent-foreground)',
                }}
              >
                {copyDialog.busy ? t('thread.copyingToCloud', 'Copying...') : t('thread.copyToCloudConfirm', 'Copy to Cloud')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
