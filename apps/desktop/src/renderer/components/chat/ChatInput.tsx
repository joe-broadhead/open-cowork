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

export function ChatInput() {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const isGenerating = useSessionStore((s) => s.isGenerating)
  const addMessage = useSessionStore((s) => s.addMessage)
  const setIsGenerating = useSessionStore((s) => s.setIsGenerating)

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

    const currentAttachments = [...attachments]
    setInput('')
    setAttachments([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    const displayText = text + (currentAttachments.length ? ` [${currentAttachments.length} file${currentAttachments.length > 1 ? 's' : ''}]` : '')
    addMessage({ id: crypto.randomUUID(), role: 'user', content: displayText })

    setIsGenerating(true)
    try {
      const files = currentAttachments.map(a => ({ mime: a.mime, url: a.url, filename: a.filename }))
      await window.cowork.session.prompt(currentSessionId, text || 'Describe this image.', files.length > 0 ? files : undefined)
    } catch (err) {
      console.error('Prompt failed:', err)
      setIsGenerating(false)
    }
  }, [input, attachments, currentSessionId, addMessage, setIsGenerating])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit() }
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
          <div className="flex gap-2 mb-2 flex-wrap">
            {attachments.map((a, i) => (
              <div key={i} className="relative group/att">
                {a.preview ? (
                  <img src={a.preview} alt={a.filename} className="w-16 h-16 rounded-lg object-cover border border-border" />
                ) : (
                  <div className="w-16 h-16 rounded-lg border border-border bg-surface flex items-center justify-center text-[10px] text-text-muted px-1 text-center truncate">
                    {a.filename}
                  </div>
                )}
                <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red text-white text-[9px] flex items-center justify-center opacity-0 group-hover/att:opacity-100 cursor-pointer">
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
          <input ref={fileInputRef} type="file" accept="image/*,.pdf,.txt,.csv,.json" multiple className="hidden"
            onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />

          <textarea ref={textareaRef} value={input} onChange={handleChange} onKeyDown={handleKeyDown} onPaste={handlePaste}
            placeholder={currentSessionId ? 'Ask Cowork anything... (paste images with ⌘V)' : 'Start a new thread first'}
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
