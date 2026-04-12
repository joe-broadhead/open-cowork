import { useEffect, useMemo, useState } from 'react'
import type { AgentCatalog, BuiltInAgentDetail, CustomAgentSummary, RuntimeAgentInfo } from '@cowork/shared'
import { BuiltInAgentDetail as BuiltInAgentDetailView } from './BuiltInAgentDetail'
import { CustomAgentForm } from './CustomAgentForm'

function agentPillStyle(color?: string) {
  const tone = color === 'success'
    ? 'var(--color-green)'
    : color === 'warning'
      ? 'var(--color-amber)'
      : color === 'secondary'
        ? 'var(--color-text-secondary)'
        : 'var(--color-accent)'

  return {
    color: tone,
    background: `color-mix(in srgb, ${tone} 12%, transparent)`,
  }
}

function statusPillStyle(kind: 'builtin' | 'primary' | 'hidden' | 'visible' | 'custom') {
  if (kind === 'builtin' || kind === 'custom') {
    return {
      color: 'var(--color-accent)',
      background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
    }
  }

  if (kind === 'primary') {
    return {
      color: 'var(--color-text-secondary)',
      background: 'color-mix(in srgb, var(--color-text-muted) 12%, transparent)',
    }
  }

  if (kind === 'hidden') {
    return {
      color: 'var(--color-amber)',
      background: 'color-mix(in srgb, var(--color-amber) 12%, transparent)',
    }
  }

  return {
    color: 'var(--color-green)',
    background: 'color-mix(in srgb, var(--color-green) 12%, transparent)',
  }
}

