import { useState, useRef, useCallback } from 'react'
import { useSessionStore } from '../../stores/session'

export function ChatInput() {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const isGenerating = useSessionStore((s) => s.isGenerating)
  const addMessage = useSessionStore((s) => s.addMessage)
  const setIsGenerating = useSessionStore((s) => s.setIsGenerating)

  const handleSubmit = useCallback(async () => {
    const text = input.trim()
    if (!text || !currentSessionId || isGenerating) return

    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    addMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    })

    setIsGenerating(true)
    try {
      // promptAsync — returns immediately, response streams via SSE events
      // setIsGenerating(false) is triggered by the 'done' event in useOpenCodeEvents
      await window.cowork.session.prompt(currentSessionId, text)
    } catch (err) {
      console.error('Prompt failed:', err)
      setIsGenerating(false)
    }
  }, [input, currentSessionId, isGenerating, addMessage, setIsGenerating])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 180) + 'px'
  }

  const canSend = input.trim() && currentSessionId && !isGenerating

  return (
    <div className="px-6 pb-5 pt-2">
      <div className="max-w-[720px] mx-auto">
        <div className={`flex items-end gap-2 px-4 py-3 rounded-xl border bg-elevated transition-colors ${canSend ? 'border-border' : 'border-border-subtle'}`}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={currentSessionId ? 'Ask Cowork anything...' : 'Start a new thread first'}
            disabled={!currentSessionId}
            rows={1}
            className="flex-1 bg-transparent outline-none resize-none text-[13px] text-text placeholder:text-text-muted leading-relaxed"
            style={{ maxHeight: 180 }}
          />
          <button
            onClick={handleSubmit}
            disabled={!canSend}
            className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
              canSend ? 'bg-accent text-white' : 'bg-transparent text-text-muted'
            }`}
            style={{ opacity: canSend ? 1 : 0.4 }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="7" y1="11" x2="7" y2="3" />
              <polyline points="3.5,6 7,2.5 10.5,6" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
