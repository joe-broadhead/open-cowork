import { useState, useRef, useCallback } from 'react'
import { useSessionStore } from '../../stores/session'

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
  const [historyIndex, setHistoryIndex] = useState(-1) // -1 = current input, 0 = most recent, etc.
  const [savedCurrent, setSavedCurrent] = useState('') // saves current input when browsing history
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const isGenerating = useSessionStore((s) => s.isGenerating)
  const addMessage = useSessionStore((s) => s.addMessage)
  const setIsGenerating = useSessionStore((s) => s.setIsGenerating)
  const agentMode = useSessionStore((s) => s.agentMode)
  const setAgentMode = useSessionStore((s) => s.setAgentMode)

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

    // Save to prompt history
    if (text) {
      const history = loadHistory()
      // Avoid duplicates at the top
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); return }

    // Arrow up/down for prompt history (only when input is single line)
    const textarea = textareaRef.current
    if (!textarea) return
    const isAtStart = textarea.selectionStart === 0 && textarea.selectionEnd === 0
    const isAtEnd = textarea.selectionStart === input.length

    if (e.key === 'ArrowUp' && isAtStart) {
      const history = loadHistory()
      if (history.length === 0) return
      e.preventDefault()

      if (historyIndex === -1) {
        // Save current input before browsing
        setSavedCurrent(input)
      }
      const newIndex = Math.min(historyIndex + 1, history.length - 1)
      setHistoryIndex(newIndex)
      setInput(history[newIndex])
    }

    if (e.key === 'ArrowDown' && isAtEnd) {
      if (historyIndex < 0) return
      e.preventDefault()

      const newIndex = historyIndex - 1
      setHistoryIndex(newIndex)
      if (newIndex < 0) {
        setInput(savedCurrent)
      } else {
        setInput(loadHistory()[newIndex])
      }
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

  const canSend = (input.trim() || attachments.length > 0) && currentSessionId

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
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div
          className={`flex items-end gap-2 px-4 py-3 rounded-xl border bg-elevated transition-colors ${dragOver ? 'border-accent' : canSend ? 'border-border' : 'border-border-subtle'}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {/* Attach button */}
          <button onClick={() => fileInputRef.current?.click()}
            className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-text-muted hover:text-text-secondary transition-colors cursor-pointer"
            title="Attach file">
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <path d="M13 7.5L7.5 13a3.5 3.5 0 01-5-5L8 2.5a2.5 2.5 0 013.5 3.5L6 11.5A1.5 1.5 0 014 9.5l5-5" />
            </svg>
          </button>
          <input ref={fileInputRef} type="file" multiple className="hidden"
            onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />

          {/* Plan mode toggle */}
          <button onClick={() => setAgentMode(agentMode === 'build' ? 'plan' : 'build')}
            className={`shrink-0 px-2 py-1 rounded-md text-[10px] font-medium transition-all cursor-pointer ${
              agentMode === 'plan'
                ? 'bg-amber/15 text-amber'
                : 'text-text-muted hover:text-text-secondary'
            }`}
            title={agentMode === 'plan' ? 'Plan mode: read-only analysis' : 'Build mode: full capabilities'}>
            {agentMode === 'plan' ? '⚡ Plan' : '⚡ Build'}
          </button>

          <textarea ref={textareaRef} value={input} onChange={handleChange} onKeyDown={handleKeyDown} onPaste={handlePaste}
            placeholder={currentSessionId ? (agentMode === 'plan' ? 'Ask Cowork to analyze or plan...' : 'Ask Cowork anything... (paste images with ⌘V)') : 'Start a new thread first'}
            disabled={!currentSessionId} rows={1}
            className="flex-1 bg-transparent outline-none resize-none text-[13px] text-text placeholder:text-text-muted leading-relaxed"
            style={{ maxHeight: 180 }} />

          <button onClick={handleSubmit} disabled={!canSend}
            className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all cursor-pointer ${canSend ? 'bg-accent text-white' : 'bg-transparent text-text-muted'}`}
            style={{ opacity: canSend ? 1 : 0.4 }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="7" y1="11" x2="7" y2="3" /><polyline points="3.5,6 7,2.5 10.5,6" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
