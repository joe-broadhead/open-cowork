import { useState, useEffect, useRef } from 'react'
import { useSessionStore } from '../stores/session'

interface Command {
  name: string
  description?: string
  source?: string
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [commands, setCommands] = useState<Command[]>([])
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const currentSessionId = useSessionStore((s) => s.currentSessionId)

  useEffect(() => {
    inputRef.current?.focus()
    ;window.openCowork.command.list().then((cmds: Command[]) => {
      setCommands(cmds || [])
    }).catch(() => {})
    // Load tools
    window.openCowork.tools.list().then((tools: any[]) => {
      if (tools?.length) {
        const toolCmds = tools.map((t: any) => ({
          name: t.id || t.name || 'unknown',
          description: t.description || '',
          source: 'tool',
        }))
        setCommands(prev => [...prev, ...toolCmds])
      }
    }).catch(() => {})
    // Load agents
    ;(window.openCowork as any).app?.agents?.().then((agents: any[]) => {
      if (agents?.length) {
        const agentCmds = agents.map((a: any) => ({
          name: a.name || 'unknown',
          description: a.description || '',
          source: 'agent',
        }))
        setCommands(prev => [...prev, ...agentCmds])
      }
    }).catch(() => {})
  }, [])

  const filtered = query
    ? commands.filter(c => c.name.toLowerCase().includes(query.toLowerCase()) || c.description?.toLowerCase().includes(query.toLowerCase()))
    : commands

  useEffect(() => { setSelected(0) }, [query])

  const handleSelect = async (cmd: Command) => {
    if (!currentSessionId) { onClose(); return }
    if (cmd.source === 'skill' || cmd.source === 'command') {
      await window.openCowork.command.run(currentSessionId, cmd.name)
    }
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, filtered.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)) }
    if (e.key === 'Enter' && filtered[selected]) { handleSelect(filtered[selected]) }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40" onClick={onClose} />
      <div className="fixed top-[15%] left-1/2 -translate-x-1/2 z-50 w-[480px] rounded-xl border shadow-2xl overflow-hidden"
        style={{ background: 'var(--color-base)', borderColor: 'var(--color-border)' }}>
        <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
          <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Search commands, skills, and tools..."
            className="w-full bg-transparent text-[14px] text-text outline-none placeholder:text-text-muted" />
        </div>
        <div className="max-h-[300px] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-[12px] text-text-muted text-center">No commands found</div>
          )}
          {filtered.slice(0, 20).map((cmd, i) => (
            <button key={cmd.name} onClick={() => handleSelect(cmd)}
              className={`w-full text-left px-4 py-2 flex items-center justify-between cursor-pointer transition-colors ${i === selected ? 'bg-surface-hover' : ''}`}>
              <div>
                <div className="text-[13px] text-text font-mono">{cmd.name}</div>
                {cmd.description && <div className="text-[11px] text-text-muted mt-0.5 truncate" style={{ maxWidth: 380 }}>{cmd.description}</div>}
              </div>
              {cmd.source && (
                <span className="text-[9px] px-1.5 py-0.5 rounded shrink-0"
                  style={{
                    background: cmd.source === 'skill'
                      ? 'color-mix(in srgb, var(--color-accent) 12%, transparent)'
                      : 'var(--color-surface-hover)',
                    color: cmd.source === 'skill' ? 'var(--color-accent)' : 'var(--color-text-muted)',
                  }}>
                  {cmd.source}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
