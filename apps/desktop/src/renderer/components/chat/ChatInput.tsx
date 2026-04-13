import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useSessionStore } from '../../stores/session'

interface MentionableAgent {
  id: string
  label: string
  description: string
}

interface RuntimeSkill {
  id: string
  label: string
  description: string
}

type InlinePickerState = {
  trigger: '@' | '$'
  query: string
  start: number
  end: number
  selectedIndex: number
}

function resolveDirectAgentInvocation(
  rawInput: string,
  availableAgents: MentionableAgent[],
): { agent: string | null; text: string } {
  const match = rawInput.match(/^@([a-z0-9-]+)\b(?:[\s,:-]+)?/i)
  if (!match?.[1]) {
    return { agent: null, text: rawInput }
  }

  const mentionedAgent = match[1].toLowerCase()
  const known = new Set(availableAgents.map((agent) => agent.id))
  if (!known.has(mentionedAgent)) {
    return { agent: null, text: rawInput }
  }

  const stripped = rawInput.slice(match[0].length).trimStart()
  return {
    agent: mentionedAgent,
    text: stripped || rawInput.trim(),
  }
}

function extractLeadingSkills(
  rawInput: string,
  availableSkills: RuntimeSkill[],
): { skills: string[]; text: string } {
  const known = new Set(availableSkills.map((skill) => skill.id))
  let remaining = rawInput.trimStart()
  const selected: string[] = []

  while (true) {
    const match = remaining.match(/^\$([a-zA-Z0-9_-]+)\b(?:[\s,:-]+)?/)
    if (!match?.[1]) break
    const skillName = match[1]
    if (!known.has(skillName)) break
    selected.push(skillName)
    remaining = remaining.slice(match[0].length).trimStart()
  }

  return {
    skills: selected,
    text: remaining,
  }
}

function formatAgentLabel(name: string) {
  return name
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function formatSkillLabel(name: string) {
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function compactDescription(value: string, maxLength = 88) {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}

function detectInlineTrigger(value: string, cursor: number): Omit<InlinePickerState, 'selectedIndex'> | null {
  const beforeCursor = value.slice(0, cursor)
  const match = beforeCursor.match(/(?:^|\s)([@$])([a-zA-Z0-9_-]*)$/)
  if (!match?.[1]) return null

  const trigger = match[1] as '@' | '$'
  const query = match[2] || ''
  const start = beforeCursor.length - (query.length + 1)
  return {
    trigger,
    query,
    start,
    end: cursor,
  }
}

interface Attachment {
  mime: string
  url: string // data URL
  filename: string
  preview?: string // for images
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// Persist prompt history in localStorage
const HISTORY_KEY = 'open-cowork-prompt-history'
const MAX_HISTORY = 10

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') } catch { return [] }
}

function saveHistory(history: string[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)))
}

