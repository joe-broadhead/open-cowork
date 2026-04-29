import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BrandingHomeConfig, BuiltInAgentDetail, SessionInfo } from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'
import { formatDate, t } from '../helpers/i18n'
import { ChatInputAttachments } from './chat/ChatInputAttachments'
import { filesToAttachments } from './chat/chat-input-utils'
import type { Attachment } from './chat/chat-input-types'

// Home is the welcoming landing surface. We deliberately moved the
// diagnostic dashboard (runtime pills, MCP status, usage metrics, perf
// stats) to PulsePage so Home can focus on a single ask: start a
// conversation. Power users click into Pulse when they want the
// workspace at-a-glance view; business users see a composer + a warm
// greeting and get straight to work.

interface Props {
  brandName: string
  homeBranding?: BrandingHomeConfig
  onStartThread: (text: string, attachments?: Attachment[]) => Promise<void>
  onOpenPulse: () => void
  onOpenThread: (sessionId: string) => void | Promise<void>
}

// Single, stable greeting. We experimented with a rotation but the
// product voice is clearer with one line: it's the tagline for the
// landing surface, not a random fortune-cookie. The i18n key stays
// so downstream forks can retune the voice without patching this file.
const GREETING_KEY = 'home.greeting.cowork'
const GREETING_FALLBACK = 'What shall we cowork on today?'

// Cap on how many suggestion pills and how many recent threads we
// show. Kept small deliberately — the page is "get started", not
// "everything at once".
const MAX_SUGGESTIONS = 4
const MAX_RECENT_THREADS = 3

// Upper bound on the composer's auto-grow. Past ~220px the textarea
// starts to dominate the landing page and push everything below the
// fold. The value matches ChatInput's own ceiling so the UX feels
// consistent across Home → chat transitions.
const MAX_COMPOSER_HEIGHT = 220

function formatAgentLabel(name: string) {
  return name
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function interpolateCopy(value: string, vars?: Record<string, string | number>) {
  if (!vars) return value
  return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) => {
    const replacement = vars[key]
    return replacement === undefined ? match : String(replacement)
  })
}

function configuredCopy(
  configured: string | undefined,
  key: string,
  fallback: string,
  vars?: Record<string, string | number>,
) {
  const trimmed = configured?.trim()
  if (trimmed) return interpolateCopy(trimmed, vars)
  return t(key, fallback, vars)
}

function HomeBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{
        backgroundImage: [
          'linear-gradient(to bottom, color-mix(in srgb, var(--color-accent) 7%, transparent), transparent 52%)',
          'linear-gradient(rgba(148, 148, 172, 0.045) 1px, transparent 1px)',
          'linear-gradient(90deg, rgba(148, 148, 172, 0.04) 1px, transparent 1px)',
        ].join(', '),
        backgroundSize: '100% 100%, 56px 56px, 56px 56px',
        maskImage: 'linear-gradient(to bottom, rgba(0, 0, 0, 0.78), rgba(0, 0, 0, 0.38) 48%, transparent 88%)',
        WebkitMaskImage: 'linear-gradient(to bottom, rgba(0, 0, 0, 0.78), rgba(0, 0, 0, 0.38) 48%, transparent 88%)',
      }}
    />
  )
}

function HomeEyebrow({ brandName }: { brandName: string }) {
  return (
    <div
      className="mb-5 max-w-full inline-flex items-center gap-3 rounded-full px-3 py-1.5 text-[11px] font-medium text-text-secondary border border-border-subtle"
      style={{
        background: 'color-mix(in srgb, var(--color-elevated) 64%, transparent)',
        boxShadow: '0 16px 55px rgba(0, 0, 0, 0.18)',
      }}
    >
      <span
        className="h-px w-7"
        style={{ background: 'linear-gradient(90deg, transparent, color-mix(in srgb, var(--color-accent) 70%, var(--color-text-muted)))' }}
        aria-hidden="true"
      />
      <span className="truncate">{brandName}</span>
      <span
        className="h-px w-7"
        style={{ background: 'linear-gradient(90deg, color-mix(in srgb, var(--color-accent) 70%, var(--color-text-muted)), transparent)' }}
        aria-hidden="true"
      />
    </div>
  )
}

function ArrowUpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 13V3" />
      <path d="M3.5 7.5L8 3L12.5 7.5" />
    </svg>
  )
}

function ChevronRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 3L7.5 6L4.5 9" />
    </svg>
  )
}

function HomeComposer({ onSubmit, disabled, placeholder }: {
  onSubmit: (text: string, attachments: Attachment[]) => void | Promise<void>
  disabled: boolean
  placeholder: string
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    // Autofocus on mount — the composer is the primary action on Home,
    // so meeting the user with a ready cursor is the point.
    textareaRef.current?.focus()
  }, [])

  const autosize = () => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = Math.min(element.scrollHeight, MAX_COMPOSER_HEIGHT) + 'px'
  }

  const addFiles = useCallback(async (files: FileList | File[]) => {
    if (!files || files.length === 0) return
    const next = await filesToAttachments(files)
    setAttachments((current) => [...current, ...next])
  }, [])

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || disabled) return
    const currentAttachments = [...attachments]
    setText('')
    setAttachments([])
    autosize()
    await onSubmit(trimmed, currentAttachments)
  }, [text, attachments, disabled, onSubmit])

  // Composer chrome is deliberately quiet at rest — the borders use a
  // static `rgba` so the theme's purple accent never bleeds in through
  // `--color-border` when the textarea takes focus. A drop-over state
  // is the only thing that lights up the border, since that's a
  // discoverability cue we actually want the user to see.
  const restBorder = '1px solid rgba(148, 148, 172, 0.18)'
  const dropBorder = '1px solid var(--color-accent)'

  // The outer wrapper hosts drag-and-drop affordances. Drag-drop is
  // inherently pointer-only; keyboard users won't (and shouldn't) hit
  // these handlers. The inner `<textarea>` + send button are both real
  // interactive elements and cover the keyboard / screen-reader path.
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      role="group"
      aria-label={t('home.composer.dropZone', 'Composer — drop files to attach')}
      className="w-full"
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          setDragOver(true)
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={(event) => {
        // Only clear when leaving the composer entirely — onDragLeave
        // fires for every child too.
        if (event.currentTarget.contains(event.relatedTarget as Node)) return
        setDragOver(false)
      }}
      onDrop={async (event) => {
        event.preventDefault()
        setDragOver(false)
        const files = event.dataTransfer.files
        if (files.length > 0) await addFiles(files)
      }}
    >
      <ChatInputAttachments
        attachments={attachments}
        onRemove={(index) => setAttachments((prev) => prev.filter((_, currentIndex) => currentIndex !== index))}
      />
      <div
        className="w-full rounded-[18px] px-4 py-3 flex items-end gap-3 transition-colors"
        style={{
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--color-elevated) 86%, var(--color-base) 14%), color-mix(in srgb, var(--color-elevated) 70%, var(--color-base) 30%))',
          border: dragOver ? dropBorder : restBorder,
          boxShadow: dragOver
            ? '0 24px 80px color-mix(in srgb, var(--color-accent) 18%, transparent)'
            : '0 22px 80px rgba(0, 0, 0, 0.22), inset 0 1px rgba(255, 255, 255, 0.035)',
        }}
      >
        <textarea
          ref={textareaRef}
          data-no-focus-ring
          value={text}
          onChange={(event) => { setText(event.target.value); autosize() }}
          onPaste={async (event) => {
            // Clipboard images are the second path to a file attachment —
            // screenshot → Cmd-V into Home should just work without
            // forcing the user to drag from a Finder window.
            const items = event.clipboardData?.files
            if (!items || items.length === 0) return
            event.preventDefault()
            await addFiles(items)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void handleSubmit()
            }
          }}
          rows={1}
          placeholder={placeholder}
          disabled={disabled}
          // `max-h-[220px]` must match MAX_COMPOSER_HEIGHT above —
          // Tailwind JIT reads the literal at build time so we can't
          // interpolate the const into the class string.
          className="flex-1 bg-transparent text-[15px] text-text placeholder:text-text-muted resize-none outline-none min-h-[28px] max-h-[220px] leading-[1.45]"
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={disabled || (!text.trim() && attachments.length === 0)}
          aria-label={t('home.composer.send', 'Send')}
          className="shrink-0 w-9 h-9 rounded-full grid place-items-center transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer text-base hover:brightness-110"
          style={{
            background: 'var(--color-accent)',
            color: 'var(--color-accent-contrast, #fff)',
          }}
        >
          <ArrowUpIcon />
        </button>
      </div>
    </div>
  )
}

