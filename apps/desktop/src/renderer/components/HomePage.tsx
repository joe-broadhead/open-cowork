import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BrandingHomeConfig, OperationsSummary, SessionInfo, SessionPromptOptions } from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'
import { formatDate, t } from '../helpers/i18n'
import { ChatInputAttachments } from './chat/ChatInputAttachments'
import { ChatInputInlinePicker } from './chat/ChatInputInlinePicker'
import { ChatInputModelMenu } from './chat/ChatInputModelMenu'
import { ChatInputReasoningMenu, formatReasoningVariantLabel } from './chat/ChatInputReasoningMenu'
import { ChatInputToolbar } from './chat/ChatInputToolbar'
import {
  detectInlineTrigger,
  filesToAttachments,
  resolveDirectAgentInvocation,
} from './chat/chat-input-utils'
import { useChatRuntimeSelection, useMentionableAgents, useReasoningVariantSelection } from './chat/useChatInputRuntime'
import type { Attachment, InlinePickerState, MentionableAgent } from './chat/chat-input-types'
import { isOperationsCommandCenterEnabled } from './operations/operations-ui'

// Home is the welcoming landing surface. We deliberately moved the
// diagnostic dashboard (runtime pills, MCP status, usage metrics, perf
// stats) to PulsePage so Home can focus on a single ask: start a
// conversation. Power users click into Pulse when they want the
// workspace at-a-glance view; business users see a composer + a warm
// greeting and get straight to work.

interface Props {
  brandName: string
  homeBranding?: BrandingHomeConfig
  onStartThread: (text: string, attachments?: Attachment[], agent?: string, options?: SessionPromptOptions) => Promise<void>
  onOpenPulse: () => void
  onOpenOperations?: () => void
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

function compactCount(value: number) {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

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

function ChevronRightIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 3L7.5 6L4.5 9" />
    </svg>
  )
}

