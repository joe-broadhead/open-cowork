import { useSessionStore } from '../../stores/session'

export function McpStatus() {
  const mcpConnections = useSessionStore((s) => s.mcpConnections)

  return (
    <div className="flex flex-col gap-px">
      {mcpConnections.map((mcp) => (
        <div key={mcp.name} className="flex items-center gap-2.5 px-3 py-[6px] rounded-md text-[13px] text-text-secondary">
          <div
            className="w-[6px] h-[6px] rounded-full shrink-0"
            style={{
              background: mcp.connected ? 'var(--color-green)' : 'var(--color-text-muted)',
              boxShadow: mcp.connected ? '0 0 5px var(--color-green)' : 'none',
            }}
          />
          {mcp.name}
        </div>
      ))}
    </div>
  )
}
