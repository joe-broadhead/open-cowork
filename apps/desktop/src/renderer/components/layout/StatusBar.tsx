import { useSessionStore } from '../../stores/session'

export function StatusBar() {
  const mcpConnections = useSessionStore((s) => s.mcpConnections)
  const isGenerating = useSessionStore((s) => s.isGenerating)

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
        <span>Gemini 3 Pro</span>
      </div>
      <div className="flex items-center gap-3">
        {mcpConnections.map((mcp) => (
          <div key={mcp.name} className="flex items-center gap-1.5">
            <div
              className="w-[5px] h-[5px] rounded-full"
              style={{
                background: mcp.connected ? 'var(--color-green)' : 'var(--color-text-muted)',
                boxShadow: mcp.connected ? '0 0 4px var(--color-green)' : 'none',
              }}
            />
            <span>{mcp.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
