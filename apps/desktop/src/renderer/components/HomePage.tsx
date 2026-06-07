import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BrandingHomeConfig, SessionInfo, SessionPromptOptions } from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'
import { useActiveWorkspaceSupport } from '../stores/workspace-support'
import { LOCAL_WORKSPACE_ID } from '../stores/session-workspace-keys'
import { formatAgentLabel } from '../helpers/agent-label'
import { formatDate, t } from '../helpers/i18n'
import { summarizeMcpConnections } from '../helpers/mcp-status-summary'
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
import {
  Badge,
  Card,
  CoworkerCard,
  EmptyState,
  Icon,
  IconButton,
  ProjectCard,
  ReviewPanel,
  TaskLane,
  type StudioTone,
} from './ui'

// Home is the welcoming landing surface for the simplified core product:
// start a normal chat, @mention a coworker, or pick up recent work.

interface Props {
  brandName: string
  homeBranding?: BrandingHomeConfig
  onStartThread: (text: string, attachments?: Attachment[], agent?: string, options?: SessionPromptOptions) => Promise<void>
  onOpenThread: (sessionId: string) => void | Promise<void>
}

// Single, stable greeting. We experimented with a rotation but the
// product voice is clearer with one line: it's the tagline for the
// landing surface, not a random fortune-cookie. The i18n key stays
// so downstream forks can retune the voice without patching this file.
const GREETING_KEY = 'studioHome.greeting'
const GREETING_FALLBACK = 'What should your team tackle today?'

// Cap on how many coworker cards and how many recent project chats we
// show. Kept small deliberately — the page is "get started", not
// "everything at once".
const MAX_SUGGESTIONS = 4
const MAX_RECENT_THREADS = 3
const HOME_COACHMARK_DISMISSED_KEY = 'open-cowork-home-coachmark-dismissed'

// Upper bound on the composer's auto-grow. Past ~220px the textarea
// starts to dominate the landing page and push everything below the
// fold. The value matches ChatInput's own ceiling so the UX feels
// consistent across Home → chat transitions.
const MAX_COMPOSER_HEIGHT = 220

const EXAMPLE_PROMPTS = [
  {
    title: 'Plan a release',
    prompt: 'Draft a release plan for the next milestone.',
  },
  {
    title: 'Review a change',
    prompt: 'Review the recent changes and call out production risks.',
  },
  {
    title: 'Create a workflow',
    prompt: 'Help me turn a repeated task into a saved workflow.',
  },
  {
    title: 'Investigate an issue',
    prompt: 'Trace this bug from symptoms to a concrete fix.',
  },
]

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

