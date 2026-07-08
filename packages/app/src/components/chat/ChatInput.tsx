import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useSessionStore, type Session } from '../../stores/session'
import { useDismissOnOutsidePointer } from '../home/use-dismiss-on-outside-pointer'
import { useActiveWorkspaceSupport } from '../../stores/workspace-support'
import { activeSessionWorkspaceKey, LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { t } from '../../helpers/i18n'
import { formatAgentLabel } from '../../helpers/agent-label'
import { nextPrimaryAgentMode } from '../../helpers/primary-agent-mode'
import { ChatInputAttachments } from './ChatInputAttachments'
import { ChatInputInlinePicker } from './ChatInputInlinePicker'
import { ChatInputModelMenu } from './ChatInputModelMenu'
import { ChatInputReasoningMenu, formatReasoningVariantLabel } from './ChatInputReasoningMenu'
import { ChatInputToolbar } from './ChatInputToolbar'
import { IconButton, Kbd, Textarea } from '../ui'
import type { Attachment, InlinePickerState, MentionableAgent } from './chat-input-types'
import {
  detectInlineTrigger,
  filesToAttachments,
  resolveDirectAgentInvocation,
} from './chat-input-utils'
import { useChatRuntimeSelection, useComposerExternalEvents, useMentionableAgents, useReasoningVariantSelection } from './useChatInputRuntime'
import { usePromptHistory } from './usePromptHistory'

function describeComposerError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const COMPOSER_TEXTAREA_MAX_LINES = 8
const COMPOSER_PREFERENCE_KEYS = ['modelId', 'reasoningVariant'] as const
const CHAT_KEYBOARD_HINTS_DISMISSED_KEY = 'open-cowork-chat-keyboard-hints-dismissed'

type ComposerPreferencePatch = {
  modelId?: string | null
  reasoningVariant?: string | null
}

type ComposerPreferenceKey = typeof COMPOSER_PREFERENCE_KEYS[number]

function reportComposerError(userMessage: string, diagnosticMessage: string, error: unknown, addGlobalError: (message: string) => void) {
  addGlobalError(userMessage)
  try {
    window.coworkApi?.diagnostics?.reportRendererError?.({
      message: `${diagnosticMessage}: ${describeComposerError(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
      view: 'chat',
    })
  } catch {
    // Diagnostics reporting must never make a user-facing error worse.
  }
}

function getComposerTextareaMaxHeight(element: HTMLTextAreaElement) {
  const style = window.getComputedStyle(element)
  const fontSize = Number.parseFloat(style.fontSize) || 16
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.4
  const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
  return lineHeight * COMPOSER_TEXTAREA_MAX_LINES + padding
}

function hasComposerPreferenceKey(preferences: ComposerPreferencePatch, key: ComposerPreferenceKey) {
  return Object.prototype.hasOwnProperty.call(preferences, key)
}

function readComposerPreference(session: Session | undefined, key: ComposerPreferenceKey) {
  if (!session) return null
  if (key === 'modelId') return session.composerModelId ?? null
  return session.composerReasoningVariant ?? null
}

function readKeyboardHintsDismissed() {
  try {
    return window.localStorage.getItem(CHAT_KEYBOARD_HINTS_DISMISSED_KEY) === 'true'
  } catch {
    return false
  }
}

export function ChatInput() {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [submitInFlight, setSubmitInFlight] = useState(false)
  const [keyboardHintsDismissed, setKeyboardHintsDismissed] = useState(readKeyboardHintsDismissed)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const inputChromeRef = useRef<HTMLDivElement>(null)
  const inlinePickerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const modelBtnRef = useRef<HTMLButtonElement>(null)
  const reasoningBtnRef = useRef<HTMLButtonElement>(null)
  const submitInFlightRef = useRef(false)
  const composerSaveVersionByKeyRef = useRef(new Map<string, number>())
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const isGenerating = useSessionStore((s) => s.currentView.isGenerating)
  const isAwaitingPermission = useSessionStore((s) => s.currentView.isAwaitingPermission)
  const isAwaitingQuestion = useSessionStore((s) => s.currentView.isAwaitingQuestion)
  const addGlobalError = useSessionStore((s) => s.addGlobalError)
  const agentMode = useSessionStore((s) => s.agentMode)
  const setAgentMode = useSessionStore((s) => s.setAgentMode)
  const sessionPrimaryAgent = useSessionStore((s) => {
    if (!currentSessionId) return null
    const session = s.sessions.find((candidate) => candidate.id === currentSessionId)
    return session?.composerAgentName || s.sessionPrimaryAgents[activeSessionWorkspaceKey(s, currentSessionId)] || null
  })
  const setSessionPrimaryAgent = useSessionStore((s) => s.setSessionPrimaryAgent)
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [showReasoningMenu, setShowReasoningMenu] = useState(false)
  const [inlinePicker, setInlinePicker] = useState<InlinePickerState | null>(null)
  const { navigate, recordPrompt } = usePromptHistory()
  const workspaceSupport = useActiveWorkspaceSupport()
  const workspaceOptions = useMemo(
    () => workspaceSupport.workspaceId === LOCAL_WORKSPACE_ID
      ? undefined
      : { workspaceId: workspaceSupport.workspaceId },
    [workspaceSupport.workspaceId],
  )
  const runtimeControlsManaged = !workspaceSupport.flags.canUseMachineRuntimeConfig
  const currentProjectDirectory = useMemo(
    () => sessions.find((session) => session.id === currentSessionId)?.directory || null,
    [currentSessionId, sessions],
  )
  const currentSession = useMemo(
    () => sessions.find((session) => session.id === currentSessionId) || null,
    [currentSessionId, sessions],
  )
  const setSessionComposerPreferences = useSessionStore((s) => s.setSessionComposerPreferences)
  const { currentModel, setCurrentModel, provider, availableModels } = useChatRuntimeSelection(currentSession, workspaceOptions)
  const saveComposerPreferences = useCallback((preferences: ComposerPreferencePatch) => {
    if (!currentSessionId) return
    if (runtimeControlsManaged) {
      addGlobalError(workspaceSupport.flags.reasons.machineRuntimeConfig)
      return
    }
    const sessionsBeforeSave = useSessionStore.getState().sessions
    const sessionBeforeSave = sessionsBeforeSave.find((session) => session.id === currentSessionId)
    const saveVersions = new Map<string, number>()
    const rollback: ComposerPreferencePatch = {}

    for (const key of COMPOSER_PREFERENCE_KEYS) {
      if (!hasComposerPreferenceKey(preferences, key)) continue
      const versionKey = `${currentSessionId}:${key}`
      const nextVersion = (composerSaveVersionByKeyRef.current.get(versionKey) || 0) + 1
      composerSaveVersionByKeyRef.current.set(versionKey, nextVersion)
      saveVersions.set(versionKey, nextVersion)
      rollback[key] = readComposerPreference(sessionBeforeSave, key)
    }

    setSessionComposerPreferences(currentSessionId, preferences)
    void window.coworkApi.session.setComposerPreferences(currentSessionId, preferences).catch((error) => {
      const activeRollback: ComposerPreferencePatch = {}
      for (const key of COMPOSER_PREFERENCE_KEYS) {
        if (!hasComposerPreferenceKey(rollback, key)) continue
        const versionKey = `${currentSessionId}:${key}`
        if (composerSaveVersionByKeyRef.current.get(versionKey) !== saveVersions.get(versionKey)) continue
        activeRollback[key] = rollback[key] ?? null
      }
      if (Object.keys(activeRollback).length === 0) return

      setSessionComposerPreferences(currentSessionId, activeRollback)
      reportComposerError(
        t('chat.composerPreferencesSaveFailed', 'Could not save this thread’s composer settings. Please try again.'),
        'Failed to save session composer preferences',
        error,
        addGlobalError,
      )
    })
  }, [addGlobalError, currentSessionId, runtimeControlsManaged, setSessionComposerPreferences, workspaceSupport.flags.reasons.machineRuntimeConfig])
  const reasoningSelection = useReasoningVariantSelection(provider, currentModel, availableModels, {
    selectedVariant: currentSession?.composerReasoningVariant ?? null,
    onVariantChange: (variant) => saveComposerPreferences({ reasoningVariant: variant }),
  })
  const specialistAgents = useMentionableAgents(currentProjectDirectory, workspaceOptions)

  const clearSessionPrimaryAgentForModeSwitch = useCallback(() => {
    const state = useSessionStore.getState()
    const sessionId = state.currentSessionId
    if (!sessionId) return
    const session = state.sessions.find((candidate) => candidate.id === sessionId)
    const previousAgent = session?.composerAgentName || state.sessionPrimaryAgents[activeSessionWorkspaceKey(state, sessionId)] || null
    if (!previousAgent) return

    setSessionPrimaryAgent(sessionId, null)
    void window.coworkApi.session.setComposerPreferences(sessionId, { agentName: null }).catch(() => {
      setSessionPrimaryAgent(sessionId, previousAgent)
      addGlobalError('Could not switch agent mode. Please try again.')
    })
  }, [addGlobalError, setSessionPrimaryAgent])

  const resizeComposerTextarea = useCallback((element = textareaRef.current) => {
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, getComposerTextareaMaxHeight(element))}px`
  }, [])

  const addFiles = async (files: FileList | File[]) => {
    if (!workspaceSupport.flags.canAttachFiles) {
      addGlobalError(workspaceSupport.flags.reasons.attachFiles)
      return
    }
    const newAttachments = await filesToAttachments(files)
    setAttachments(prev => [...prev, ...newAttachments])
  }

  const handleSubmit = useCallback(async () => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || !currentSessionId) return
    if (submitInFlightRef.current) return
    if (!workspaceSupport.flags.canPrompt) {
      addGlobalError(workspaceSupport.flags.reasons.prompt)
      return
    }
    if (attachments.length > 0 && !workspaceSupport.flags.canAttachFiles) {
      addGlobalError(workspaceSupport.flags.reasons.attachFiles)
      return
    }
    const directInvocation = resolveDirectAgentInvocation(text, specialistAgents)
    const promptText = directInvocation.text
    setInlinePicker(null)

    recordPrompt(text)

    const currentAttachments = [...attachments]
    submitInFlightRef.current = true
    setSubmitInFlight(true)
    try {
      const files = currentAttachments.map(a => ({ mime: a.mime, url: a.url, filename: a.filename }))
      if (!promptText && files.length === 0) {
        return
      }
      const message = promptText || 'Describe this image.'
      const promptAgent = directInvocation.agent || sessionPrimaryAgent || agentMode
      const promptOptions = runtimeControlsManaged
        ? workspaceOptions
        : { ...(reasoningSelection.promptOptions || {}), ...(workspaceOptions || {}) }
      if (Object.keys(promptOptions || {}).length > 0) {
        await window.coworkApi.session.prompt(currentSessionId, message, files.length > 0 ? files : undefined, promptAgent, promptOptions)
      } else {
        await window.coworkApi.session.prompt(currentSessionId, message, files.length > 0 ? files : undefined, promptAgent)
      }
      setInput('')
      setAttachments([])
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
    } catch (err) {
      reportComposerError(
        t('chat.promptFailed', 'Could not send the prompt. Please try again.'),
        'Prompt failed',
        err,
        addGlobalError,
      )
    } finally {
      submitInFlightRef.current = false
      setSubmitInFlight(false)
    }
  }, [input, attachments, currentSessionId, workspaceSupport.flags, specialistAgents, recordPrompt, sessionPrimaryAgent, agentMode, runtimeControlsManaged, workspaceOptions, reasoningSelection.promptOptions, addGlobalError])

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

    const prefix = inlinePicker.trigger
    const inserted = `${prefix}${item.id} `
    const nextValue = `${input.slice(0, inlinePicker.start)}${inserted}${input.slice(inlinePicker.end)}`
    const nextCursor = inlinePicker.start + inserted.length

    setInput(nextValue)
    setInlinePicker(null)

    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(nextCursor, nextCursor)
      resizeComposerTextarea(textarea)
    })
  }, [inlinePicker, input, resizeComposerTextarea])

  // Autofocus textarea when session changes
  useEffect(() => {
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current)
    if (currentSessionId && textareaRef.current) {
      focusTimerRef.current = setTimeout(() => {
        focusTimerRef.current = null
        textareaRef.current?.focus()
      }, 100)
    }
    return () => {
      if (focusTimerRef.current) {
        clearTimeout(focusTimerRef.current)
        focusTimerRef.current = null
      }
    }
  }, [currentSessionId])

  useComposerExternalEvents({
    textareaRef,
    resizeComposerTextarea,
    setInput,
    setAttachments,
    setInlinePicker,
    attachmentsAllowed: workspaceSupport.flags.canAttachFiles,
    onBlockedAttachment: () => addGlobalError(workspaceSupport.flags.reasons.attachFiles),
  })

  // Shift+Tab toggles agent mode only while focus is inside the composer.
  // Outside the composer it must remain the browser/OS reverse-tab shortcut.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as Node | null
      const composer = inputChromeRef.current
      if (!target || !composer?.contains(target)) return
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        clearSessionPrimaryAgentForModeSwitch()
        setAgentMode(nextPrimaryAgentMode(useSessionStore.getState().agentMode))
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [clearSessionPrimaryAgentForModeSwitch, setAgentMode])

  useDismissOnOutsidePointer(Boolean(inlinePicker), () => setInlinePicker(null), [inlinePickerRef, textareaRef])

  const handleStop = useCallback(async () => {
    if (!currentSessionId) return
    try {
      if (workspaceOptions) {
        await window.coworkApi.session.abort(currentSessionId, workspaceOptions)
      } else {
        await window.coworkApi.session.abort(currentSessionId)
      }
    } catch (err) {
      reportComposerError(
        t('chat.abortFailed', 'Could not stop generation. Please try again.'),
        'Abort failed',
        err,
        addGlobalError,
      )
    }
  }, [currentSessionId, workspaceOptions, addGlobalError])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (inlinePicker && inlineSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setInlinePicker((current) => current ? ({
          ...current,
          selectedIndex: Math.min(current.selectedIndex + 1, inlineSuggestions.length - 1),
        }) : current)
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setInlinePicker((current) => current ? ({
          ...current,
          selectedIndex: Math.max(current.selectedIndex - 1, 0),
        }) : current)
        return
      }

      if ((e.key === 'Enter' || e.key === 'Tab') && inlineSuggestions[inlinePicker.selectedIndex]) {
        e.preventDefault()
        insertInlineSuggestion(inlineSuggestions[inlinePicker.selectedIndex]!)
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        setInlinePicker(null)
        return
      }
    }

    if (e.key === 'Escape' && isGenerating) {
      e.preventDefault()
      void handleStop()
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSubmit(); return }

    const textarea = textareaRef.current
    if (!textarea) return
    const isAtStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0
    const isAtEnd = textarea.selectionStart === input.length

    if (e.key === 'ArrowUp' && isAtStart) {
      const next = navigate('up', input, textarea)
      if (!next.handled) return
      e.preventDefault()
      setInput(next.value ?? input)
      requestAnimationFrame(() => resizeComposerTextarea())
    }

    if (e.key === 'ArrowDown' && isAtEnd) {
      const next = navigate('down', input, textarea)
      if (!next.handled) return
      e.preventDefault()
      setInput(next.value ?? input)
      requestAnimationFrame(() => resizeComposerTextarea())
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const cursor = e.target.selectionStart ?? e.target.value.length
    const triggerState = detectInlineTrigger(e.target.value, cursor)
    setInlinePicker(triggerState ? { ...triggerState, selectedIndex: 0 } : null)
    resizeComposerTextarea(e.target)
  }

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    const files: File[] = []
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      if (!workspaceSupport.flags.canAttachFiles) {
        addGlobalError(workspaceSupport.flags.reasons.attachFiles)
        return
      }
      await addFiles(files)
    }
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      if (!workspaceSupport.flags.canAttachFiles) {
        addGlobalError(workspaceSupport.flags.reasons.attachFiles)
        return
      }
      await addFiles(e.dataTransfer.files)
    }
  }

  const dismissKeyboardHints = () => {
    setKeyboardHintsDismissed(true)
    try {
      window.localStorage.setItem(CHAT_KEYBOARD_HINTS_DISMISSED_KEY, 'true')
    } catch {
      // Hint dismissal is cosmetic; ignore storage failures.
    }
  }

  const sendBlockedReason = !workspaceSupport.flags.canPrompt
    ? workspaceSupport.flags.reasons.prompt
    : attachments.length > 0 && !workspaceSupport.flags.canAttachFiles
      ? workspaceSupport.flags.reasons.attachFiles
      : null
  const canSend = (input.trim() || attachments.length > 0) && currentSessionId && !submitInFlight && !isGenerating && !isAwaitingPermission && !isAwaitingQuestion && !sendBlockedReason
  const currentModelLabel = (availableModels[provider] || []).find((model) => model.id === currentModel)?.label || currentModel
  const inlineMenuWidth = 260
  // Anchor the menu to the outer input chrome (the whole composer block)
  // rather than the bare <textarea> element — the textarea's top edge
  // sits INSIDE the composer's padded container, so anchoring to it puts
  // the menu in dead space above the composer on tall viewports. The
  // picker component applies the "above the anchor" offset itself via
  // its own height measurement, so we pass the raw anchor top here —
  // don't pre-subtract the menu height or it gets doubled up.
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

  return (
    <div className="px-6 pb-4 pt-2">
      <div className="measure-column">
        <ChatInputAttachments
          attachments={attachments}
          onRemove={(id) => setAttachments((prev) => prev.filter((attachment) => attachment.id !== id))}
        />

        {!keyboardHintsDismissed && (
          <div className="chat-keyboard-hints mb-2.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1"><Kbd>Enter</Kbd>{t('chat.hint.send', 'Send')}</span>
              <span className="inline-flex items-center gap-1"><Kbd>Shift</Kbd><Kbd>Enter</Kbd>{t('chat.hint.newLine', 'New line')}</span>
              <span className="inline-flex items-center gap-1"><Kbd>Shift</Kbd><Kbd>Tab</Kbd>{t('chat.hint.mode', 'Build/Plan/Cleo')}</span>
              <span className="inline-flex items-center gap-1"><Kbd>Esc</Kbd>{t('chat.hint.stop', 'Stop')}</span>
              <span className="inline-flex items-center gap-1"><Kbd>Up</Kbd>{t('chat.hint.history', 'History')}</span>
            </div>
            <IconButton
              icon="x"
              label={t('chat.dismissKeyboardHints', 'Dismiss keyboard hints')}
              size="sm"
              onClick={dismissKeyboardHints}
            />
          </div>
        )}

        {/* Codex-style input card. The drag/drop handlers are a
            pointer-only affordance for file attachments — keyboard
            users use the paperclip button next to the textarea. The
            `Textarea` primitive is the actual interactive element; this
            container is just the drop target + visual shell. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <div
          ref={inputChromeRef}
          role="group"
          aria-label={t('chat.composerAriaLabel', 'Message composer (drop files to attach)')}
          className={`chat-composer-shell ${dragOver ? 'chat-composer-shell--drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {/* Textarea area */}
          <div className="px-4 pt-3 pb-2">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
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
              placeholder={isAwaitingQuestion
                ? t('chat.placeholder.answerPending', 'Answer the pending question above to continue...')
                : currentSessionId
                  ? (sessionPrimaryAgent
                    ? t('chat.placeholder.askCustomLead', 'Ask {{agent}} to work on this...', { agent: formatAgentLabel(sessionPrimaryAgent) })
                    : agentMode === 'chief-of-staff'
                    ? t('chat.placeholder.askCleo', 'Ask Cleo to turn an objective into tasks...')
                    : agentMode === 'plan'
                      ? t('chat.placeholder.askPlan', 'Ask Plan to analyze or structure the work...')
                      : t('chat.placeholder.askBuild', 'Ask Build to work on this...'))
                  : t('chat.placeholder.noThread', 'Start a new thread first')}
              disabled={!currentSessionId || isAwaitingQuestion}
              rows={1}
              className="chat-composer-textarea"
              maxHeight={`${COMPOSER_TEXTAREA_MAX_LINES}lh`}
            />
          </div>

          <ChatInputToolbar
            fileInputRef={fileInputRef}
            modelButtonRef={modelBtnRef}
            reasoningButtonRef={reasoningBtnRef}
            modelLabel={currentModelLabel}
            reasoningLabel={formatReasoningVariantLabel(reasoningSelection.reasoningVariant)}
            showReasoningControl={reasoningSelection.supportsReasoning}
            currentDirectory={currentProjectDirectory}
            agentMode={agentMode}
            activeAgentLabel={sessionPrimaryAgent ? formatAgentLabel(sessionPrimaryAgent) : null}
            currentSessionId={currentSessionId || null}
            isGenerating={isGenerating}
            isAwaitingPermission={isAwaitingPermission}
            isAwaitingQuestion={isAwaitingQuestion}
            canSend={!!canSend}
            sendDisabledReason={sendBlockedReason}
            attachmentsAllowed={workspaceSupport.flags.canAttachFiles}
            attachmentsDisabledReason={workspaceSupport.flags.reasons.attachFiles}
            modelControlsManaged={runtimeControlsManaged}
            modelControlsReason={workspaceSupport.flags.reasons.machineRuntimeConfig}
            reasoningControlsManaged={runtimeControlsManaged}
            onAddFiles={addFiles}
            onToggleModelMenu={() => {
              if (runtimeControlsManaged) return
              setInlinePicker(null)
              setShowReasoningMenu(false)
              setShowModelMenu(!showModelMenu)
            }}
            onToggleReasoningMenu={() => {
              if (runtimeControlsManaged) return
              setInlinePicker(null)
              setShowModelMenu(false)
              setShowReasoningMenu(!showReasoningMenu)
            }}
            onToggleAgentMode={() => {
              clearSessionPrimaryAgentForModeSwitch()
              setAgentMode(nextPrimaryAgentMode(agentMode))
            }}
            onFork={async () => {
              if (!currentSessionId) return
              const forked = await window.coworkApi.session.fork(currentSessionId)
              if (forked) {
                const store = useSessionStore.getState()
                store.addSession(forked)
                store.setCurrentSession(forked.id)
                await window.coworkApi.session.activate(forked.id, { force: true, ...(workspaceOptions || {}) })
              }
            }}
            onStop={handleStop}
            onSubmit={handleSubmit}
          />
        </div>
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
          if (runtimeControlsManaged) return
          setCurrentModel(modelId)
          setShowModelMenu(false)
          saveComposerPreferences({ modelId })
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