export function ChatInput() {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [savedCurrent, setSavedCurrent] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
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
  const [availableModels, setAvailableModels] = useState<Record<string, Array<{ id: string; label: string }>>>({})
  const [specialistAgents, setSpecialistAgents] = useState<MentionableAgent[]>([])
  const [runtimeSkills, setRuntimeSkills] = useState<RuntimeSkill[]>([])
  const [inlinePicker, setInlinePicker] = useState<InlinePickerState | null>(null)

  useEffect(() => {
    Promise.all([window.openCowork.settings.get(), window.openCowork.app.config()]).then(([settings, config]) => {
      setCurrentModel(settings.effectiveModel || settings.selectedModelId || '')
      setProvider(settings.effectiveProviderId || '')
      setAvailableModels(Object.fromEntries(
        config.providers.available.map((entry) => [
          entry.id,
          entry.models.map((model) => ({ id: model.id, label: model.name })),
        ]),
      ))
    }).catch((err) => console.error('Failed to load chat settings:', err))
  }, [])

  useEffect(() => {
    const loadRuntimeCatalog = () => {
      window.openCowork.app.agents().then((agents) => {
        setSpecialistAgents(
          (agents || [])
            .filter((agent) => agent.mode === 'subagent' && !agent.hidden)
            .map((agent) => ({
              id: agent.name,
              label: formatAgentLabel(agent.name),
              description: agent.description || 'Focused delegated work',
            })),
        )
      }).catch(() => setSpecialistAgents([]))

      window.openCowork.plugins.runtimeSkills().then((skills) => {
        setRuntimeSkills(
          (skills || []).map((skill) => ({
            id: skill.name,
            label: formatSkillLabel(skill.name),
            description: skill.description || 'Reusable runtime skill',
          })),
        )
      }).catch(() => setRuntimeSkills([]))
    }

    loadRuntimeCatalog()
    const unsubscribe = window.openCowork.on.runtimeReady(() => loadRuntimeCatalog())
    return unsubscribe
  }, [])

  const addFiles = async (files: FileList | File[]) => {
    const newAttachments: Attachment[] = []
    for (const file of Array.from(files)) {
      if (file.size > 20 * 1024 * 1024) continue // 20MB limit
      const url = await fileToDataUrl(file)
      newAttachments.push({
        mime: file.type,
        url,
        filename: file.name,
        preview: file.type.startsWith('image/') ? url : undefined,
      })
    }
    setAttachments(prev => [...prev, ...newAttachments])
  }

  const handleSubmit = useCallback(async () => {
    const text = input.trim()
    if ((!text && attachments.length === 0) || !currentSessionId) return
    const skillInvocation = extractLeadingSkills(text, runtimeSkills)
    const directInvocation = resolveDirectAgentInvocation(skillInvocation.text, specialistAgents)
    const promptText = directInvocation.text
    setInlinePicker(null)

    if (text) {
      const history = loadHistory()
      const filtered = history.filter(h => h !== text)
      saveHistory([text, ...filtered])
    }
    setHistoryIndex(-1)
    setSavedCurrent('')

    const currentAttachments = [...attachments]
    setInput('')
    setAttachments([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    try {
      const files = currentAttachments.map(a => ({ mime: a.mime, url: a.url, filename: a.filename }))
      for (const skillName of skillInvocation.skills) {
        await window.openCowork.command.run(currentSessionId, skillName)
      }
      if (!promptText && files.length === 0) {
        return
      }
      await window.openCowork.session.prompt(
        currentSessionId,
        promptText || 'Describe this image.',
        files.length > 0 ? files : undefined,
        directInvocation.agent || agentMode,
      )
    } catch (err) {
      console.error('Prompt failed:', err)
    }
  }, [input, attachments, currentSessionId, agentMode, specialistAgents, runtimeSkills])

  const inlineSuggestions = useMemo(() => {
    if (!inlinePicker) return []
    const pool = inlinePicker.trigger === '@' ? specialistAgents : runtimeSkills
    const normalizedQuery = inlinePicker.query.trim().toLowerCase()
    if (!normalizedQuery) return pool.slice(0, 6)
    return pool
      .filter((item) =>
        item.id.toLowerCase().includes(normalizedQuery) ||
        item.label.toLowerCase().includes(normalizedQuery) ||
        item.description.toLowerCase().includes(normalizedQuery),
      )
      .slice(0, 6)
  }, [inlinePicker, runtimeSkills, specialistAgents])

  const insertInlineSuggestion = useCallback((item: MentionableAgent | RuntimeSkill) => {
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

  // Global Shift+Tab to toggle agent mode — works even when textarea loses focus
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        setAgentMode(useSessionStore.getState().agentMode === 'assistant' ? 'plan' : 'assistant')
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
      await window.openCowork.session.abort(currentSessionId)
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
      const history = loadHistory()
      if (history.length === 0) return
      e.preventDefault()
      if (historyIndex === -1) setSavedCurrent(input)
      const newIndex = Math.min(historyIndex + 1, history.length - 1)
      setHistoryIndex(newIndex)
      setInput(history[newIndex])
    }

    if (e.key === 'ArrowDown' && isAtEnd) {
      if (historyIndex < 0) return
      e.preventDefault()
      const newIndex = historyIndex - 1
      setHistoryIndex(newIndex)
      setInput(newIndex < 0 ? savedCurrent : loadHistory()[newIndex])
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
  const inlineMenuWidth = 260
  const inlineMenuHeight = Math.max(inlineSuggestions.length, 1) * 42 + 38
  const textareaRect = textareaRef.current?.getBoundingClientRect()
  const inlineMenuLeft = textareaRect
    ? Math.max(
        12,
        Math.min(
          textareaRect.left,
          (typeof window !== 'undefined' ? window.innerWidth : 0) - inlineMenuWidth - 12,
        ),
      )
    : 0
  const inlineMenuTop = textareaRect
    ? Math.max(12, textareaRect.top - inlineMenuHeight - 10)
    : 0

  return (
    <div className="px-6 pb-4 pt-2">
      <div className="max-w-[900px] mx-auto">
        {/* Attachment previews */}
        {attachments.length > 0 && (
          <div className="flex gap-2 mb-2.5 flex-wrap">
            {attachments.map((a, i) => (
              <div key={i} className="relative group/att">
                {a.preview ? (
                  <img src={a.preview} alt={a.filename} className="h-20 rounded-xl object-cover border border-border" style={{ maxWidth: 200 }} />
                ) : (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-border bg-elevated text-[11px]">
                    <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.2"><path d="M7 1H3a1 1 0 00-1 1v8a1 1 0 001 1h6a1 1 0 001-1V4L7 1z"/><polyline points="7,1 7,4 10,4"/></svg>
                    <span className="text-text-secondary truncate" style={{ maxWidth: 120 }}>{a.filename}</span>
                    <span className="text-text-muted">{a.mime.split('/')[1]}</span>
                  </div>
                )}
                <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                  className="absolute -top-2 -right-2 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold opacity-0 group-hover/att:opacity-100 cursor-pointer transition-opacity"
                  style={{ background: 'var(--color-red)', color: 'var(--color-accent-foreground)' }}>
                  x
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Codex-style input card */}
        <div
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
                ? 'Answer the pending question above to continue...'
                : currentSessionId
                  ? (agentMode === 'plan' ? 'Ask Plan to analyze or structure the work...' : 'Ask Open Cowork anything...')
                  : 'Start a new thread first'}
              disabled={!currentSessionId || isAwaitingQuestion} rows={1}
              className="w-full bg-transparent resize-none text-[13px] text-text placeholder:text-text-muted leading-relaxed"
              style={{ maxHeight: 180, outline: 'none' }} />
          </div>

          {/* Bottom toolbar */}
          <div className="flex items-center justify-between px-3 pb-2.5 pt-0.5">
            <div className="flex items-center gap-1">
              {/* Attach button */}
              <button onClick={() => fileInputRef.current?.click()}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer"
                title="Attach file">
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                  <line x1="7.5" y1="3" x2="7.5" y2="12" /><line x1="3" y1="7.5" x2="12" y2="7.5" />
                </svg>
              </button>
              <input ref={fileInputRef} type="file" multiple className="hidden"
                onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />

              {/* Model selector */}
              <div>
                <button ref={modelBtnRef} onClick={() => {
                  setInlinePicker(null)
                  setShowModelMenu(!showModelMenu)
                }}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-all cursor-pointer flex items-center gap-1">
                  {(availableModels[provider] || []).find(m => m.id === currentModel)?.label || currentModel}
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2"><polyline points="2,3 4,5.5 6,3"/></svg>
                </button>
              </div>

              {/* Directory indicator — shows current thread's working directory */}
              {currentDirectory && (
                <span className="px-2 py-1 rounded-lg text-[10px] text-text-muted flex items-center gap-1 truncate"
                  style={{ maxWidth: 160 }}
                  title={currentDirectory}>
                  <svg width="10" height="10" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" className="shrink-0">
                    <path d="M2 3.5C2 2.67 2.67 2 3.5 2H5.5L7 3.5H10.5C11.33 3.5 12 4.17 12 5V10.5C12 11.33 11.33 12 10.5 12H3.5C2.67 12 2 11.33 2 10.5V3.5Z" />
                  </svg>
                  {currentDirectory.split('/').pop()}
                </span>
              )}

              {/* Assistant/Plan mode toggle */}
              <button onClick={() => setAgentMode(agentMode === 'assistant' ? 'plan' : 'assistant')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all cursor-pointer flex items-center gap-1 ${
                  agentMode === 'plan'
                    ? 'bg-amber/15 text-amber'
                    : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
                }`}
                title={agentMode === 'plan' ? 'Plan mode: read-only analysis and audits' : 'Assistant mode: orchestrate tools and sub-agents'}>
                {agentMode === 'plan' ? 'Plan' : 'Assistant'}
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2"><polyline points="2,3 4,5.5 6,3"/></svg>
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              {/* Fork button */}
              {currentSessionId && !isGenerating && !isAwaitingPermission && !isAwaitingQuestion && (
                <button onClick={async () => {
                  if (!currentSessionId) return
                  const forked = await window.openCowork.session.fork(currentSessionId)
                  if (forked) {
                    const store = useSessionStore.getState()
                    store.addSession(forked)
                    store.setCurrentSession(forked.id)
                    await window.openCowork.session.activate(forked.id, { force: true })
                  }
                }}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-colors cursor-pointer"
                  title="Fork thread">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                    <line x1="7" y1="2" x2="7" y2="8" /><line x1="4" y1="5" x2="7" y2="8" /><line x1="10" y1="5" x2="7" y2="8" /><line x1="4" y1="8" x2="4" y2="12" /><line x1="10" y1="8" x2="10" y2="12" />
                  </svg>
                </button>
              )}

              {/* Stop button — visible when generating */}
              {isGenerating && (
                <button onClick={handleStop}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-red hover:bg-red/10 transition-colors cursor-pointer"
                  title="Stop generating (Esc)">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                    <rect x="3" y="3" width="8" height="8" rx="1.5" />
                  </svg>
                </button>
              )}

              {isAwaitingPermission && !isGenerating && (
                <div
                  className="px-2 py-1 rounded-lg text-[10px] font-medium"
                  style={{
                    color: 'var(--color-amber)',
                    background: 'color-mix(in srgb, var(--color-amber) 14%, transparent)',
                  }}
                  title="Approve or deny the pending tool request to continue">
                  Awaiting approval
                </div>
              )}

              {isAwaitingQuestion && !isGenerating && (
                <div
                  className="px-2 py-1 rounded-lg text-[10px] font-medium"
                  style={{
                    color: 'var(--color-accent)',
                    background: 'color-mix(in srgb, var(--color-accent) 14%, transparent)',
                  }}
                  title="Answer the pending question to continue">
                  Awaiting answer
                </div>
              )}

              {/* Send button */}
              <button onClick={isGenerating ? handleStop : handleSubmit} disabled={!canSend && !isGenerating}
                className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
                  isGenerating
                    ? 'bg-transparent text-text-muted hover:text-red'
                    : canSend
                      ? 'bg-text text-base'
                      : 'bg-transparent text-text-muted opacity-40'
                }`}>
                {isGenerating ? (
                  // Pulsing dot when generating
                  <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
                ) : (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="7" y1="11" x2="7" y2="3" /><polyline points="3.5,6 7,2.5 10.5,6" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {inlinePicker && (
        <div
          ref={inlinePickerRef}
          className="fixed z-50 rounded-xl border shadow-2xl overflow-hidden"
          style={{
            width: inlineMenuWidth,
            left: inlineMenuLeft,
            top: inlineMenuTop,
            background: 'color-mix(in srgb, var(--color-base) 96%, var(--color-text) 4%)',
            borderColor: 'var(--color-border)',
          }}
        >
          <div
            className="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] border-b"
            style={{
              color: 'var(--color-text-muted)',
              borderColor: 'var(--color-border-subtle)',
              background: 'color-mix(in srgb, var(--color-base) 88%, var(--color-text) 12%)',
            }}
          >
            {inlinePicker.trigger === '@' ? 'Sub-Agents' : 'Skills'}
          </div>
          {inlineSuggestions.map((item, index) => (
            <button
              key={`${inlinePicker.trigger}:${item.id}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertInlineSuggestion(item)}
              className="w-full px-3 py-2 text-left transition-colors cursor-pointer"
              style={{
                background: index === inlinePicker.selectedIndex ? 'var(--color-surface-hover)' : 'transparent',
              }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="px-1.5 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-[0.06em] border"
                  style={{
                    background: 'color-mix(in srgb, var(--color-base) 86%, var(--color-text) 14%)',
                    color: 'var(--color-text-secondary)',
                    borderColor: 'var(--color-border)',
                  }}
                >
                  {inlinePicker.trigger === '@' ? 'Agent' : 'Skill'}
                </span>
                <span className="text-[11px] font-medium text-text-secondary">{item.label}</span>
                <span className="text-[10px] text-text-muted font-mono">
                  {inlinePicker.trigger}{item.id}
                </span>
              </div>
              <div className="mt-1 text-[10px] text-text-muted">{compactDescription(item.description, 72)}</div>
            </button>
          ))}
          {inlineSuggestions.length === 0 ? (
            <div className="px-3 py-3 text-[11px] text-text-muted">
              No {inlinePicker.trigger === '@' ? 'sub-agents' : 'skills'} match “{inlinePicker.query}”.
            </div>
          ) : null}
        </div>
      )}

      {/* Model selector dropdown — Codex style */}
      {showModelMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowModelMenu(false)} />
          <div className="fixed z-50 w-52 rounded-xl border shadow-xl overflow-hidden"
            style={{
              background: 'var(--color-base)',
              borderColor: 'var(--color-border)',
              left: modelBtnRef.current ? modelBtnRef.current.getBoundingClientRect().left : 0,
              top: modelBtnRef.current ? modelBtnRef.current.getBoundingClientRect().top - ((availableModels[provider] || []).length * 34 + 40) : 0,
            }}>
            <div className="px-3 py-2 text-[11px] text-text-muted font-medium border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
              Model
            </div>
            {(availableModels[provider] || []).map(m => (
              <button key={m.id} onClick={async () => {
                setCurrentModel(m.id)
                setShowModelMenu(false)
                await window.openCowork.settings.set({ selectedModelId: m.id })
              }}
                className="w-full text-left px-3 py-2 text-[13px] cursor-pointer transition-colors hover:bg-surface-hover flex items-center justify-between"
                style={{ color: 'var(--color-text)' }}>
                {m.label}
                {currentModel === m.id && (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--color-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3,7.5 6,10.5 11,4" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
