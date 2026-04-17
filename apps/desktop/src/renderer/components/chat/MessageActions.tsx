import { useState } from 'react'
import type { Message } from '../../stores/session'
import { useSessionStore } from '../../stores/session'
import { loadSessionMessages } from '../../helpers/loadSessionMessages'
import { DiffViewer } from './DiffViewer'

// Per-message contextual actions. Icon-only bar aligned to the same side
// as the message bubble, faint until hover. Live-placeholder messages
// (ids ending in ":user:live" or ":assistant:live") have no server-side
// anchor yet — fork/revert would either no-op or target the wrong
// message, so we hide the bar entirely for those.
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
      const forked = await window.coworkApi.session.fork(currentSessionId, message.id)
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
      const ok = await window.coworkApi.session.revert(currentSessionId, message.id)
      if (!ok) addGlobalError('Could not revert to this message. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  const isAssistant = message.role === 'assistant'
  const justify = placement === 'right' ? 'justify-end' : 'justify-start'

  return (
    <>
      <div
        className={`mt-1 flex ${justify} opacity-0 group-hover:opacity-100 transition-opacity`}
      >
        <div
          className="inline-flex items-center gap-0.5 rounded-full px-1 py-0.5"
          style={{
            background: 'color-mix(in srgb, var(--color-elevated) 70%, transparent)',
            border: '1px solid var(--color-border-subtle)',
          }}
        >
          <IconButton
            onClick={handleFork}
            disabled={busy !== null}
            busy={busy === 'fork'}
            label="Branch here"
            description="Create a new thread that ends at this message"
          >
            <BranchIcon />
          </IconButton>
          <IconButton
            onClick={handleRevert}
            disabled={busy !== null}
            busy={busy === 'revert'}
            label="Revert to here"
            description="Revert session state to just before this message"
          >
            <RevertIcon />
          </IconButton>
          {isAssistant && (
            <IconButton
              onClick={() => setDiffOpen(true)}
              disabled={false}
              busy={false}
              label="View diff"
              description="Show file changes introduced by this message"
            >
              <DiffIcon />
            </IconButton>
          )}
        </div>
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

function IconButton({
  onClick,
  disabled,
  busy,
  label,
  description,
  children,
}: {
  onClick: () => void | Promise<void>
  disabled: boolean
  busy: boolean
  label: string
  description: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={description}
      className="w-6 h-6 inline-flex items-center justify-center rounded-full text-text-muted hover:text-text hover:bg-surface-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait"
    >
      {busy ? <SpinnerIcon /> : children}
    </button>
  )
}

function BranchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4" cy="3" r="1.5" />
      <circle cx="4" cy="13" r="1.5" />
      <circle cx="12" cy="8" r="1.5" />
      <path d="M4 4.5v7" />
      <path d="M4 8c0-1.5 0.8-3 2.5-3S10 6 10.5 6.5" />
    </svg>
  )
}

function RevertIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8a5 5 0 1 0 2-4" />
      <path d="M3 3v3h3" />
    </svg>
  )
}

function DiffIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="8" height="10" rx="1" />
      <rect x="6" y="5" width="8" height="10" rx="1" />
    </svg>
  )
}

function SpinnerIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="animate-spin">
      <path d="M8 2a6 6 0 1 1-4.24 1.76" />
    </svg>
  )
}