function AgentSuggestions({ agents, onPick, label }: {
  agents: Array<{ id: string; label: string; description: string }>
  onPick: (agentId: string) => void
  label: string
}) {
  if (agents.length === 0) return null
  return (
    <div className="mt-6 flex items-center justify-center flex-wrap gap-2">
      <span className="text-[11px] uppercase text-text-muted">
        {label}
      </span>
      {agents.slice(0, MAX_SUGGESTIONS).map((agent) => (
        <button
          key={agent.id}
          type="button"
          onClick={() => onPick(agent.id)}
          title={agent.description}
          className="px-3 py-1.5 rounded-full text-[12px] text-text-secondary border border-border-subtle bg-surface hover:text-text hover:bg-surface-hover hover:border-border transition-colors cursor-pointer"
        >
          @{agent.label}
        </button>
      ))}
    </div>
  )
}

function RecentThreads({ threads, onOpen }: {
  threads: SessionInfo[]
  onOpen: (sessionId: string) => void
}) {
  if (threads.length === 0) return null
  return (
    <div className="w-full mt-10">
      <div className="text-[11px] uppercase text-text-muted mb-3">
        {t('home.recent.title', 'Pick up where you left off')}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {threads.slice(0, MAX_RECENT_THREADS).map((thread) => (
          <button
            key={thread.id}
            type="button"
            onClick={() => onOpen(thread.id)}
            className="group text-start rounded-lg p-3 border border-border-subtle bg-elevated hover:border-border hover:bg-surface-hover transition-colors cursor-pointer"
          >
            <div
              className="h-px w-8 mb-3 transition-colors"
              style={{ background: 'color-mix(in srgb, var(--color-accent) 34%, var(--color-border-subtle))' }}
              aria-hidden="true"
            />
            <div className="text-[13px] font-medium text-text truncate">
              {thread.title || t('home.recent.untitled', 'Untitled thread')}
            </div>
            <div className="mt-1 text-[11px] text-text-muted truncate">
              {thread.updatedAt ? formatDate(thread.updatedAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function StatusStrip({ onOpenPulse, readyLabel }: { onOpenPulse: () => void; readyLabel: string }) {
  const mcpConnections = useSessionStore((s) => s.mcpConnections)
  const connected = mcpConnections.filter((conn) => conn.connected).length
  const total = mcpConnections.length

  return (
    <button
      type="button"
      onClick={onOpenPulse}
      className="mt-10 inline-flex items-center gap-3 px-4 py-2 rounded-full border border-border-subtle text-[12px] text-text-muted hover:text-text hover:bg-surface-hover transition-colors cursor-pointer"
      style={{
        background: 'color-mix(in srgb, var(--color-surface) 62%, transparent)',
      }}
    >
      <span className="inline-flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: total > 0 && connected === total ? 'var(--color-success)' : 'var(--color-warning)' }} />
        {readyLabel}
      </span>
      <span className="opacity-40">·</span>
      <span>{t('home.statusStrip.mcps', '{{connected}}/{{total}} MCPs', { connected, total })}</span>
      <span className="opacity-40">·</span>
      <span className="inline-flex items-center gap-1">
        {t('home.statusStrip.viewMore', 'Pulse')}
        <ChevronRightIcon />
      </span>
    </button>
  )
}

export function HomePage({ brandName, homeBranding, onStartThread, onOpenPulse, onOpenThread }: Props) {
  const sessions = useSessionStore((s) => s.sessions)
  const [builtinAgents, setBuiltinAgents] = useState<BuiltInAgentDetail[]>([])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    window.coworkApi.app.builtinAgents()
      .then((agents) => setBuiltinAgents(agents || []))
      .catch(() => setBuiltinAgents([]))
  }, [])

  const suggestedAgents = useMemo(() => {
    return builtinAgents
      .filter((agent) => agent.mode === 'subagent' && !agent.hidden)
      .map((agent) => ({
        id: agent.name,
        label: agent.label || formatAgentLabel(agent.name),
        description: agent.description || '',
      }))
      .slice(0, MAX_SUGGESTIONS)
  }, [builtinAgents])

  const recentThreads = useMemo(
    () => sessions.filter((session) => (session.kind || 'interactive') === 'interactive').slice(0, MAX_RECENT_THREADS),
    [sessions],
  )

  const handleSubmit = useCallback(async (text: string, attachments: Attachment[]) => {
    if (submitting) return
    setSubmitting(true)
    try {
      await onStartThread(text, attachments)
    } finally {
      setSubmitting(false)
    }
  }, [onStartThread, submitting])

  const handlePickAgent = useCallback((agentId: string) => {
    // Prefilling with `@agent ` relies on the chat-side parser —
    // `resolveDirectAgentInvocation` in chat-input-utils picks up the
    // leading mention and drops it before sending to the runtime. We
    // append a space so the user sees a ready cursor after the handle.
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea')
    if (!textarea) return
    const prefix = `@${agentId} `
    if (textarea.value.startsWith(prefix)) {
      textarea.focus()
      textarea.setSelectionRange(prefix.length, prefix.length)
      return
    }
    textarea.value = prefix + textarea.value.replace(/^@\S+\s*/, '')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.focus()
    textarea.setSelectionRange(prefix.length, prefix.length)
  }, [])

  const handleOpenThread = useCallback((sessionId: string) => {
    void onOpenThread(sessionId)
  }, [onOpenThread])

  const homeCopyVars = { brand: brandName }
  const greeting = configuredCopy(homeBranding?.greeting, GREETING_KEY, GREETING_FALLBACK, homeCopyVars)
  const subtitle = configuredCopy(
    homeBranding?.subtitle,
    'home.subtitle',
    '{{brand}} · Ask anything, or @mention an agent',
    homeCopyVars,
  )
  const composerPlaceholder = configuredCopy(
    homeBranding?.composerPlaceholder,
    'home.composer.placeholder',
    'Ask anything, or @mention an agent',
    homeCopyVars,
  )
  const suggestionLabel = configuredCopy(homeBranding?.suggestionLabel, 'home.suggestions.title', 'Try', homeCopyVars)
  const readyLabel = configuredCopy(homeBranding?.statusReadyLabel, 'home.statusStrip.ready', 'Ready', homeCopyVars)

  return (
    <div className="relative flex-1 min-h-0 overflow-y-auto" data-testid="home-view">
      <HomeBackdrop />
      <div className="relative max-w-[760px] mx-auto px-6 pt-[clamp(72px,13vh,142px)] pb-16 flex flex-col items-center">
        <HomeEyebrow brandName={brandName} />
        <h1 className="text-[30px] sm:text-[38px] leading-[1.08] font-semibold text-text text-center">
          {greeting}
        </h1>
        <p className="mt-3 text-[13px] text-text-muted text-center">
          {subtitle}
        </p>

        <div className="w-full mt-9">
          <HomeComposer
            onSubmit={handleSubmit}
            disabled={submitting}
            placeholder={composerPlaceholder}
          />
        </div>

        <AgentSuggestions agents={suggestedAgents} onPick={handlePickAgent} label={suggestionLabel} />

        <RecentThreads threads={recentThreads} onOpen={handleOpenThread} />

        <StatusStrip onOpenPulse={onOpenPulse} readyLabel={readyLabel} />
      </div>
    </div>
  )
}
