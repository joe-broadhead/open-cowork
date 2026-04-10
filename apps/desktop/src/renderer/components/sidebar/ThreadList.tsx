import { useState } from 'react'
import { useSessionStore } from '../../stores/session'

export function ThreadList({ onSelect }: { onSelect?: () => void }) {
  const sessions = useSessionStore((s) => s.sessions)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const setCurrentSession = useSessionStore((s) => s.setCurrentSession)
  const clearMessages = useSessionStore((s) => s.clearMessages)
  const addMessage = useSessionStore((s) => s.addMessage)
  const renameSession = useSessionStore((s) => s.renameSession)
  const removeSession = useSessionStore((s) => s.removeSession)

  const [menuId, setMenuId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  if (sessions.length === 0) {
    return <div className="px-2 py-3 text-[11px] text-text-muted text-center">No threads yet</div>
  }

  const handleSelect = async (sessionId: string) => {
    if (editingId) return
    if (sessionId === currentSessionId) { onSelect?.(); return }
    setCurrentSession(sessionId)
    clearMessages()
    onSelect?.()
    try {
      const messages = await window.cowork.session.messages(sessionId)
      for (const msg of messages) {
        addMessage({ id: msg.id, role: msg.role as 'user' | 'assistant', content: msg.content })
      }
    } catch {}
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

  return (
    <div className="flex flex-col gap-px">
      {sessions.map((session) => {
        const isActive = session.id === currentSessionId
        const isEditing = editingId === session.id
        const showMenu = menuId === session.id

        return (
          <div key={session.id} className="relative group">
            {isEditing ? (
              <div className="px-1">
                <input
                  autoFocus
                  type="text"
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleRename(session.id)
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  onBlur={() => handleRename(session.id)}
                  className="w-full px-2 py-[6px] rounded-md text-[13px] bg-elevated border border-accent text-text outline-none"
                />
              </div>
            ) : (
              <button
                onClick={() => handleSelect(session.id)}
                onContextMenu={(e) => { e.preventDefault(); setMenuId(showMenu ? null : session.id) }}
                className={`w-full text-left px-3 py-[7px] rounded-md text-[13px] truncate transition-colors cursor-pointer flex items-center justify-between ${
                  isActive ? 'bg-surface-active text-text' : 'text-text-secondary hover:bg-surface-hover hover:text-text'
                }`}
              >
                <span className="truncate flex-1">{session.title || `Thread ${session.id.slice(0, 6)}`}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuId(showMenu ? null : session.id) }}
                  className="opacity-0 group-hover:opacity-100 shrink-0 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-secondary transition-opacity"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
                    <circle cx="6" cy="3" r="1"/><circle cx="6" cy="6" r="1"/><circle cx="6" cy="9" r="1"/>
                  </svg>
                </button>
              </button>
            )}

            {/* Context menu */}
            {showMenu && !isEditing && (
              <div className="absolute right-2 top-8 z-50 w-32 py-1 rounded-lg bg-elevated border border-border shadow-lg">
                <button
                  onClick={() => { setEditTitle(session.title || ''); setEditingId(session.id); setMenuId(null) }}
                  className="w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text cursor-pointer"
                >
                  Rename
                </button>
                <button
                  onClick={() => handleDelete(session.id)}
                  className="w-full text-left px-3 py-1.5 text-[12px] hover:bg-surface-hover cursor-pointer"
                  style={{ color: 'var(--color-red)' }}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
        )
      })}

      {/* Click-away to close menu */}
      {menuId && <div className="fixed inset-0 z-40" onClick={() => setMenuId(null)} />}
    </div>
  )
}
