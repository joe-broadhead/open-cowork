import { useState, useRef, useEffect } from 'react'
import { useSessionStore } from '../../stores/session'
import { loadSessionMessages } from '../../helpers/loadSessionMessages'
import { DiffViewer } from '../chat/DiffViewer'

export function ThreadList({ onSelect, searchQuery }: { onSelect?: () => void; searchQuery?: string }) {
  const sessions = useSessionStore((s) => s.sessions)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const renameSession = useSessionStore((s) => s.renameSession)
  const removeSession = useSessionStore((s) => s.removeSession)
  const busySessions = useSessionStore((s) => s.busySessions)

  const [menuId, setMenuId] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [diffSessionId, setDiffSessionId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const filtered = searchQuery
    ? sessions.filter(s => (s.title || s.id).toLowerCase().includes(searchQuery.toLowerCase()))
    : sessions

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
    return <div className="px-2 py-3 text-[11px] text-text-muted text-center">No threads yet</div>
  }

  if (searchQuery && filtered.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-text-muted text-center">No matches</div>
  }

  const handleSelect = async (sessionId: string) => {
    if (editingId) return
    if (sessionId === currentSessionId) { onSelect?.(); return }
    onSelect?.()
    await loadSessionMessages(sessionId)
  }

  const handleRename = async (id: string) => {
    if (!editTitle.trim()) { setEditingId(null); return }
    const ok = await window.cowork.session.rename(id, editTitle.trim())
    if (ok) renameSession(id, editTitle.trim())
    setEditingId(null)
    setMenuId(null)
  }

  const handleDelete = async (id: string) => {
    const ok = await window.cowork.session.delete(id)
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

  return (
    <div className="flex flex-col gap-px">
      {filtered.map((session) => {
        const isActive = session.id === currentSessionId
        const isEditing = editingId === session.id
        const isBusy = busySessions.has(session.id)

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
                    {isBusy && <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />}
                    {session.title || `Thread ${session.id.slice(0, 6)}`}
                  </span>
                  {(session as any).directory && (
                    <span className="block text-[9px] text-text-muted truncate mt-px">
                      {(session as any).directory.split('/').slice(-2).join('/')}
                    </span>
                  )}
                </span>
                <span onClick={(e) => openMenu(e, session.id)}
                  className="opacity-0 group-hover:opacity-100 shrink-0 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-secondary transition-opacity cursor-pointer">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><circle cx="6" cy="3" r="1"/><circle cx="6" cy="6" r="1"/><circle cx="6" cy="9" r="1"/></svg>
                </span>
              </button>
            )}
          </div>
        )
      })}

      {/* Context menu — rendered as portal at fixed position */}
      {menuId && (
        <div ref={menuRef}
          className="fixed z-50 w-40 py-1.5 rounded-xl border shadow-xl"
          style={{
            left: menuPos.x,
            top: menuPos.y,
            background: '#1a1a1a',
            borderColor: 'var(--color-border)',
          }}>
          <button onClick={() => {
            const s = sessions.find(s => s.id === menuId)
            setEditTitle(s?.title || '')
            setEditingId(menuId)
            setMenuId(null)
          }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text cursor-pointer transition-colors">
            Rename
          </button>
          <button onClick={async () => {
            const md = await window.cowork.session.export(menuId)
            if (md) {
              const s = sessions.find(s => s.id === menuId)
              const blob = new Blob([md], { type: 'text/markdown' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url; a.download = `${(s?.title || 'thread').replace(/[^a-z0-9]/gi, '-')}.md`
              a.click(); URL.revokeObjectURL(url)
            }
            setMenuId(null)
          }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text cursor-pointer transition-colors">
            Export Markdown
          </button>
          <button onClick={async () => {
            const url = await window.cowork.session.share(menuId)
            if (url) {
              navigator.clipboard.writeText(url)
              // Brief visual feedback
              const btn = document.activeElement as HTMLElement
              if (btn) btn.textContent = 'Link copied!'
              setTimeout(() => setMenuId(null), 800)
            } else {
              setMenuId(null)
            }
          }}
            className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text cursor-pointer transition-colors">
            Share Link
          </button>
          {sessions.find(s => s.id === menuId)?.directory && (
            <button onClick={() => { setDiffSessionId(menuId); setMenuId(null) }}
              className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text cursor-pointer transition-colors">
              View Changes
            </button>
          )}
          <div className="my-1 border-t" style={{ borderColor: 'var(--color-border-subtle)' }} />
          <button onClick={() => {
            if (confirm('Delete this thread? This cannot be undone.')) {
              handleDelete(menuId)
            } else {
              setMenuId(null)
            }
          }}
            className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-hover cursor-pointer transition-colors"
            style={{ color: 'var(--color-red)' }}>
            Delete
          </button>
        </div>
      )}
      {diffSessionId && (
        <DiffViewer sessionId={diffSessionId} onClose={() => setDiffSessionId(null)} />
      )}
    </div>
  )
}