function HomeComposer({ onSubmit, disabled, placeholder, specialistAgents, prefillAgent }: {
  onSubmit: (text: string, attachments: Attachment[], agent?: string, options?: SessionPromptOptions) => void | Promise<void>
  disabled: boolean
  placeholder: string
  specialistAgents: MentionableAgent[]
  prefillAgent: { id: string; nonce: number } | null
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [showReasoningMenu, setShowReasoningMenu] = useState(false)
  const [inlinePicker, setInlinePicker] = useState<InlinePickerState | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const inputChromeRef = useRef<HTMLDivElement>(null)
  const inlinePickerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelBtnRef = useRef<HTMLButtonElement>(null)
  const reasoningBtnRef = useRef<HTMLButtonElement>(null)
  const agentMode = useSessionStore((s) => s.agentMode)
  const setAgentMode = useSessionStore((s) => s.setAgentMode)
  const addGlobalError = useSessionStore((s) => s.addGlobalError)
  const { currentModel, setCurrentModel, provider, availableModels } = useChatRuntimeSelection()
  const reasoningSelection = useReasoningVariantSelection(provider, currentModel, availableModels)

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

  useEffect(() => {
    if (!prefillAgent) return
    const prefix = `@${prefillAgent.id} `
    setInlinePicker(null)
    setText((current) => {
      if (current.startsWith(prefix)) return current
      return prefix + current.replace(/^@\S+\s*/, '')
    })
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(prefix.length, prefix.length)
      autosize()
    })
  }, [prefillAgent])

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || disabled) return
    const directInvocation = resolveDirectAgentInvocation(trimmed, specialistAgents)
    const promptText = directInvocation.text
    if (!promptText && attachments.length === 0) return
    const currentAttachments = [...attachments]
    setText('')
    setAttachments([])
    setInlinePicker(null)
    autosize()
    const promptAgent = directInvocation.agent || agentMode
    if (reasoningSelection.promptOptions) {
      await onSubmit(promptText, currentAttachments, promptAgent, reasoningSelection.promptOptions)
    } else {
      await onSubmit(promptText, currentAttachments, promptAgent)
    }
  }, [text, attachments, disabled, onSubmit, specialistAgents, agentMode, reasoningSelection.promptOptions])

  const inlineSuggestions = useMemo(() => {
    if (!inlinePicker) return []
    const normalizedQuery = inlinePicker.query.trim().toLowerCase()
    if (!normalizedQuery) return specialistAgents.slice(0, 6)
    return specialistAgents
      .filter((item) =>
        item.id.toLowerCase().includes(normalizedQuery) ||
        item.label.toLowerCase().includes(normalizedQuery) ||
        item.description.toLowerCase().includes(normalizedQuery),
      )
      .slice(0, 6)
  }, [inlinePicker, specialistAgents])

  const insertInlineSuggestion = useCallback((item: MentionableAgent) => {
    if (!inlinePicker || !textareaRef.current) return
    const inserted = `${inlinePicker.trigger}${item.id} `
    const nextValue = `${text.slice(0, inlinePicker.start)}${inserted}${text.slice(inlinePicker.end)}`
    const nextCursor = inlinePicker.start + inserted.length

    setText(nextValue)
    setInlinePicker(null)
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(nextCursor, nextCursor)
      autosize()
    })
  }, [inlinePicker, text])

  useEffect(() => {
    if (!inlinePicker) return

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (inlinePickerRef.current?.contains(target)) return
      if (textareaRef.current?.contains(target)) return
      setInlinePicker(null)
    }

    document.addEventListener('mousedown', handlePointerDown, true)
    return () => document.removeEventListener('mousedown', handlePointerDown, true)
  }, [inlinePicker])

  // Composer chrome is deliberately quiet at rest — the borders use a
  // static `rgba` so the theme's purple accent never bleeds in through
  // `--color-border` when the textarea takes focus. A drop-over state
  // is the only thing that lights up the border, since that's a
  // discoverability cue we actually want the user to see.
  const restBorder = '1px solid rgba(148, 148, 172, 0.18)'
  const dropBorder = '1px solid var(--color-accent)'
  const currentModelLabel = (availableModels[provider] || []).find((model) => model.id === currentModel)?.label || currentModel || t('chat.modelFallback', 'Model')
  const canSend = !disabled && (text.trim() || attachments.length > 0)
  const inlineMenuWidth = 260
  const chromeRect = inputChromeRef.current?.getBoundingClientRect()
  const anchorRect = chromeRect || textareaRef.current?.getBoundingClientRect() || null
  const inlineMenuLeft = anchorRect
    ? Math.max(
        12,
        Math.min(
          anchorRect.left,
          (typeof window !== 'undefined' ? window.innerWidth : 0) - inlineMenuWidth - 12,
        ),
      )
    : 0
  const inlineMenuTop = anchorRect ? anchorRect.top : 0

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
        onRemove={(id) => setAttachments((prev) => prev.filter((attachment) => attachment.id !== id))}
      />
      <div
        ref={inputChromeRef}
        className="w-full rounded-t-[18px] px-4 py-3 flex items-end gap-3 transition-colors"
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
          onChange={(event) => {
            const target = event.target
            setText(target.value)
            const cursor = target.selectionStart ?? target.value.length
            const triggerState = detectInlineTrigger(target.value, cursor)
            setInlinePicker(triggerState ? { ...triggerState, selectedIndex: 0 } : null)
            autosize()
          }}
          onSelect={(event) => {
            const target = event.currentTarget
            const cursor = target.selectionStart ?? target.value.length
            const triggerState = detectInlineTrigger(target.value, cursor)
            setInlinePicker((current) => {
              if (!triggerState) return null
              return {
                ...triggerState,
                selectedIndex: current?.trigger === triggerState.trigger && current.query === triggerState.query
                  ? current.selectedIndex
                  : 0,
              }
            })
          }}
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
            if (inlinePicker && inlineSuggestions.length > 0) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setInlinePicker((current) => current ? ({
                  ...current,
                  selectedIndex: Math.min(current.selectedIndex + 1, inlineSuggestions.length - 1),
                }) : current)
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setInlinePicker((current) => current ? ({
                  ...current,
                  selectedIndex: Math.max(current.selectedIndex - 1, 0),
                }) : current)
                return
              }
              if ((event.key === 'Enter' || event.key === 'Tab') && inlineSuggestions[inlinePicker.selectedIndex]) {
                event.preventDefault()
                insertInlineSuggestion(inlineSuggestions[inlinePicker.selectedIndex]!)
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setInlinePicker(null)
                return
              }
            }
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
      </div>
      <div
        className="rounded-b-[18px] border-x border-b"
        style={{
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--color-elevated) 72%, var(--color-base) 28%), color-mix(in srgb, var(--color-elevated) 62%, var(--color-base) 38%))',
          borderColor: dragOver ? 'var(--color-accent)' : 'rgba(148, 148, 172, 0.18)',
          marginTop: '-1px',
        }}
      >
        <ChatInputToolbar
          fileInputRef={fileInputRef}
          modelButtonRef={modelBtnRef}
          reasoningButtonRef={reasoningBtnRef}
          modelLabel={currentModelLabel}
          reasoningLabel={formatReasoningVariantLabel(reasoningSelection.reasoningVariant)}
          showReasoningControl={reasoningSelection.supportsReasoning}
          currentDirectory={null}
          agentMode={agentMode}
          currentSessionId={null}
          isGenerating={false}
          isAwaitingPermission={false}
          isAwaitingQuestion={false}
          canSend={!!canSend}
          onAddFiles={addFiles}
          onToggleModelMenu={() => {
            setInlinePicker(null)
            setShowReasoningMenu(false)
            setShowModelMenu(!showModelMenu)
          }}
          onToggleReasoningMenu={() => {
            setInlinePicker(null)
            setShowModelMenu(false)
            setShowReasoningMenu(!showReasoningMenu)
          }}
          onToggleAgentMode={() => setAgentMode(agentMode === 'build' ? 'plan' : 'build')}
          onFork={() => undefined}
          onStop={() => undefined}
          onSubmit={handleSubmit}
        />
      </div>
      <ChatInputInlinePicker
        picker={inlinePicker}
        suggestions={inlineSuggestions}
        pickerRef={inlinePickerRef}
        left={inlineMenuLeft}
        top={inlineMenuTop}
        onSelect={insertInlineSuggestion}
      />
      <ChatInputModelMenu
        visible={showModelMenu}
        anchorRect={modelBtnRef.current?.getBoundingClientRect() || null}
        models={availableModels[provider] || []}
        currentModel={currentModel}
        onClose={() => setShowModelMenu(false)}
        onSelect={async (modelId) => {
          const previousModel = currentModel
          setCurrentModel(modelId)
          setShowModelMenu(false)
          try {
            await window.coworkApi.settings.set({ selectedModelId: modelId })
          } catch (error) {
            setCurrentModel(previousModel)
            addGlobalError(t('chat.modelSaveFailed', 'Could not save the selected model. Please try again.'))
            try {
              window.coworkApi?.diagnostics?.reportRendererError?.({
                message: `Failed to save selected model: ${error instanceof Error ? error.message : String(error)}`,
                stack: error instanceof Error ? error.stack : undefined,
                view: 'home',
              })
            } catch {
              // Diagnostics are best effort from a recovery path.
            }
          }
        }}
      />
      <ChatInputReasoningMenu
        visible={showReasoningMenu}
        anchorRect={reasoningBtnRef.current?.getBoundingClientRect() || null}
        variants={reasoningSelection.reasoningVariants}
        currentVariant={reasoningSelection.reasoningVariant}
        onClose={() => setShowReasoningMenu(false)}
        onSelect={reasoningSelection.setReasoningVariant}
      />
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

