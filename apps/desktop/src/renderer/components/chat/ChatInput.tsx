import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useSessionStore } from '../../stores/session'
import { t } from '../../helpers/i18n'
import { ChatInputAttachments } from './ChatInputAttachments'
import { ChatInputInlinePicker } from './ChatInputInlinePicker'
import { ChatInputModelMenu } from './ChatInputModelMenu'
import { ChatInputReasoningMenu, formatReasoningVariantLabel } from './ChatInputReasoningMenu'
import { ChatInputToolbar } from './ChatInputToolbar'
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

export function ChatInput() {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const inputChromeRef = useRef<HTMLDivElement>(null)
  const inlinePickerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelBtnRef = useRef<HTMLButtonElement>(null)
  const reasoningBtnRef = useRef<HTMLButtonElement>(null)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const isGenerating = useSessionStore((s) => s.currentView.isGenerating)
  const isAwaitingPermission = useSessionStore((s) => s.currentView.isAwaitingPermission)
  const isAwaitingQuestion = useSessionStore((s) => s.currentView.isAwaitingQuestion)
  const addGlobalError = useSessionStore((s) => s.addGlobalError)
  const agentMode = useSessionStore((s) => s.agentMode)
  const setAgentMode = useSessionStore((s) => s.setAgentMode)
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [showReasoningMenu, setShowReasoningMenu] = useState(false)
  const [inlinePicker, setInlinePicker] = useState<InlinePickerState | null>(null)
  const { navigate, recordPrompt } = usePromptHistory()
  const currentProjectDirectory = useMemo(
    () => sessions.find((session) => session.id === currentSessionId)?.directory || null,
    [currentSessionId, sessions],
  )
  const { currentModel, setCurrentModel, provider, availableModels } = useChatRuntimeSelection()
  const reasoningSelection = useReasoningVariantSelection(provider, currentModel, availableModels)
  const specialistAgents = useMentionableAgents(currentProjectDirectory)

  const resizeComposerTextarea = useCallback((element = textareaRef.current) => {
    if (!element) return
    element.style.height = 'auto'
    element.style.height = Math.min(element.scrollHeight, 180) + 'px'
  }, [])

  const addFiles = async (files: FileList | File[]) => {
    const newAttachments = await filesToAttachments(files)
    setAttachments(prev => [...prev, ...newAttachments])
  }

  const handleSubmit = useCallback(async () => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || !currentSessionId) return
    const directInvocation = resolveDirectAgentInvocation(text, specialistAgents)
    const promptText = directInvocation.text
    setInlinePicker(null)

    recordPrompt(text)

    const currentAttachments = [...attachments]
    setInput('')
    setAttachments([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    try {
      const files = currentAttachments.map(a => ({ mime: a.mime, url: a.url, filename: a.filename }))
      if (!promptText && files.length === 0) {
        return
      }
      const message = promptText || 'Describe this image.'
      const promptAgent = directInvocation.agent || agentMode
      if (reasoningSelection.promptOptions) {
        await window.coworkApi.session.prompt(currentSessionId, message, files.length > 0 ? files : undefined, promptAgent, reasoningSelection.promptOptions)
      } else {
        await window.coworkApi.session.prompt(currentSessionId, message, files.length > 0 ? files : undefined, promptAgent)
      }
    } catch (err) {
      reportComposerError(
        t('chat.promptFailed', 'Could not send the prompt. Please try again.'),
        'Prompt failed',
        err,
        addGlobalError,
      )
    }
  }, [input, attachments, currentSessionId, agentMode, specialistAgents, addGlobalError, reasoningSelection.promptOptions])

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
    if (currentSessionId && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 100)
    }
  }, [currentSessionId])

  useComposerExternalEvents({
    textareaRef,
    resizeComposerTextarea,
    setInput,
    setAttachments,
    setInlinePicker,
  })

  // Global Shift+Tab to toggle agent mode — works even when textarea loses focus
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        setAgentMode(useSessionStore.getState().agentMode === 'build' ? 'plan' : 'build')
      }
    }
    document.addEventListener('keydown', handler, true)
    return () => document.removeEventListener('keydown', handler, true)
  }, [setAgentMode])

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

  const handleStop = useCallback(async () => {
    if (!currentSessionId) return
    try {
      await window.coworkApi.session.abort(currentSessionId)
    } catch (err) {
      reportComposerError(
        t('chat.abortFailed', 'Could not stop generation. Please try again.'),
        'Abort failed',
        err,
        addGlobalError,
      )
    }
  }, [currentSessionId, addGlobalError])

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

    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); return }

    const textarea = textareaRef.current
    if (!textarea) return
    const isAtStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0
    const isAtEnd = textarea.selectionStart === input.length

    if (e.key === 'ArrowUp' && isAtStart) {
      const next = navigate('up', input, textarea)
      if (!next.handled) return
      e.preventDefault()
      setInput(next.value)
      requestAnimationFrame(() => resizeComposerTextarea())
    }

    if (e.key === 'ArrowDown' && isAtEnd) {
      const next = navigate('down', input, textarea)
      if (!next.handled) return
      e.preventDefault()
      setInput(next.value)
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
      await addFiles(files)
    }
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) {
      await addFiles(e.dataTransfer.files)
    }
  }

  const canSend = (input.trim() || attachments.length > 0) && currentSessionId && !isGenerating && !isAwaitingPermission && !isAwaitingQuestion
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
      <div className="max-w-[900px] mx-auto">
        <ChatInputAttachments
          attachments={attachments}
          onRemove={(id) => setAttachments((prev) => prev.filter((attachment) => attachment.id !== id))}
        />

        {/* Codex-style input card. The drag/drop handlers are a
            pointer-only affordance for file attachments — keyboard
            users use the paperclip button next to the textarea. The
            `<textarea>` child is the actual interactive element; this
            container is just the drop target + visual shell. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
        <div
          ref={inputChromeRef}
          role="group"
          aria-label={t('chat.composerAriaLabel', 'Message composer (drop files to attach)')}
          className={`rounded-2xl border transition-colors overflow-hidden ${dragOver ? 'border-accent' : 'border-border'}`}
          style={{ background: 'var(--color-elevated)' }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {/* Textarea area */}
          <div className="px-4 pt-3 pb-2">
            <textarea ref={textareaRef} value={input} onChange={handleChange} onKeyDown={handleKeyDown} onPaste={handlePaste}
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
                  ? (agentMode === 'plan' ? t('chat.placeholder.askPlan', 'Ask Plan to analyze or structure the work...') : t('chat.placeholder.askBuild', 'Ask Build to work on this...'))
                  : t('chat.placeholder.noThread', 'Start a new thread first')}
              disabled={!currentSessionId || isAwaitingQuestion} rows={1}
              className="w-full bg-transparent resize-none text-[13px] text-text placeholder:text-text-muted leading-relaxed"
              style={{ maxHeight: 180, outline: 'none' }} />
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
            currentSessionId={currentSessionId || null}
            isGenerating={isGenerating}
            isAwaitingPermission={isAwaitingPermission}
            isAwaitingQuestion={isAwaitingQuestion}
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
            onFork={async () => {
              if (!currentSessionId) return
              const forked = await window.coworkApi.session.fork(currentSessionId)
              if (forked) {
                const store = useSessionStore.getState()
                store.addSession(forked)
                store.setCurrentSession(forked.id)
                await window.coworkApi.session.activate(forked.id, { force: true })
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
          const previousModel = currentModel
          setCurrentModel(modelId)
          setShowModelMenu(false)
          try {
            await window.coworkApi.settings.set({ selectedModelId: modelId })
          } catch (error) {
            setCurrentModel(previousModel)
            reportComposerError(
              t('chat.modelSaveFailed', 'Could not save the selected model. Please try again.'),
              'Failed to save selected model',
              error,
              addGlobalError,
            )
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
