import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useSessionStore } from '../../stores/session'
import { t } from '../../helpers/i18n'
import { ChatInputAttachments } from './ChatInputAttachments'
import { ChatInputInlinePicker } from './ChatInputInlinePicker'
import { ChatInputModelMenu } from './ChatInputModelMenu'
import { ChatInputToolbar } from './ChatInputToolbar'
import type { Attachment, InlinePickerState, MentionableAgent } from './chat-input-types'
import {
  detectInlineTrigger,
  filesToAttachments,
  formatAgentLabel,
  resolveDirectAgentInvocation,
} from './chat-input-utils'
import { COMPOSER_COMPOSE_EVENT, COMPOSER_INSERT_EVENT, type ComposerComposeDetail } from './composer-events'
import { usePromptHistory } from './usePromptHistory'

export function ChatInput() {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const inputChromeRef = useRef<HTMLDivElement>(null)
  const inlinePickerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelBtnRef = useRef<HTMLButtonElement>(null)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const currentDirectory = sessions.find(s => s.id === currentSessionId)?.directory
  const isGenerating = useSessionStore((s) => s.currentView.isGenerating)
  const isAwaitingPermission = useSessionStore((s) => s.currentView.isAwaitingPermission)
  const isAwaitingQuestion = useSessionStore((s) => s.currentView.isAwaitingQuestion)
  const agentMode = useSessionStore((s) => s.agentMode)
  const setAgentMode = useSessionStore((s) => s.setAgentMode)
  const [currentModel, setCurrentModel] = useState('')
  const [provider, setProvider] = useState('')
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [availableModels, setAvailableModels] = useState<Record<string, Array<{ id: string; label: string; featured?: boolean }>>>({})
  const [specialistAgents, setSpecialistAgents] = useState<MentionableAgent[]>([])
  const [inlinePicker, setInlinePicker] = useState<InlinePickerState | null>(null)
  const { navigate, recordPrompt } = usePromptHistory()

  const refreshRuntimeSelection = useCallback(() => {
    Promise.all([window.coworkApi.settings.get(), window.coworkApi.app.config()]).then(([settings, config]) => {
      setCurrentModel(settings.effectiveModel || settings.selectedModelId || '')
      setProvider(settings.effectiveProviderId || '')
      setAvailableModels(Object.fromEntries(
        config.providers.available.map((entry) => [
          entry.id,
          entry.models.map((model) => ({ id: model.id, label: model.name, featured: model.featured })),
        ]),
      ))
    }).catch((err) => console.error('Failed to load chat settings:', err))
  }, [])

  useEffect(() => {
    refreshRuntimeSelection()
    const unsubscribe = window.coworkApi.on.runtimeReady(() => refreshRuntimeSelection())
    return unsubscribe
  }, [refreshRuntimeSelection])

  const currentProjectDirectory = useMemo(
    () => sessions.find((session) => session.id === currentSessionId)?.directory || null,
    [currentSessionId, sessions],
  )

  useEffect(() => {
    const loadRuntimeCatalog = () => {
      Promise.all([
        window.coworkApi.app.builtinAgents(),
        window.coworkApi.agents.list(currentProjectDirectory ? { directory: currentProjectDirectory } : undefined),
      ]).then(([builtins, customAgents]) => {
        const builtinAgents = (builtins || [])
          .filter((agent) => agent.mode === 'subagent' && !agent.hidden && agent.surface !== 'automation')
          .map((agent) => ({
            id: agent.name,
            label: agent.label || formatAgentLabel(agent.name),
            description: agent.description || 'Focused delegated work',
          }))
        const userAgents = (customAgents || [])
          .filter((agent) => agent.enabled && agent.valid)
          .map((agent) => ({
            id: agent.name,
            label: formatAgentLabel(agent.name),
            description: agent.description || 'Focused delegated work',
          }))

        setSpecialistAgents(
          [...builtinAgents, ...userAgents].sort((a, b) => a.label.localeCompare(b.label)),
        )
      }).catch(() => setSpecialistAgents([]))
    }

    loadRuntimeCatalog()
    const unsubscribe = window.coworkApi.on.runtimeReady(() => loadRuntimeCatalog())
    return unsubscribe
  }, [currentProjectDirectory])

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
      await window.coworkApi.session.prompt(
        currentSessionId,
        promptText || 'Describe this image.',
        files.length > 0 ? files : undefined,
        directInvocation.agent || agentMode,
      )
    } catch (err) {
      console.error('Prompt failed:', err)
    }
  }, [input, attachments, currentSessionId, agentMode, specialistAgents])

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
      textarea.style.height = 'auto'
      textarea.style.height = Math.min(textarea.scrollHeight, 180) + 'px'
    })
  }, [inlinePicker, input])

  // Autofocus textarea when session changes
  useEffect(() => {
    if (currentSessionId && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 100)
    }
  }, [currentSessionId])

  useEffect(() => {
    const focusComposer = (cursor?: number) => {
      requestAnimationFrame(() => {
        const element = textareaRef.current
        if (!element) return
        element.focus()
        if (typeof cursor === 'number') {
          element.setSelectionRange(cursor, cursor)
        }
        element.style.height = 'auto'
        element.style.height = Math.min(element.scrollHeight, 180) + 'px'
      })
    }

    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<{ text?: string }>
      const insertedText = customEvent.detail?.text
      if (typeof insertedText !== 'string' || !insertedText.trim()) return

      setInlinePicker(null)
      setInput((current) => {
        const textarea = textareaRef.current
        const start = textarea?.selectionStart ?? current.length
        const end = textarea?.selectionEnd ?? current.length
        const next = `${current.slice(0, start)}${insertedText}${current.slice(end)}`
        const cursor = start + insertedText.length
        focusComposer(cursor)
        return next
      })
    }

    const composeHandler = (event: Event) => {
      const customEvent = event as CustomEvent<ComposerComposeDetail>
      const nextText = typeof customEvent.detail?.text === 'string' ? customEvent.detail.text : ''
      const nextAttachments = Array.isArray(customEvent.detail?.attachments)
        ? customEvent.detail.attachments.filter((attachment): attachment is Attachment =>
          Boolean(attachment)
          && typeof attachment.mime === 'string'
          && typeof attachment.url === 'string'
          && typeof attachment.filename === 'string')
        : []
      const replaceText = customEvent.detail?.replaceText === true

      if (!nextText.trim() && nextAttachments.length === 0) return

      setInlinePicker(null)
      if (nextAttachments.length > 0) {
        setAttachments((current) => [...current, ...nextAttachments])
      }

      if (nextText.trim()) {
        setInput((current) => {
          const textarea = textareaRef.current
          const start = replaceText ? 0 : (textarea?.selectionStart ?? current.length)
          const end = replaceText ? current.length : (textarea?.selectionEnd ?? current.length)
          const next = `${current.slice(0, start)}${nextText}${current.slice(end)}`
          focusComposer(start + nextText.length)
          return next
        })
      } else {
        focusComposer()
      }
    }

    window.addEventListener(COMPOSER_INSERT_EVENT, handler as EventListener)
    window.addEventListener(COMPOSER_COMPOSE_EVENT, composeHandler as EventListener)
    return () => {
      window.removeEventListener(COMPOSER_INSERT_EVENT, handler as EventListener)
      window.removeEventListener(COMPOSER_COMPOSE_EVENT, composeHandler as EventListener)
    }
  }, [])

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
      console.error('Abort failed:', err)
    }
  }, [currentSessionId])

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
    }

    if (e.key === 'ArrowDown' && isAtEnd) {
      const next = navigate('down', input, textarea)
      if (!next.handled) return
      e.preventDefault()
      setInput(next.value)
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const cursor = e.target.selectionStart ?? e.target.value.length
    const triggerState = detectInlineTrigger(e.target.value, cursor)
    setInlinePicker(triggerState ? { ...triggerState, selectedIndex: 0 } : null)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'
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
          onRemove={(index) => setAttachments((prev) => prev.filter((_, currentIndex) => currentIndex !== index))}
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
            modelLabel={currentModelLabel}
            currentDirectory={currentDirectory || null}
            agentMode={agentMode}
            currentSessionId={currentSessionId || null}
            isGenerating={isGenerating}
            isAwaitingPermission={isAwaitingPermission}
            isAwaitingQuestion={isAwaitingQuestion}
            canSend={!!canSend}
            onAddFiles={addFiles}
            onToggleModelMenu={() => {
              setInlinePicker(null)
              setShowModelMenu(!showModelMenu)
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
            console.error('Failed to save selected model:', error)
          }
        }}
      />
    </div>
  )
}
