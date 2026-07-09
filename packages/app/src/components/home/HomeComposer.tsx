import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRovingMenuKeyboard } from './use-roving-menu-keyboard'
import { useDismissOnOutsidePointer } from './use-dismiss-on-outside-pointer'
import type { SessionPromptOptions } from '@open-cowork/shared'
import { useSessionStore, type PrimaryAgentMode } from '../../stores/session'
import { t } from '../../helpers/i18n'
import { ChatInputAttachments } from '../chat/ChatInputAttachments'
import { ChatInputInlinePicker } from '../chat/ChatInputInlinePicker'
import { ChatInputModelMenu } from '../chat/ChatInputModelMenu'
import { ChatInputReasoningMenu, formatReasoningVariantLabel } from '../chat/ChatInputReasoningMenu'
import { ChatInputToolbar } from '../chat/ChatInputToolbar'
import {
  detectInlineTrigger,
  filesToAttachments,
  resolveDirectAgentInvocation,
} from '../chat/chat-input-utils'
import { useChatRuntimeSelection, useReasoningVariantSelection } from '../chat/useChatInputRuntime'
import type { Attachment, InlinePickerState, MentionableAgent } from '../chat/chat-input-types'
import { Icon } from '../ui'
import { constrainedPrimaryAgentMode, nextAllowedPrimaryAgentMode } from '../../helpers/primary-agent-mode'

// Upper bound on the composer's auto-grow. Past ~220px the textarea
// starts to dominate the landing page and push everything below the
// fold. The value matches ChatInput's own ceiling so the UX feels
// consistent across Home → chat transitions.
const MAX_COMPOSER_HEIGHT = 220

export function HomeComposer({
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
