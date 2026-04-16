import { useState } from 'react'
import type { Message } from '../../stores/session'
import { useSessionStore } from '../../stores/session'
import { loadSessionMessages } from '../../helpers/loadSessionMessages'
import { DiffViewer } from './DiffViewer'

// Per-message contextual actions. Rendered only on hover of the parent
// bubble group. Live-placeholder messages (ids ending in ":user:live" or
// ":assistant:live") have no server-side anchor yet — showing fork/revert
// on them would either silently no-op or target the wrong message, so we
// hide the menu entirely for those.
function isLivePlaceholderId(id: string) {
  return id.endsWith(':user:live') || id.endsWith(':assistant:live')
}

export function MessageActions({
  message,
  placement,
}: {
  message: Message
  placement: 'left' | 'right'
}) {
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const addSession = useSessionStore((s) => s.addSession)
  const addGlobalError = useSessionStore((s) => s.addGlobalError)
  const [busy, setBusy] = useState<'fork' | 'revert' | null>(null)
  const [diffOpen, setDiffOpen] = useState(false)

  if (!currentSessionId) return null
  if (isLivePlaceholderId(message.id)) return null

  async function handleFork() {
    if (busy || !currentSessionId) return
    setBusy('fork')
    try {
      const forked = await window.openCowork.session.fork(currentSessionId, message.id)
      if (!forked) {
        addGlobalError('Could not branch from this message. Please try again.')
        return
      }
      addSession(forked)
      await loadSessionMessages(forked.id)
    } finally {
      setBusy(null)
    }
  }

  async function handleRevert() {
    if (busy || !currentSessionId) return
    if (!confirm('Revert the session to this message? Later turns will be hidden until you un-revert.')) return
    setBusy('revert')
    try {
      const ok = await window.openCowork.session.revert(currentSessionId, message.id)
      if (!ok) addGlobalError('Could not revert to this message. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  const baseClass =
    'opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 ' +
    'absolute top-1 text-[10px]'
  const sideClass = placement === 'right' ? 'right-full mr-2' : 'left-full ml-2'

  const isAssistant = message.role === 'assistant'

  return (
    <>
      <div className={`${baseClass} ${sideClass}`}>
        <button
          type="button"
          onClick={handleFork}
          disabled={busy !== null}
          title="Create a new thread that ends at this message"
          className="px-1.5 py-0.5 rounded-full border border-border-subtle text-text-muted hover:text-text hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait"
        >
          {busy === 'fork' ? 'Branching…' : '⑂ Branch here'}
        </button>
        <button
          type="button"
          onClick={handleRevert}
          disabled={busy !== null}
          title="Revert session state to just before this message"
          className="px-1.5 py-0.5 rounded-full border border-border-subtle text-text-muted hover:text-text hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-wait"
        >
          {busy === 'revert' ? 'Reverting…' : '↺ Revert to here'}
        </button>
        {isAssistant && (
          <button
            type="button"
            onClick={() => setDiffOpen(true)}
            title="Show file changes introduced by this message"
            className="px-1.5 py-0.5 rounded-full border border-border-subtle text-text-muted hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
          >
            ⧉ View diff
          </button>
        )}
      </div>
      {diffOpen && (
        <DiffViewer
          sessionId={currentSessionId}
          messageId={message.id}
          onClose={() => setDiffOpen(false)}
        />
      )}
    </>
  )
}
