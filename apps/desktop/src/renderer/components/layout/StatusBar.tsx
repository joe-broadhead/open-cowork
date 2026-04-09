import { useState, useEffect } from 'react'
import { useSessionStore } from '../../stores/session'

export function StatusBar() {
  const mcpConnections = useSessionStore((s) => s.mcpConnections)
  const isGenerating = useSessionStore((s) => s.isGenerating)
  const [modelName, setModelName] = useState('...')

  useEffect(() => {
    window.cowork.settings.get().then((s: any) => {
      const name = s.defaultModel
        ?.replace('databricks-', '')
        .replace('gemini-', 'Gemini ')
        .replace('claude-', 'Claude ')
        .replace(/-/g, ' ')
      setModelName(name || s.defaultModel)
    })
  }, [])

  const up = mcpConnections.filter((m) => m.connected).length
  const total = mcpConnections.length

  return (
    <div className="flex items-center justify-between h-[28px] px-4 shrink-0 select-none text-[11px] bg-surface border-t border-border-subtle text-text-muted">
      <div className="flex items-center gap-2.5">
        {isGenerating ? (
          <span className="text-accent flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            Thinking...
          </span>
        ) : (
          <span>Ready</span>
        )}
        <span className="text-border">|</span>
        <span className="capitalize">{modelName}</span>
      </div>
      {total > 0 && (
        <div className="flex items-center gap-1.5">
          <div className="w-[5px] h-[5px] rounded-full" style={{ background: up === total ? 'var(--color-green)' : up > 0 ? 'var(--color-amber)' : 'var(--color-red)', boxShadow: up === total ? '0 0 4px var(--color-green)' : 'none' }} />
          <span>{up}/{total} connected</span>
        </div>
      )}
    </div>
  )
}
