import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRovingMenuKeyboard } from './home/use-roving-menu-keyboard'
import { useDismissOnOutsidePointer } from './home/use-dismiss-on-outside-pointer'
import type {
  BrandingHomeConfig,
  LaunchpadFeedPayload,
  LaunchpadFreshArtifactItem,
  SessionPromptOptions,
} from '@open-cowork/shared'
import { useSessionStore, type PrimaryAgentMode } from '../stores/session'
import { useActiveWorkspaceSupport } from '../stores/workspace-support'
import { LOCAL_WORKSPACE_ID } from '../stores/session-workspace-keys'
import type { AppNavigationTarget } from '../app-types'
import { formatAgentLabel } from '../helpers/agent-label'
import { t } from '../helpers/i18n'
import { summarizeMcpConnections } from '../helpers/mcp-status-summary'
import { PRIMARY_AGENT_MODES, primaryAgentLeadLabel } from '../helpers/primary-agent-mode'
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
  Card,
  EmptyState,
  Icon,
  IconButton,
  type IconName,
  ReviewPanel,
  TaskLane,
} from './ui'
import { LaunchpadMotionGrid, MAX_MOTION_ITEMS } from './launchpad/LaunchpadMotionGrid'

// Home is the welcoming landing surface for the simplified core product:
// start a normal chat, @mention a coworker, or pick up recent work.

interface Props {
  brandName: string
  homeBranding?: BrandingHomeConfig
  onStartThread: (text: string, attachments?: Attachment[], agent?: string, options?: SessionPromptOptions) => Promise<void>
  onOpenThread: (sessionId: string) => void | Promise<void>
  onNavigate: (target: AppNavigationTarget) => void
}

// Single, stable greeting. We experimented with a rotation but the
// product voice is clearer with one line: it's the tagline for the
// landing surface, not a random fortune-cookie. The i18n key stays
// so downstream forks can retune the voice without patching this file.
const GREETING_KEY = 'studioHome.greeting'
const GREETING_FALLBACK = 'What should your team tackle today?'

// Prototype greeting: "Good evening." at 44px with the time-of-day word in accent.
// (The reference shows a personal name there; the desktop has no user-name source,
// so the time-of-day word carries the accent emphasis.)
function timeOfDayGreeting(): { lead: string; accent: string } {
  const hour = new Date().getHours()
  const accent = hour < 12
    ? t('studioHome.greeting.morning', 'morning')
    : hour < 18
      ? t('studioHome.greeting.afternoon', 'afternoon')
      : t('studioHome.greeting.evening', 'evening')
  return { lead: t('studioHome.greeting.lead', 'Good'), accent }
}

// Cap on how many coworker cards and how many recent project chats we
// show. Kept small deliberately — the page is "get started", not
// "everything at once".
const MAX_SUGGESTIONS = 4
const HOME_COACHMARK_DISMISSED_KEY = 'open-cowork-home-coachmark-dismissed'

// Upper bound on the composer's auto-grow. Past ~220px the textarea
// starts to dominate the landing page and push everything below the
// fold. The value matches ChatInput's own ceiling so the UX feels
// consistent across Home → chat transitions.
const MAX_COMPOSER_HEIGHT = 220

// Each starter card carries a tone so its icon sits in a soft colored tile
// (matching the Studio reference's teal/blue/amber suggestion tiles) instead of
// a flat inline accent icon. Tones map to the muted Mercury palette tokens.
type SuggestionTone = 'accent' | 'green' | 'amber' | 'info'

const EXAMPLE_PROMPTS = [
  {
    title: 'Plan a release',
    prompt: 'Draft a release plan for the next milestone.',
    agentMode: 'plan',
    icon: 'kanban',
    tone: 'accent',
  },
  {
    title: 'Review a change',
    prompt: 'Review the recent changes and call out production risks.',
    agentMode: 'build',
    icon: 'file-diff',
    tone: 'green',
  },
  {
    title: 'Create a workflow',
    prompt: 'Help me turn a repeated task into a saved workflow.',
    agentMode: 'chief-of-staff',
    icon: 'workflow',
    tone: 'amber',
  },
  {
    title: 'Investigate an issue',
    prompt: 'Trace this bug from symptoms to a concrete fix.',
    agentMode: 'build',
    icon: 'search',
    tone: 'info',
  },
] satisfies Array<{ title: string; prompt: string; agentMode: PrimaryAgentMode; icon: IconName; tone: SuggestionTone }>

