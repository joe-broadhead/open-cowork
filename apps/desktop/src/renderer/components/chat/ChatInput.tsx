import { useState, useRef, useCallback, useEffect } from 'react'
import { useSessionStore } from '../../stores/session'

const MODELS: Record<string, Array<{ id: string; label: string }>> = {
  databricks: [
    { id: 'databricks-claude-sonnet-4', label: 'Sonnet 4' },
    { id: 'databricks-claude-opus-4-6', label: 'Opus 4.6' },
    { id: 'databricks-claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'databricks-gpt-oss-120b', label: 'GPT 120B' },
  ],
  vertex: [
    { id: 'gemini-2.5-pro', label: 'Gemini Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini Flash' },
  ],
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
const HISTORY_KEY = 'cowork-prompt-history'
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
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modelBtnRef = useRef<HTMLButtonElement>(null)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const isGenerating = useSessionStore((s) => s.isGenerating)
  const addMessage = useSessionStore((s) => s.addMessage)
  const setIsGenerating = useSessionStore((s) => s.setIsGenerating)
  const agentMode = useSessionStore((s) => s.agentMode)
  const setAgentMode = useSessionStore((s) => s.setAgentMode)
  const [currentModel, setCurrentModel] = useState('')
  const [provider, setProvider] = useState('')
  const [showModelMenu, setShowModelMenu] = useState(false)

  useEffect(() => {
    window.cowork.settings.get().then((s: any) => {
      setCurrentModel(s.effectiveModel || s.defaultModel || '')
      setProvider(s.provider || 'databricks')
    })
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

    addMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: text || (currentAttachments.length ? 'Sent attachments' : ''),
      attachments: currentAttachments.map(a => ({ mime: a.mime, url: a.url, filename: a.filename })),
    })

    setIsGenerating(true)
    try {
      const files = currentAttachments.map(a => ({ mime: a.mime, url: a.url, filename: a.filename }))
      await window.cowork.session.prompt(
        currentSessionId,
        text || 'Describe this image.',
        files.length > 0 ? files : undefined,
        agentMode !== 'build' ? agentMode : undefined,
      )
    } catch (err) {
      console.error('Prompt failed:', err)
      setIsGenerating(false)
    }
  }, [input, attachments, currentSessionId, addMessage, setIsGenerating, agentMode])

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

  const handleStop = useCallback(async () => {
    if (!currentSessionId) return
    try {
      await window.cowork.session.abort(currentSessionId)
    } catch (err) {
      console.error('Abort failed:', err)
    }
    setIsGenerating(false)
  }, [currentSessionId, setIsGenerating])

  const handleKeyDown = (e: React.KeyboardEvent) => {
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

  const canSend = (input.trim() || attachments.length > 0) && currentSessionId && !isGenerating

  return (
    <div className="px-6 pb-4 pt-2">
      <div className="max-w-[720px] mx-auto">
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
                  style={{ background: 'var(--color-red)', color: '#fff' }}>
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
              placeholder={currentSessionId ? (agentMode === 'plan' ? 'Ask Cowork to analyze or plan...' : 'Ask Cowork anything...') : 'Start a new thread first'}
              disabled={!currentSessionId} rows={1}
              className="w-full bg-transparent outline-none resize-none text-[13px] text-text placeholder:text-text-muted leading-relaxed"
              style={{ maxHeight: 180 }} />
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
                <button ref={modelBtnRef} onClick={() => setShowModelMenu(!showModelMenu)}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium text-text-muted hover:text-text-secondary hover:bg-surface-hover transition-all cursor-pointer flex items-center gap-1">
                  {(MODELS[provider] || []).find(m => m.id === currentModel)?.label || currentModel.replace('databricks-', '').replace('gemini-', '')}
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2"><polyline points="2,3 4,5.5 6,3"/></svg>
                </button>
              </div>

              {/* Plan/Build mode toggle */}
              <button onClick={() => setAgentMode(agentMode === 'build' ? 'plan' : 'build')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all cursor-pointer flex items-center gap-1 ${
                  agentMode === 'plan'
                    ? 'bg-amber/15 text-amber'
                    : 'text-text-muted hover:text-text-secondary hover:bg-surface-hover'
                }`}
                title={agentMode === 'plan' ? 'Plan mode: read-only analysis' : 'Build mode: full capabilities'}>
                {agentMode === 'plan' ? 'Plan' : 'Build'}
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.2"><polyline points="2,3 4,5.5 6,3"/></svg>
              </button>
            </div>

            <div className="flex items-center gap-1.5">
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

      {/* Model selector dropdown — Codex style */}
      {showModelMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowModelMenu(false)} />
          <div className="fixed z-50 w-52 rounded-xl border shadow-xl overflow-hidden"
            style={{
              background: 'var(--color-base)',
              borderColor: 'var(--color-border)',
              left: modelBtnRef.current ? modelBtnRef.current.getBoundingClientRect().left : 0,
              top: modelBtnRef.current ? modelBtnRef.current.getBoundingClientRect().top - ((MODELS[provider] || []).length * 34 + 40) : 0,
            }}>
            <div className="px-3 py-2 text-[11px] text-text-muted font-medium border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
              Model
            </div>
            {(MODELS[provider] || []).map(m => (
              <button key={m.id} onClick={async () => {
                setCurrentModel(m.id)
                setShowModelMenu(false)
                await window.cowork.settings.set({ defaultModel: m.id })
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