export function AgentsPage({ onClose, onOpenPlugins }: { onClose: () => void; onOpenPlugins: () => void }) {
  const [agents, setAgents] = useState<CustomAgentSummary[]>([])
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null)
  const [runtimeAgents, setRuntimeAgents] = useState<RuntimeAgentInfo[]>([])
  const [builtinDetails, setBuiltinDetails] = useState<BuiltInAgentDetail[]>([])
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [selectedBuiltInName, setSelectedBuiltInName] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = () => {
    window.cowork.agents.list().then(setAgents)
    window.cowork.agents.catalog().then(setCatalog)
    window.cowork.app.agents().then(setRuntimeAgents)
    window.cowork.app.builtinAgents().then(setBuiltinDetails)
  }

  useEffect(() => {
    refresh()
    const unsubscribe = window.cowork.on.runtimeReady(() => refresh())
    return unsubscribe
  }, [])

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.name === selectedName) || null,
    [agents, selectedName],
  )

  const selectedBuiltInAgent = useMemo(
    () => builtinDetails.find((agent) => agent.name === selectedBuiltInName) || null,
    [builtinDetails, selectedBuiltInName],
  )

  const builtInAgents = useMemo(() => {
    const runtimeByName = new Map(runtimeAgents.map((agent) => [agent.name, agent]))
    return builtinDetails.map((detail) => {
      const runtime = runtimeByName.get(detail.name)
      return {
        ...detail,
        description: runtime?.description || detail.description,
        mode: (runtime?.mode as BuiltInAgentDetail['mode'] | undefined) || detail.mode,
        hidden: runtime?.hidden ?? detail.hidden,
        color: runtime?.color || detail.color,
      }
    })
  }, [builtinDetails, runtimeAgents])

  if (selectedBuiltInAgent) {
    return (
      <BuiltInAgentDetailView
        agent={selectedBuiltInAgent}
        onBack={() => setSelectedBuiltInName(null)}
      />
    )
  }

  if (catalog && (creating || selectedAgent)) {
    return (
      <CustomAgentForm
        agent={selectedAgent}
        catalog={catalog}
        onCancel={() => {
          setCreating(false)
          setSelectedName(null)
        }}
        onSaved={() => {
          setCreating(false)
          setSelectedName(null)
          refresh()
        }}
        onOpenPlugins={onOpenPlugins}
      />
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[800px] mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[18px] font-semibold text-text mb-1">Agents</h1>
            <p className="text-[13px] text-text-secondary leading-relaxed">Create focused OpenCode sub-agents that Cowork can delegate to and you can invoke with `@mentions`.</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-[12px] text-text-muted hover:text-text-secondary cursor-pointer">Back to chat</button>
            <button
              onClick={() => {
                setSelectedName(null)
                setSelectedBuiltInName(null)
                setCreating(true)
              }}
              className="px-4 py-2 rounded-lg text-[13px] font-medium cursor-pointer"
              style={{ background: 'var(--color-accent)', color: '#fff' }}
            >
              New sub-agent
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="rounded-xl border border-border-subtle bg-surface p-4">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-[13px] font-semibold text-text">Built-in agents</h2>
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={statusPillStyle('builtin')}>
                    Read-only examples
                  </span>
                </div>
                <p className="text-[12px] text-text-secondary leading-relaxed">
                  Inspect Cowork’s built-in agents to see how primary agents, visible sub-agents, and internal writer agents are structured.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3">
              {builtInAgents.map((agent) => (
                <div key={agent.name} className="rounded-xl border border-border-subtle bg-elevated p-4">
                  <div className="flex items-start justify-between gap-4">
                    <button
                      onClick={() => setSelectedBuiltInName(agent.name)}
                      className="flex-1 min-w-0 text-left cursor-pointer"
                    >
                      <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={agentPillStyle(agent.color)}>
                          {agent.label}
                        </span>
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={statusPillStyle(agent.mode === 'primary' ? 'primary' : 'visible')}>
                          {agent.mode === 'primary' ? 'Primary' : 'Sub-agent'}
                        </span>
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={statusPillStyle(agent.hidden ? 'hidden' : 'visible')}>
                          {agent.hidden ? 'Internal only' : agent.mode === 'primary' ? 'Top-level mode' : 'Visible in @mentions'}
                        </span>
                      </div>
                      <div className="text-[12px] text-text-secondary mb-2 leading-relaxed">{agent.description}</div>
                      <div className="flex flex-wrap gap-2 text-[10px] text-text-muted">
                        <span>{agent.toolScopes.length} tool scopes</span>
                        <span>{agent.skills.length} skills</span>
                        <span>id: {agent.name}</span>
                      </div>
                    </button>
                    <button
                      onClick={() => setSelectedBuiltInName(agent.name)}
                      className="px-3 py-1.5 rounded-lg text-[12px] text-text-secondary bg-surface-hover cursor-pointer shrink-0"
                    >
                      View
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 text-[12px] text-text-muted mt-1">
            <span>Custom sub-agents</span>
            <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={statusPillStyle('custom')}>
              Editable
            </span>
          </div>

          {agents.map((agent) => {
            const statusLabel = !agent.valid
              ? 'Needs attention'
              : agent.enabled
                ? agent.writeAccess ? 'Write-enabled' : 'Read-only'
                : 'Disabled'

            return (
              <div key={agent.name} className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="flex items-start justify-between gap-4">
                  <button onClick={() => setSelectedName(agent.name)} className="flex-1 text-left cursor-pointer">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[13px] font-medium text-text">{agent.name}</span>
                      <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={{
                        color: !agent.valid
                          ? 'var(--color-amber)'
                          : agent.writeAccess
                            ? 'var(--color-green)'
                            : 'var(--color-text-muted)',
                        background: !agent.valid
                          ? 'color-mix(in srgb, var(--color-amber) 12%, transparent)'
                          : agent.writeAccess
                            ? 'color-mix(in srgb, var(--color-green) 12%, transparent)'
                            : 'color-mix(in srgb, var(--color-text-muted) 12%, transparent)',
                      }}>
                        {statusLabel}
                      </span>
                    </div>
                    <div className="text-[12px] text-text-secondary mb-2">{agent.description}</div>
                    <div className="flex flex-wrap gap-2 text-[10px] text-text-muted">
                      <span>{agent.skillNames.length} skills</span>
                      <span>{agent.integrationIds.length} integrations</span>
                      <span>{agent.enabled ? 'Visible in @mentions' : 'Disabled'}</span>
                    </div>
                    {agent.issues.length > 0 ? (
                      <div className="mt-2 flex flex-col gap-1 text-[11px]" style={{ color: 'var(--color-amber)' }}>
                        {agent.issues.map((issue) => (
                          <div key={`${issue.code}:${issue.message}`}>{issue.message}</div>
                        ))}
                      </div>
                    ) : null}
                  </button>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setSelectedName(agent.name)}
                      className="px-3 py-1.5 rounded-lg text-[12px] text-text-secondary bg-surface-hover cursor-pointer"
                    >
                      Edit
                    </button>
                    <button
                      onClick={async () => {
                        await window.cowork.agents.remove(agent.name)
                        refresh()
                      }}
                      className="px-3 py-1.5 rounded-lg text-[12px] text-text-muted hover:text-red bg-surface-hover cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {agents.length === 0 ? (
          <div className="mt-6 text-[12px] text-text-muted py-6 text-center rounded-xl border border-border-subtle border-dashed">
            No custom sub-agents yet. Create one to give Cowork a focused specialist that can be delegated to or invoked with `@mentions`.
          </div>
        ) : null}
      </div>
    </div>
  )
}