const DEFAULT_PRIMARY_AGENT_MODE: PrimaryAgentMode = 'build'

function allowedPrimaryAgentModes(allowedAgents: string[] | null | undefined): PrimaryAgentMode[] {
  if (!allowedAgents) return [...PRIMARY_AGENT_MODES]
  const allowed = new Set(allowedAgents)
  return PRIMARY_AGENT_MODES.filter((mode) => allowed.has(mode))
}

function constrainedPrimaryAgentMode(mode: PrimaryAgentMode, allowedModes: PrimaryAgentMode[]) {
  return allowedModes.includes(mode) ? mode : (allowedModes[0] || DEFAULT_PRIMARY_AGENT_MODE)
}

function nextAllowedPrimaryAgentMode(mode: PrimaryAgentMode, allowedModes: PrimaryAgentMode[]) {
  const modes = allowedModes.length ? allowedModes : [DEFAULT_PRIMARY_AGENT_MODE]
  const currentIndex = modes.indexOf(mode)
  return modes[(currentIndex + 1) % modes.length] || modes[0] || DEFAULT_PRIMARY_AGENT_MODE
}

const EMPTY_LAUNCHPAD_FEED: LaunchpadFeedPayload = {
  generatedAt: '',
  inProgress: [],
  waitingOnYou: [],
  freshArtifacts: [],
  totals: {
    inProgress: 0,
    waitingOnYou: 0,
    freshArtifacts: 0,
  },
  truncated: {
    inProgress: false,
    waitingOnYou: false,
    freshArtifacts: false,
  },
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

function readHomeCoachmarkDismissed() {
  try {
    return window.localStorage.getItem(HOME_COACHMARK_DISMISSED_KEY) === 'true'
  } catch {
    return false
  }
}

function HomeComposer({
  onSubmit,
  disabled,
  placeholder,
  specialistAgents,
  allowedPrimaryModes,
  allowedAgentNames,
  fallbackAgent,
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
  allowedPrimaryModes: PrimaryAgentMode[]
  allowedAgentNames?: string[] | null
  fallbackAgent?: string | null
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
  const [showAssignMenu, setShowAssignMenu] = useState(false)
  const [inlinePicker, setInlinePicker] = useState<InlinePickerState | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const inputChromeRef = useRef<HTMLDivElement>(null)
  const inlinePickerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelBtnRef = useRef<HTMLButtonElement>(null)
  const reasoningBtnRef = useRef<HTMLButtonElement>(null)
  const assignBtnRef = useRef<HTMLButtonElement>(null)
  const assignMenuRef = useRef<HTMLDivElement>(null)
  const { onKeyDown: handleAssignMenuKeyDown } = useRovingMenuKeyboard(assignMenuRef, assignBtnRef, showAssignMenu, () => setShowAssignMenu(false))
  const agentMode = useSessionStore((s) => s.agentMode)
  const setAgentMode = useSessionStore((s) => s.setAgentMode)
  const addGlobalError = useSessionStore((s) => s.addGlobalError)
  const attachmentPolicyReason = attachmentsDisabledReason || t('chat.attachFileDisabled', 'File attachments are disabled by this workspace policy.')
  const promptPolicyReason = sendDisabledReason || t('chat.sendDisabled', 'Prompting is disabled by this workspace policy.')
  const { currentModel, setCurrentModel, provider, availableModels } = useChatRuntimeSelection(null, workspaceOptions)
  const reasoningSelection = useReasoningVariantSelection(provider, currentModel, availableModels)
  const assignOptions = [
    {
      id: 'build' as const,
      label: t('home.assign.build', 'Build'),
      role: t('home.assign.buildRole', 'Implementation lead'),
      summary: t('home.assign.buildSummary', 'Best for edits, tests, packaging, and follow-through.'),
    },
    {
      id: 'plan' as const,
      label: t('home.assign.plan', 'Plan'),
      role: t('home.assign.planRole', 'Strategy lead'),
      summary: t('home.assign.planSummary', 'Best for scoping, decomposition, and risk calls.'),
    },
    {
      id: 'chief-of-staff' as const,
      label: t('home.assign.cleo', 'Cleo'),
      role: t('home.assign.cleoRole', 'Chief-of-Staff'),
      summary: t('home.assign.cleoSummary', 'Best for turning objectives into assigned tasks.'),
    },
  ]
  const visibleAssignOptions = assignOptions.filter((option) => allowedPrimaryModes.includes(option.id))
  const primaryLeadAvailable = visibleAssignOptions.length > 0
  const activeAgentMode = constrainedPrimaryAgentMode(agentMode, allowedPrimaryModes)
  const activeAssignOption = visibleAssignOptions.find((option) => option.id === activeAgentMode) || visibleAssignOptions[0] || assignOptions[0]!

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
    if (directInvocation.agent && allowedAgentNames && !allowedAgentNames.includes(directInvocation.agent)) {
      addGlobalError(t('home.assign.agentNotAllowed', 'That coworker is not allowed by this cloud profile.'))
      return
    }
    const promptAgent = directInvocation.agent || (primaryLeadAvailable ? activeAgentMode : fallbackAgent || undefined)
    if (!promptAgent && !primaryLeadAvailable) {
      addGlobalError(t('home.assign.noAllowedAgent', 'This cloud profile does not expose an allowed coworker for Home prompts.'))
      return
    }
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
  }, [text, attachments, disabled, canPrompt, attachmentsAllowed, specialistAgents, allowedAgentNames, activeAgentMode, primaryLeadAvailable, fallbackAgent, modelControlsManaged, reasoningSelection.promptOptions, onSubmit, addGlobalError, promptPolicyReason, attachmentPolicyReason])

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

  useDismissOnOutsidePointer(Boolean(inlinePicker), () => setInlinePicker(null), [inlinePickerRef, textareaRef])
  useDismissOnOutsidePointer(showAssignMenu, () => setShowAssignMenu(false), [assignMenuRef, assignBtnRef])

  // Composer chrome is deliberately quiet at rest — the borders use a
  // static `rgba` so the theme's purple accent never bleeds in through
  // `--color-border` when the textarea takes focus. A drop-over state
  // is the only thing that lights up the border, since that's a
  // discoverability cue we actually want the user to see.
  const restBorder = '1px solid color-mix(in srgb, var(--color-border) 70%, transparent)'
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
        className="w-full rounded-t-[28px] px-4 py-3 grid gap-3 transition-colors"
        style={{
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--accent) 9%, transparent), transparent 55%), color-mix(in srgb, var(--color-elevated) 58%, transparent)',
          backdropFilter: 'blur(18px) saturate(1.12)',
          WebkitBackdropFilter: 'blur(18px) saturate(1.12)',
          border: dragOver ? dropBorder : restBorder,
          boxShadow: dragOver
            ? '0 18px 48px color-mix(in srgb, var(--color-accent) 16%, transparent)'
            : '0 26px 70px color-mix(in srgb, #000 40%, transparent), 0 0 0 1px color-mix(in srgb, var(--accent) 16%, transparent), 0 0 40px color-mix(in srgb, var(--accent) 10%, transparent), inset 0 1px color-mix(in srgb, #fff 5%, transparent)',
        }}
      >
        <div className="home-composer-assign-row">
          <span className="home-composer-assign-label">{t('home.assign.label', 'Assign to')}</span>
          <div className="relative min-w-0">
            <button
              ref={assignBtnRef}
              type="button"
              className="home-assign-pill"
              aria-haspopup="menu"
              aria-expanded={showAssignMenu}
              disabled={!primaryLeadAvailable}
              title={!primaryLeadAvailable ? t('home.assign.noPrimaryLead', 'This cloud profile does not expose a primary lead coworker.') : undefined}
              onClick={() => {
                if (!primaryLeadAvailable) return
                setInlinePicker(null)
                setShowModelMenu(false)
                setShowReasoningMenu(false)
                setShowAssignMenu((current) => !current)
              }}
            >
              <span className="home-assign-avatar" aria-hidden="true">{primaryLeadAvailable ? activeAssignOption.label.slice(0, 1) : 'P'}</span>
              <span className="min-w-0 truncate">{primaryLeadAvailable ? activeAssignOption.label : t('home.assign.profileDefault', 'Profile default')}</span>
              {primaryLeadAvailable && activeAssignOption.id === 'build' && <span className="home-assign-default">{t('home.assign.default', 'default')}</span>}
              {primaryLeadAvailable && <Icon name="chevron-down" size={16} className="shrink-0 text-text-muted" />}
            </button>
            {showAssignMenu && primaryLeadAvailable && (
              <div ref={assignMenuRef} className="home-assign-menu" role="menu" aria-label={t('home.assign.menuLabel', 'Assign lead coworker')} onKeyDown={handleAssignMenuKeyDown}>
                {visibleAssignOptions.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={activeAgentMode === option.id}
                    className="home-assign-option"
                    onClick={() => {
                      setAgentMode(option.id)
                      setShowAssignMenu(false)
                      textareaRef.current?.focus()
                    }}
                  >
                    <span className="home-assign-avatar" aria-hidden="true">{option.label.slice(0, 1)}</span>
                    <span className="min-w-0">
                      <span className="home-assign-option-title">{option.label}</span>
                      <span className="home-assign-option-meta">{option.role}</span>
                      <span className="home-assign-option-summary">{option.summary}</span>
                    </span>
                    {option.id === activeAgentMode && <Icon name="check" size={16} className="shrink-0 text-accent" />}
                  </button>
                ))}
                <p className="home-assign-note">
                  {t('home.assign.specialistNote', 'Specialists can still be mentioned with @ and delegated by the lead.')}
                </p>
              </div>
            )}
          </div>
        </div>
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
          className="flex-1 bg-transparent text-lg text-text placeholder:text-text-muted resize-none outline-none min-h-[28px] max-h-[220px] leading-[1.45]"
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
        className="rounded-b-[28px] border-x border-b"
        style={{
          background: 'color-mix(in srgb, var(--color-elevated) 50%, transparent)',
          backdropFilter: 'blur(18px) saturate(1.12)',
          WebkitBackdropFilter: 'blur(18px) saturate(1.12)',
          borderColor: dragOver ? 'var(--color-accent)' : 'color-mix(in srgb, var(--accent) 16%, transparent)',
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
          agentMode={activeAgentMode}
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
          showAgentModeControl={false}
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
          onToggleAgentMode={() => {
            if (primaryLeadAvailable) setAgentMode(nextAllowedPrimaryAgentMode(activeAgentMode, allowedPrimaryModes))
          }}
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

function LaunchpadSuggestions({
  allowedPrimaryModes,
  onPick,
}: {
  allowedPrimaryModes: PrimaryAgentMode[]
  onPick: (prompt: string, agentMode: PrimaryAgentMode) => void
}) {
  return (
    <div className="w-full mt-7">
      <EmptyState
        icon="sparkles"
        title={t('home.suggestions.launchpadTitle', 'Start with a handoff')}
        body={t('home.suggestions.launchpadBody', 'Pick a starter task, choose the lead coworker, then adjust the prompt for your work.')}
      />
      <div className="home-example-grid">
        {EXAMPLE_PROMPTS.map((example) => {
          const primaryLeadAvailable = allowedPrimaryModes.length > 0
          const agentMode = constrainedPrimaryAgentMode(example.agentMode, allowedPrimaryModes)
          const content = (
              <div className="flex items-start gap-3">
                <span className="home-sug-tile" data-tone={example.tone} aria-hidden="true">
                  <Icon name={example.icon} size={20} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-text">{example.title}</span>
                  <span className="mt-1 block text-2xs leading-snug text-text-muted">{example.prompt}</span>
                  <span className="mt-2 inline-flex items-center gap-1 text-2xs font-medium text-text-secondary">
                    <Icon name="at-sign" size={16} />
                    {primaryLeadAvailable
                      ? primaryAgentLeadLabel(agentMode)
                      : t('home.suggestions.noPrimaryLead', 'No primary lead in this profile')}
                  </span>
                </span>
              </div>
          )
          return primaryLeadAvailable ? (
            <Card
              key={example.title}
              interactive
              padding="md"
              onClick={() => onPick(example.prompt, agentMode)}
              aria-label={`${example.title}: ${example.prompt}`}
            >
              {content}
            </Card>
          ) : (
            <Card
              key={example.title}
              padding="md"
              aria-disabled="true"
              aria-label={`${example.title}: ${example.prompt}`}
            >
              {content}
            </Card>
          )
        })}
      </div>
    </div>
  )
}

function TeamStrip({
  agents,
  allowedPrimaryModes,
  allowedAgentNames,
  onNavigate,
}: {
  agents: Array<{ id: string; label: string }>
  allowedPrimaryModes: PrimaryAgentMode[]
  allowedAgentNames?: string[] | null
  onNavigate: (target: AppNavigationTarget) => void
}) {
  const primaryAgentOptions = [
    { id: 'build', label: t('home.coworkers.build.name', 'Build') },
    { id: 'plan', label: t('home.coworkers.plan.name', 'Plan') },
    { id: 'chief-of-staff', label: t('home.coworkers.cleo.name', 'Cleo') },
  ] satisfies Array<{ id: PrimaryAgentMode; label: string }>
  const primaryAgents = primaryAgentOptions.filter((agent) => allowedPrimaryModes.includes(agent.id))
  const knownAgentIds = new Set([...primaryAgents.map((agent) => agent.id), ...agents.map((agent) => agent.id)])
  const specialistAgents = allowedAgentNames
    ? agents.filter((agent) => allowedAgentNames.includes(agent.id))
    : agents
  const allowedUnknownAgents = allowedAgentNames
    ? allowedAgentNames
      .filter((agentId) => !knownAgentIds.has(agentId))
      .map((agentId) => ({ id: agentId, label: formatAgentLabel(agentId) }))
    : []
  const team = [...primaryAgents, ...specialistAgents, ...allowedUnknownAgents].slice(0, 8)
  const teamCount = allowedAgentNames ? allowedAgentNames.length : primaryAgents.length + agents.length

  return (
    <button type="button" className="home-team-strip mt-9" onClick={() => onNavigate('team')}>
      <span className="home-team-label">{t('home.team.title', 'Your team')}</span>
      <span className="home-team-avatars" aria-hidden="true">
        {team.map((agent) => (
          <span key={agent.id} className="home-team-avatar">{agent.label.slice(0, 2).toUpperCase()}</span>
        ))}
      </span>
      <span className="home-team-label">
        {t('home.team.manage', '{{count}} coworkers · manage', { count: teamCount })}
      </span>
    </button>
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
    <div className="home-status-strip mt-10 inline-flex items-center gap-2.5 px-4 py-2 rounded-full border border-border-subtle text-xs text-text-muted">
      <span
        className={`mcp-dot ${total > 0 && connected === total ? 'mcp-dot--up' : 'mcp-dot--degraded'}`}
        aria-hidden
      />
      <span className="text-text-secondary font-[560]">{readyLabel}</span>
      <span className="opacity-40" aria-hidden>·</span>
      <span className="tabular">{t('home.statusStrip.mcps', '{{connected}}/{{total}} MCPs', { connected, total })}</span>
    </div>
  )
}

export function HomePage({ brandName, homeBranding, onStartThread, onOpenThread, onNavigate }: Props) {
  const sessions = useSessionStore((s) => s.sessions)
  const currentView = useSessionStore((s) => s.currentView)
  const setAgentMode = useSessionStore((s) => s.setAgentMode)
  const [submitting, setSubmitting] = useState(false)
  const [promptPrefill, setPromptPrefill] = useState<{ text: string; nonce: number } | null>(null)
  const [coachmarkDismissed, setCoachmarkDismissed] = useState(readHomeCoachmarkDismissed)
  const [launchpadFeed, setLaunchpadFeed] = useState<LaunchpadFeedPayload>(EMPTY_LAUNCHPAD_FEED)
  const [launchpadLoading, setLaunchpadLoading] = useState(true)
  const [launchpadError, setLaunchpadError] = useState<string | null>(null)
  // Bumped by the "Refresh" affordance so a failed feed fetch isn't a dead end;
  // wired into the feed effect deps below to re-run the same fetch on demand.
  const [launchpadRefreshNonce, setLaunchpadRefreshNonce] = useState(0)
  const launchpadRequestIdRef = useRef(0)
  const workspaceSupport = useActiveWorkspaceSupport()
  const activeWorkspaceIsLocal = workspaceSupport.workspaceId === LOCAL_WORKSPACE_ID
  const workspaceOptions = useMemo(
    () => activeWorkspaceIsLocal ? undefined : { workspaceId: workspaceSupport.workspaceId },
    [activeWorkspaceIsLocal, workspaceSupport.workspaceId],
  )
  const [allowedPrimaryModes, setAllowedPrimaryModes] = useState<PrimaryAgentMode[]>(() => [...PRIMARY_AGENT_MODES])
  const [allowedAgentNames, setAllowedAgentNames] = useState<string[] | null>(null)
  const [fallbackPromptAgent, setFallbackPromptAgent] = useState<string | null>(null)
  const [agentPolicyStatus, setAgentPolicyStatus] = useState<'ready' | 'loading' | 'error'>('ready')
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

  const firstRun = sessions.filter((session) => (session.kind || 'interactive') === 'interactive').length === 0
  const sessionFeedKey = useMemo(
    () => sessions
      .map((session) => `${session.id}:${session.updatedAt}:${session.title || ''}:${session.kind || 'interactive'}`)
      .join('|'),
    [sessions],
  )

  useEffect(() => {
    let cancelled = false
    if (activeWorkspaceIsLocal) {
      setAllowedPrimaryModes([...PRIMARY_AGENT_MODES])
      setAllowedAgentNames(null)
      setFallbackPromptAgent(null)
      setAgentPolicyStatus('ready')
      return () => {
        cancelled = true
      }
    }

    setAgentPolicyStatus('loading')
    setAllowedPrimaryModes([])
    setAllowedAgentNames([])
    setFallbackPromptAgent(null)
    void window.coworkApi.workspace.policy(workspaceSupport.workspaceId).then((policy) => {
      if (cancelled) return
      setAllowedPrimaryModes(allowedPrimaryAgentModes(policy.allowedAgents))
      setAllowedAgentNames(Array.isArray(policy.allowedAgents) ? policy.allowedAgents : null)
      setFallbackPromptAgent(Array.isArray(policy.allowedAgents) ? policy.allowedAgents[0] || null : null)
      setAgentPolicyStatus('ready')
    }).catch(() => {
      if (!cancelled) {
        setAllowedPrimaryModes([])
        setAllowedAgentNames([])
        setFallbackPromptAgent(null)
        setAgentPolicyStatus('error')
      }
    })

    return () => {
      cancelled = true
    }
  }, [activeWorkspaceIsLocal, workspaceSupport.workspaceId])

  const agentPolicyReady = activeWorkspaceIsLocal || agentPolicyStatus === 'ready'
  const effectiveAllowedPrimaryModes = useMemo(
    () => (agentPolicyReady ? allowedPrimaryModes : []),
    [agentPolicyReady, allowedPrimaryModes],
  )
  const effectiveAllowedAgentNames = agentPolicyReady ? allowedAgentNames : []
  const effectiveFallbackPromptAgent = agentPolicyReady ? fallbackPromptAgent : null
  const canPromptFromHome = workspaceSupport.flags.canPrompt && agentPolicyReady
  const promptDisabledReason = agentPolicyReady ? workspaceSupport.flags.reasons.prompt : t('home.assign.policyLoading', 'Checking cloud profile policy.')

  useEffect(() => {
    const nextMode = constrainedPrimaryAgentMode(useSessionStore.getState().agentMode, effectiveAllowedPrimaryModes)
    if (nextMode !== useSessionStore.getState().agentMode) setAgentMode(nextMode)
  }, [effectiveAllowedPrimaryModes, setAgentMode])

  useEffect(() => {
    let cancelled = false
    const timeout = window.setTimeout(() => {
      const requestId = launchpadRequestIdRef.current + 1
      launchpadRequestIdRef.current = requestId
      setLaunchpadLoading(true)
      setLaunchpadError(null)
      void window.coworkApi.launchpad.feed({
        ...(workspaceOptions || {}),
        limit: MAX_MOTION_ITEMS,
      }).then((feed) => {
        if (cancelled || requestId !== launchpadRequestIdRef.current) return
        setLaunchpadFeed(feed)
      }).catch((error) => {
        if (cancelled || requestId !== launchpadRequestIdRef.current) return
        setLaunchpadFeed(EMPTY_LAUNCHPAD_FEED)
        setLaunchpadError(error instanceof Error ? error.message : String(error))
      }).finally(() => {
        if (!cancelled && requestId === launchpadRequestIdRef.current) setLaunchpadLoading(false)
      })
    }, 150)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [
    workspaceOptions,
    sessionFeedKey,
    currentView.lastEventAt,
    currentView.revision,
    launchpadRefreshNonce,
  ])

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

  const handlePickExample = useCallback((prompt: string, nextAgentMode: PrimaryAgentMode) => {
    setAgentMode(constrainedPrimaryAgentMode(nextAgentMode, effectiveAllowedPrimaryModes))
    setPromptPrefill({ text: prompt, nonce: Date.now() })
  }, [effectiveAllowedPrimaryModes, setAgentMode])

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

  const handleOpenArtifact = useCallback((item: LaunchpadFreshArtifactItem) => {
    if (activeWorkspaceIsLocal && item.sessionId && item.artifactId.startsWith('local-artifact-')) {
      // Local feed artifact ids are privacy-preserving aliases; open the source thread instead of dispatching an unresolvable resource identity.
      void onOpenThread(item.sessionId)
      return
    }

    if (item.sessionId && item.artifactId) {
      window.dispatchEvent(new CustomEvent('open-cowork:open-resource', {
        detail: {
          identity: {
            format: 'open-cowork-resource-identity-v1',
            authority: activeWorkspaceIsLocal ? 'desktop-local' : 'desktop-cloud',
            kind: 'artifact',
            workspaceId: workspaceSupport.workspaceId,
            sessionId: item.sessionId,
            artifactId: item.artifactId,
          },
        },
      }))
      return
    }
    onNavigate('artifacts')
  }, [activeWorkspaceIsLocal, onNavigate, onOpenThread, workspaceSupport.workspaceId])

  const homeCopyVars = { brand: brandName }
  // A configured/branded greeting wins; otherwise the time-of-day greeting.
  const brandedGreeting = homeBranding?.greeting?.trim()
    ? configuredCopy(homeBranding.greeting, GREETING_KEY, GREETING_FALLBACK, homeCopyVars)
    : null
  const timeGreeting = timeOfDayGreeting()
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
  const readyLabel = configuredCopy(homeBranding?.statusReadyLabel, 'home.statusStrip.ready', 'Ready', homeCopyVars)

  return (
    // Sits on the themed --color-base + its --bg-image aurora wash (set per theme).
    <div className="flex-1 min-h-0 overflow-y-auto" data-testid="home-view">
      <div className="measure-column px-6 pt-[clamp(72px,13vh,142px)] pb-16 flex flex-col items-center">
        <h1 className="font-display text-hero leading-[1.04] font-semibold tracking-[-0.03em] text-text text-center">
          {brandedGreeting ?? (
            <>{timeGreeting.lead} <span className="studio-greeting-accent">{timeGreeting.accent}</span>.</>
          )}
        </h1>
        <p className="mt-3 text-sm text-text-muted text-center">
          {subtitle}
        </p>

        <div className="w-full mt-9">
          <HomeComposer
            onSubmit={handleSubmit}
            disabled={submitting}
            placeholder={composerPlaceholder}
            specialistAgents={specialistAgents}
            allowedPrimaryModes={effectiveAllowedPrimaryModes}
            allowedAgentNames={effectiveAllowedAgentNames}
            fallbackAgent={effectiveFallbackPromptAgent}
            prefillAgent={null}
            prefillPrompt={promptPrefill}
            workspaceOptions={workspaceOptions}
            canPrompt={canPromptFromHome}
            sendDisabledReason={promptDisabledReason}
            attachmentsAllowed={workspaceSupport.flags.canAttachFiles}
            attachmentsDisabledReason={workspaceSupport.flags.reasons.attachFiles}
            modelControlsManaged={!workspaceSupport.flags.canUseMachineRuntimeConfig}
            modelControlsReason={workspaceSupport.flags.reasons.machineRuntimeConfig}
          />
        </div>

        {firstRun && !coachmarkDismissed && <HomeCoachmark onDismiss={handleDismissCoachmark} />}

        <LaunchpadSuggestions allowedPrimaryModes={effectiveAllowedPrimaryModes} onPick={handlePickExample} />

        <LaunchpadMotionGrid
          feed={launchpadFeed}
          loading={launchpadLoading}
          error={launchpadError}
          onNavigate={onNavigate}
          onOpenThread={handleOpenThread}
          onOpenArtifact={handleOpenArtifact}
          onRefresh={() => setLaunchpadRefreshNonce((nonce) => nonce + 1)}
        />

        <TeamStrip
          agents={suggestedAgents}
          allowedPrimaryModes={effectiveAllowedPrimaryModes}
          allowedAgentNames={effectiveAllowedAgentNames}
          onNavigate={onNavigate}
        />

        <HomeReviewSnapshot
          pendingApprovals={currentView.pendingApprovals.length}
          pendingQuestions={currentView.pendingQuestions.length}
          taskCount={currentView.taskRuns.length}
        />

        <StatusStrip readyLabel={readyLabel} />
      </div>
    </div>
  )
}