function OperationsSummaryStrip({
  summary,
  onOpen,
}: {
  summary: OperationsSummary | null
  onOpen: () => void
}) {
  if (!summary) return null
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mt-8 grid w-full grid-cols-4 overflow-hidden rounded-lg border border-border-subtle bg-elevated text-start transition-colors hover:border-border hover:bg-surface-hover"
    >
      <div className="border-e border-border-subtle px-3 py-3">
        <div className="text-[10px] uppercase text-text-muted">{t('home.operations.attention', 'Attention')}</div>
        <div className="mt-1 text-[18px] font-semibold text-text">{compactCount(summary.needsAttention)}</div>
      </div>
      <div className="border-e border-border-subtle px-3 py-3">
        <div className="text-[10px] uppercase text-text-muted">{t('home.operations.running', 'Running')}</div>
        <div className="mt-1 text-[18px] font-semibold text-text">{compactCount(summary.running)}</div>
      </div>
      <div className="border-e border-border-subtle px-3 py-3">
        <div className="text-[10px] uppercase text-text-muted">{t('home.operations.failed', 'Failed')}</div>
        <div className="mt-1 text-[18px] font-semibold text-text">{compactCount(summary.failed)}</div>
      </div>
      <div className="px-3 py-3">
        <div className="text-[10px] uppercase text-text-muted">{t('home.operations.total', 'Total')}</div>
        <div className="mt-1 text-[18px] font-semibold text-text">{compactCount(summary.totalWorkItems)}</div>
      </div>
    </button>
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

export function HomePage({ brandName, homeBranding, onStartThread, onOpenPulse, onOpenOperations, onOpenThread }: Props) {
  const sessions = useSessionStore((s) => s.sessions)
  const [submitting, setSubmitting] = useState(false)
  const [agentPrefill, setAgentPrefill] = useState<{ id: string; nonce: number } | null>(null)
  const [operationsSummary, setOperationsSummary] = useState<OperationsSummary | null>(null)
  const operationsEnabled = useMemo(() => isOperationsCommandCenterEnabled(), [])
  const specialistAgents = useMentionableAgents(null)

  const suggestedAgents = useMemo(() => {
    return specialistAgents
      .map((agent) => ({
        id: agent.id,
        label: agent.label || formatAgentLabel(agent.id),
        description: agent.description || '',
      }))
      .slice(0, MAX_SUGGESTIONS)
  }, [specialistAgents])

  const recentThreads = useMemo(
    () => sessions.filter((session) => (session.kind || 'interactive') === 'interactive').slice(0, MAX_RECENT_THREADS),
    [sessions],
  )

  const handleSubmit = useCallback(async (text: string, attachments: Attachment[], agent?: string, options?: SessionPromptOptions) => {
    if (submitting) return
    setSubmitting(true)
    try {
      if (options) {
        await onStartThread(text, attachments, agent, options)
      } else {
        await onStartThread(text, attachments, agent)
      }
    } finally {
      setSubmitting(false)
    }
  }, [onStartThread, submitting])

  const handlePickAgent = useCallback((agentId: string) => {
    setAgentPrefill({ id: agentId, nonce: Date.now() })
  }, [])

  const handleOpenThread = useCallback((sessionId: string) => {
    void onOpenThread(sessionId)
  }, [onOpenThread])

  useEffect(() => {
    if (!operationsEnabled) return
    let cancelled = false
    window.coworkApi.operations.summary()
      .then((summary) => {
        if (!cancelled) setOperationsSummary(summary)
      })
      .catch(() => {
        if (!cancelled) setOperationsSummary(null)
      })
    return () => {
      cancelled = true
    }
  }, [operationsEnabled])

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
            specialistAgents={specialistAgents}
            prefillAgent={agentPrefill}
          />
        </div>

        <AgentSuggestions agents={suggestedAgents} onPick={handlePickAgent} label={suggestionLabel} />

        {operationsEnabled && onOpenOperations ? (
          <OperationsSummaryStrip summary={operationsSummary} onOpen={onOpenOperations} />
        ) : null}

        <RecentThreads threads={recentThreads} onOpen={handleOpenThread} />

        <StatusStrip onOpenPulse={onOpenPulse} readyLabel={readyLabel} />
      </div>
    </div>
  )
}