function readHomeCoachmarkDismissed() {
  try {
    return window.localStorage.getItem(HOME_COACHMARK_DISMISSED_KEY) === 'true'
  } catch {
    return false
  }
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

function HomeComposer({
  onSubmit,
  disabled,
  placeholder,
  specialistAgents,
  prefillAgent,
  prefillPrompt,
  workspaceOptions,
  canPrompt = true,
  sendDisabledReason = null,
  attachmentsAllowed = true,
  attachmentsDisabledReason = null,
  modelControlsManaged = false,
  modelControlsReason = null,
}: {
  onSubmit: (text: string, attachments: Attachment[], agent?: string, options?: SessionPromptOptions) => void | Promise<void>
  disabled: boolean
  placeholder: string
  specialistAgents: MentionableAgent[]
  prefillAgent: { id: string; nonce: number } | null
  prefillPrompt: { text: string; nonce: number } | null
  workspaceOptions?: { workspaceId: string }
  canPrompt?: boolean
  sendDisabledReason?: string | null
  attachmentsAllowed?: boolean
  attachmentsDisabledReason?: string | null
  modelControlsManaged?: boolean
  modelControlsReason?: string | null
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
  const attachmentPolicyReason = attachmentsDisabledReason || t('chat.attachFileDisabled', 'File attachments are disabled by this workspace policy.')
  const promptPolicyReason = sendDisabledReason || t('chat.sendDisabled', 'Prompting is disabled by this workspace policy.')
  const { currentModel, setCurrentModel, provider, availableModels } = useChatRuntimeSelection(null, workspaceOptions)
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
    if (!attachmentsAllowed) {
      addGlobalError(attachmentPolicyReason)
      return
    }
    const next = await filesToAttachments(files)
    setAttachments((current) => [...current, ...next])
  }, [addGlobalError, attachmentPolicyReason, attachmentsAllowed])

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

  useEffect(() => {
    if (!prefillPrompt) return
    setInlinePicker(null)
    setText(prefillPrompt.text)
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      const cursor = prefillPrompt.text.length
      textarea.setSelectionRange(cursor, cursor)
      autosize()
    })
  }, [prefillPrompt])

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || disabled) return
    if (!canPrompt) {
      addGlobalError(promptPolicyReason)
      return
    }
    if (attachments.length > 0 && !attachmentsAllowed) {
      addGlobalError(attachmentPolicyReason)
      return
    }
    const directInvocation = resolveDirectAgentInvocation(trimmed, specialistAgents)
    const promptText = directInvocation.text || (attachments.length > 0 ? t('home.imageOnlyPrompt', 'Describe this image.') : '')
    if (!promptText && attachments.length === 0) return
    const currentAttachments = [...attachments]
    const promptAgent = directInvocation.agent || agentMode
    const promptOptions = modelControlsManaged ? undefined : reasoningSelection.promptOptions
    if (promptOptions) {
      await onSubmit(promptText, currentAttachments, promptAgent, promptOptions)
    } else {
      await onSubmit(promptText, currentAttachments, promptAgent)
    }
    setText('')
    setAttachments([])
    setInlinePicker(null)
    autosize()
  }, [text, attachments, disabled, canPrompt, attachmentsAllowed, specialistAgents, agentMode, modelControlsManaged, reasoningSelection.promptOptions, onSubmit, addGlobalError, promptPolicyReason, attachmentPolicyReason])

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
  const policyBlockedReason = !canPrompt
    ? promptPolicyReason
    : attachments.length > 0 && !attachmentsAllowed
      ? attachmentPolicyReason
      : null
  const canSend = !disabled && !policyBlockedReason && (text.trim() || attachments.length > 0)
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
      {attachments.length > 0 && !text.trim() && (
        <div className="mt-2 flex justify-end">
          <span className="home-image-hint">
            <Icon name="file" size={16} />
            {t('home.imageOnlyHint', "Will ask: 'Describe this image'")}
          </span>
        </div>
      )}
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
          sendDisabledReason={policyBlockedReason}
          onAddFiles={addFiles}
          attachmentsAllowed={attachmentsAllowed}
          attachmentsDisabledReason={attachmentPolicyReason}
          modelControlsManaged={modelControlsManaged}
          modelControlsReason={modelControlsReason}
          reasoningControlsManaged={modelControlsManaged}
          onToggleModelMenu={() => {
            if (modelControlsManaged) return
            setInlinePicker(null)
            setShowReasoningMenu(false)
            setShowModelMenu(!showModelMenu)
          }}
          onToggleReasoningMenu={() => {
            if (modelControlsManaged) return
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
          if (modelControlsManaged) return
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

function coworkerTone(index: number): StudioTone {
  const tones: StudioTone[] = ['strategist', 'builder', 'reviewer', 'operator']
  return tones[index % tones.length] || 'neutral'
}

function LeadCoworkers({
  agents,
  onPick,
  label,
  agentMode,
  onSetAgentMode,
}: {
  agents: Array<{ id: string; label: string; description: string }>
  onPick: (agentId: string) => void
  agentMode: 'build' | 'plan'
  onSetAgentMode: (mode: 'build' | 'plan') => void
  label: string
}) {
  return (
    <div className="home-studio-section w-full mt-9">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase text-text-muted">{label}</div>
          <div className="mt-1 text-[13px] text-text-secondary">
            {t('home.coworkers.subtitle', 'Choose a lead mode or mention a specialist coworker from the OpenCode agent catalog.')}
          </div>
        </div>
        <Badge tone="accent">{agentMode === 'build' ? t('home.coworkers.building', 'Build lead') : t('home.coworkers.planning', 'Plan lead')}</Badge>
      </div>
      <div className="home-coworker-grid">
        <CoworkerCard
          name={t('home.coworkers.build.name', 'Build')}
          role={t('home.coworkers.build.role', 'Lead implementation coworker')}
          summary={t('home.coworkers.build.summary', 'Best for concrete edits, tests, packaging, and production follow-through.')}
          tone="builder"
          mode={agentMode === 'build' ? t('home.coworkers.active', 'Active') : undefined}
          status={{ label: agentMode === 'build' ? t('home.coworkers.selected', 'Selected') : t('home.coworkers.available', 'Available'), tone: agentMode === 'build' ? 'success' : 'neutral' }}
          actions={[{
            id: 'build',
            children: t('home.coworkers.useBuild', 'Use Build'),
            variant: agentMode === 'build' ? 'primary' : 'secondary',
            onClick: () => onSetAgentMode('build'),
          }]}
        />
        <CoworkerCard
          name={t('home.coworkers.plan.name', 'Plan')}
          role={t('home.coworkers.plan.role', 'Lead strategy coworker')}
          summary={t('home.coworkers.plan.summary', 'Best for scoping, decomposing risky work, and deciding what should happen before code changes.')}
          tone="strategist"
          mode={agentMode === 'plan' ? t('home.coworkers.active', 'Active') : undefined}
          status={{ label: agentMode === 'plan' ? t('home.coworkers.selected', 'Selected') : t('home.coworkers.available', 'Available'), tone: agentMode === 'plan' ? 'success' : 'neutral' }}
          actions={[{
            id: 'plan',
            children: t('home.coworkers.usePlan', 'Use Plan'),
            variant: agentMode === 'plan' ? 'primary' : 'secondary',
            onClick: () => onSetAgentMode('plan'),
          }]}
        />
        {agents.slice(0, MAX_SUGGESTIONS).map((agent, index) => (
          <CoworkerCard
            key={agent.id}
            name={agent.label}
            role={t('home.coworkers.specialistRole', 'Specialist coworker')}
            summary={agent.description || t('home.coworkers.specialistSummary', 'Focused delegated work through an OpenCode agent.')}
            tone={coworkerTone(index)}
            mode={`@${agent.id}`}
            status={{ label: t('home.coworkers.mentionable', 'Mentionable'), tone: 'accent' }}
            actions={[{
              id: agent.id,
              children: `@${agent.label}`,
              variant: 'ghost',
              onClick: () => onPick(agent.id),
            }]}
          />
        ))}
      </div>
    </div>
  )
}

function FirstRunExamples({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="w-full mt-7">
      <EmptyState
        icon="sparkles"
        title={t('home.firstRunTitle', 'Start with an example')}
        body={t('home.firstRunBody', 'Pick a prompt to prefill the composer, then adjust it for your work.')}
      />
      <div className="home-example-grid">
        {EXAMPLE_PROMPTS.map((example) => (
          <Card
            key={example.title}
            interactive
            padding="md"
            onClick={() => onPick(example.prompt)}
            aria-label={`${example.title}: ${example.prompt}`}
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 text-accent">
                <Icon name="sparkles" size={16} />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-text">{example.title}</span>
                <span className="mt-1 block text-[11px] leading-snug text-text-muted">{example.prompt}</span>
              </span>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}

function HomeCoachmark({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="home-coachmark mt-7">
      <div className="flex min-w-0 items-center gap-2">
        <Icon name="sparkles" size={16} className="shrink-0 text-accent" />
        <span className="min-w-0">{t('studioHome.coachmark', 'Type a prompt, attach context, or @mention a coworker — ⌘K for commands.')}</span>
      </div>
      <IconButton
        icon="x"
        label={t('home.dismissCoachmark', 'Dismiss Home tip')}
        size="sm"
        onClick={onDismiss}
      />
    </div>
  )
}

function RecentProjects({ threads, onOpen }: {
  threads: SessionInfo[]
  onOpen: (sessionId: string) => void
}) {
  if (threads.length === 0) return null
  return (
    <div className="w-full mt-10">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase text-text-muted">
            {t('home.recent.title', 'Pick up where you left off')}
          </div>
          <div className="mt-1 text-[13px] text-text-secondary">
            {t('home.recent.subtitle', 'Recent project chats stay backed by real OpenCode sessions.')}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {threads.slice(0, MAX_RECENT_THREADS).map((thread) => (
          <ProjectCard
            key={thread.id}
            title={thread.title || t('home.recent.untitled', 'Untitled project chat')}
            description={thread.directory || t('home.recent.chatOnly', 'Chat-only project')}
            status={{ label: t('home.recent.open', 'Open'), tone: 'accent' }}
            meta={thread.updatedAt ? formatDate(thread.updatedAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : null}
            actions={[{
              id: 'open',
              children: t('home.recent.openChat', 'Open chat'),
              onClick: () => onOpen(thread.id),
              variant: 'secondary',
              rightIcon: 'chevron-right',
            }]}
          />
        ))}
      </div>
    </div>
  )
}

function HomeReviewSnapshot({
  pendingApprovals,
  pendingQuestions,
  taskCount,
}: {
  pendingApprovals: number
  pendingQuestions: number
  taskCount: number
}) {
  const totalInput = pendingApprovals + pendingQuestions
  if (totalInput === 0 && taskCount === 0) return null
  return (
    <div className="w-full mt-8">
      <ReviewPanel
        title={t('home.review.title', 'Review Snapshot')}
        summary={t('home.review.summary', 'Live review state from the active OpenCode session projection.')}
        status={{ label: totalInput > 0 ? t('home.review.needsInput', 'Needs input') : t('home.review.clear', 'Clear'), tone: totalInput > 0 ? 'warning' : 'success' }}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <TaskLane
            title={t('home.review.decisions', 'Decisions')}
            tone="approval"
            items={[
              ...(pendingApprovals > 0 ? [{
                id: 'approvals',
                title: t('home.review.approvals', 'Permission approvals'),
                meta: t('home.review.pendingCount', '{{count}} pending', { count: pendingApprovals }),
                status: { label: t('home.review.open', 'Open'), tone: 'warning' as const },
              }] : []),
              ...(pendingQuestions > 0 ? [{
                id: 'questions',
                title: t('home.review.questions', 'Questions'),
                meta: t('home.review.pendingCount', '{{count}} pending', { count: pendingQuestions }),
                status: { label: t('home.review.open', 'Open'), tone: 'warning' as const },
              }] : []),
            ]}
            emptyLabel={t('home.review.noDecisions', 'No decisions waiting')}
          />
          <TaskLane
            title={t('home.review.coworkers', 'Coworker Activity')}
            tone="delegated"
            items={taskCount > 0 ? [{
              id: 'task-runs',
              title: t('home.review.specialistLanes', 'Specialist lanes'),
              meta: t('home.review.taskCount', '{{count}} task runs', { count: taskCount }),
              status: { label: t('home.review.projected', 'Projected'), tone: 'accent' },
            }] : []}
            emptyLabel={t('home.review.noCoworkers', 'No delegated runs active')}
          />
        </div>
      </ReviewPanel>
    </div>
  )
}

function StatusStrip({ readyLabel }: { readyLabel: string }) {
  const mcpConnections = useSessionStore((s) => s.mcpConnections)
  const summary = summarizeMcpConnections(mcpConnections)
  const connected = summary.connected.length
  const total = summary.total

  return (
    <div className="home-status-strip mt-10 inline-flex items-center gap-3 px-4 py-2 rounded-full border border-border-subtle text-[12px] text-text-muted">
      <span className="inline-flex items-center gap-1.5">
        <Badge tone={total > 0 && connected === total ? 'success' : 'warning'}>
          {readyLabel}
        </Badge>
      </span>
      <span className="opacity-40">·</span>
      <span>{t('home.statusStrip.mcps', '{{connected}}/{{total}} MCPs', { connected, total })}</span>
    </div>
  )
}

export function HomePage({ brandName, homeBranding, onStartThread, onOpenThread }: Props) {
  const sessions = useSessionStore((s) => s.sessions)
  const currentView = useSessionStore((s) => s.currentView)
  const agentMode = useSessionStore((s) => s.agentMode)
  const setAgentMode = useSessionStore((s) => s.setAgentMode)
  const [submitting, setSubmitting] = useState(false)
  const [agentPrefill, setAgentPrefill] = useState<{ id: string; nonce: number } | null>(null)
  const [promptPrefill, setPromptPrefill] = useState<{ text: string; nonce: number } | null>(null)
  const [coachmarkDismissed, setCoachmarkDismissed] = useState(readHomeCoachmarkDismissed)
  const workspaceSupport = useActiveWorkspaceSupport()
  const activeWorkspaceIsLocal = workspaceSupport.workspaceId === LOCAL_WORKSPACE_ID
  const workspaceOptions = useMemo(
    () => activeWorkspaceIsLocal ? undefined : { workspaceId: workspaceSupport.workspaceId },
    [activeWorkspaceIsLocal, workspaceSupport.workspaceId],
  )
  const specialistAgents = useMentionableAgents(null, workspaceOptions)

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
  const firstRun = recentThreads.length === 0

  const handleSubmit = useCallback(async (text: string, attachments: Attachment[], agent?: string, options?: SessionPromptOptions) => {
    if (submitting) return
    if (attachments.length > 0 && !workspaceSupport.flags.canAttachFiles) {
      useSessionStore.getState().addGlobalError(workspaceSupport.flags.reasons.attachFiles)
      return
    }
    setSubmitting(true)
    try {
      const scopedOptions = activeWorkspaceIsLocal
        ? options
        : { ...(options || {}), workspaceId: workspaceSupport.workspaceId }
      if (scopedOptions) {
        await onStartThread(text, attachments, agent, scopedOptions)
      } else {
        await onStartThread(text, attachments, agent)
      }
    } finally {
      setSubmitting(false)
    }
  }, [activeWorkspaceIsLocal, onStartThread, submitting, workspaceSupport.flags, workspaceSupport.workspaceId])

  const handlePickAgent = useCallback((agentId: string) => {
    setAgentPrefill({ id: agentId, nonce: Date.now() })
  }, [])

  const handlePickExample = useCallback((prompt: string) => {
    setPromptPrefill({ text: prompt, nonce: Date.now() })
  }, [])

  const handleDismissCoachmark = useCallback(() => {
    setCoachmarkDismissed(true)
    try {
      window.localStorage.setItem(HOME_COACHMARK_DISMISSED_KEY, 'true')
    } catch {
      // Home coachmark dismissal is cosmetic; ignore storage failures.
    }
  }, [])

  const handleOpenThread = useCallback((sessionId: string) => {
    void onOpenThread(sessionId)
  }, [onOpenThread])

  const homeCopyVars = { brand: brandName }
  const greeting = configuredCopy(homeBranding?.greeting, GREETING_KEY, GREETING_FALLBACK, homeCopyVars)
  const subtitle = configuredCopy(
    homeBranding?.subtitle,
    'studioHome.subtitle',
    '{{brand}} · Choose a lead coworker, @mention specialists, and review the work in one place',
    homeCopyVars,
  )
  const composerPlaceholder = configuredCopy(
    homeBranding?.composerPlaceholder,
    'studioHome.composer.placeholder',
    'Ask anything, or @mention a coworker',
    homeCopyVars,
  )
  const suggestionLabel = configuredCopy(homeBranding?.suggestionLabel, 'home.suggestions.title', 'Try', homeCopyVars)
  const agentNudgeLabel = firstRun && !homeBranding?.suggestionLabel
    ? t('studioHome.agentNudge', '@mention a coworker')
    : suggestionLabel
  const readyLabel = configuredCopy(homeBranding?.statusReadyLabel, 'home.statusStrip.ready', 'Ready', homeCopyVars)

  return (
    <div className="relative flex-1 min-h-0 overflow-y-auto" data-testid="home-view">
      <HomeBackdrop />
      <div className="measure-column relative px-6 pt-[clamp(72px,13vh,142px)] pb-16 flex flex-col items-center">
        <HomeEyebrow brandName={brandName} />
        <h1 className="font-display text-role-hero font-bold text-text text-center">
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
            prefillPrompt={promptPrefill}
            workspaceOptions={workspaceOptions}
            canPrompt={workspaceSupport.flags.canPrompt}
            sendDisabledReason={workspaceSupport.flags.reasons.prompt}
            attachmentsAllowed={workspaceSupport.flags.canAttachFiles}
            attachmentsDisabledReason={workspaceSupport.flags.reasons.attachFiles}
            modelControlsManaged={!workspaceSupport.flags.canUseMachineRuntimeConfig}
            modelControlsReason={workspaceSupport.flags.reasons.machineRuntimeConfig}
          />
        </div>

        {firstRun && !coachmarkDismissed && <HomeCoachmark onDismiss={handleDismissCoachmark} />}

        {firstRun && <FirstRunExamples onPick={handlePickExample} />}

        <LeadCoworkers
          agents={suggestedAgents}
          onPick={handlePickAgent}
          label={agentNudgeLabel}
          agentMode={agentMode}
          onSetAgentMode={setAgentMode}
        />

        <HomeReviewSnapshot
          pendingApprovals={currentView.pendingApprovals.length}
          pendingQuestions={currentView.pendingQuestions.length}
          taskCount={currentView.taskRuns.length}
        />

        <RecentProjects threads={recentThreads} onOpen={handleOpenThread} />

        <StatusStrip readyLabel={readyLabel} />
      </div>
    </div>
  )
}
