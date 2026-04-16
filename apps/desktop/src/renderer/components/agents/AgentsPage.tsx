import { useEffect, useMemo, useState } from 'react'
import type { AgentCatalog, BuiltInAgentDetail, CustomAgentConfig, CustomAgentSummary, RuntimeAgentDescriptor } from '@open-cowork/shared'
import { BuiltInAgentDetail as BuiltInAgentDetailView } from './BuiltInAgentDetail'
import { CustomAgentForm } from './CustomAgentForm'
import { confirmAgentRemoval } from '../../helpers/destructive-actions'
import { useSessionStore } from '../../stores/session'

type Filter = 'all' | 'builtin' | 'custom'

function statusPillStyle(kind: 'primary' | 'hidden' | 'visible' | 'warning' | 'readOnly' | 'writeEnabled' | 'disabled') {
  if (kind === 'primary') {
    return {
      color: 'var(--color-text-secondary)',
      background: 'color-mix(in srgb, var(--color-text-muted) 12%, transparent)',
    }
  }

  if (kind === 'hidden' || kind === 'warning') {
    return {
      color: 'var(--color-amber)',
      background: 'color-mix(in srgb, var(--color-amber) 12%, transparent)',
    }
  }

  if (kind === 'writeEnabled' || kind === 'visible') {
    return {
      color: 'var(--color-green)',
      background: 'color-mix(in srgb, var(--color-green) 12%, transparent)',
    }
  }

  if (kind === 'disabled') {
    return {
      color: 'var(--color-text-muted)',
      background: 'color-mix(in srgb, var(--color-text-muted) 12%, transparent)',
    }
  }

  return {
    color: 'var(--color-accent)',
    background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
  }
}

function agentIconStyle(color?: string) {
  const tone = color === 'success'
    ? 'var(--color-green)'
    : color === 'warning'
      ? 'var(--color-amber)'
      : color === 'secondary'
        ? 'var(--color-text-secondary)'
        : 'var(--color-accent)'

  return {
    color: tone,
    background: `color-mix(in srgb, ${tone} 14%, var(--color-elevated))`,
    borderColor: `color-mix(in srgb, ${tone} 20%, var(--color-border))`,
  }
}

function agentInitial(label: string) {
  return label.trim().charAt(0).toUpperCase() || 'A'
}

function matchesSearch(search: string, ...values: Array<string | undefined | null>) {
  const query = search.trim().toLowerCase()
  if (!query) return true
  return values.some((value) => value?.toLowerCase().includes(query))
}

function formatBuiltInSupport(agent: BuiltInAgentDetail) {
  return agent.hidden
    ? 'Internal'
    : agent.mode === 'primary'
      ? 'Top-level'
      : 'In chat'
}

function formatCustomStatus(agent: CustomAgentSummary) {
  if (!agent.valid) return 'Needs attention'
  if (!agent.enabled) return 'Off'
  return agent.writeAccess ? 'Read + write' : 'Read only'
}

function statusKindForCustom(agent: CustomAgentSummary): 'warning' | 'disabled' | 'writeEnabled' | 'readOnly' {
  if (!agent.valid) return 'warning'
  if (!agent.enabled) return 'disabled'
  return agent.writeAccess ? 'writeEnabled' : 'readOnly'
}

function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`
}

export function AgentsPage({
  onClose,
  onOpenCapabilities,
  initialDraft,
  onClearDraft,
}: {
  onClose: () => void
  onOpenCapabilities: () => void
  initialDraft?: Partial<CustomAgentConfig> | null
  onClearDraft?: () => void
}) {
  const [agents, setAgents] = useState<CustomAgentSummary[]>([])
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null)
  const [builtinDetails, setBuiltinDetails] = useState<BuiltInAgentDetail[]>([])
  const [runtimeAgents, setRuntimeAgents] = useState<RuntimeAgentDescriptor[]>([])
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [selectedBuiltInName, setSelectedBuiltInName] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const sessions = useSessionStore((state) => state.sessions)

  const projectDirectory = useMemo(
    () => sessions.find((session) => session.id === currentSessionId)?.directory || null,
    [currentSessionId, sessions],
  )

  const contextOptions = useMemo(
    () => projectDirectory ? { directory: projectDirectory } : undefined,
    [projectDirectory],
  )

  const refresh = () => {
    window.openCowork.agents.list(contextOptions).then(setAgents)
    window.openCowork.agents.catalog(contextOptions).then(setCatalog)
    window.openCowork.app.builtinAgents().then(setBuiltinDetails)
    window.openCowork.agents.runtime().then(setRuntimeAgents).catch(() => setRuntimeAgents([]))
  }

  useEffect(() => {
    refresh()
    const unsubscribe = window.openCowork.on.runtimeReady(() => refresh())
    return unsubscribe
  }, [projectDirectory])

  useEffect(() => {
    if (!initialDraft) return
    setSelectedName(null)
    setSelectedBuiltInName(null)
    setCreating(true)
  }, [initialDraft])

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.name === selectedName) || null,
    [agents, selectedName],
  )

  const selectedBuiltInAgent = useMemo(
    () => builtinDetails.find((agent) => agent.name === selectedBuiltInName) || null,
    [builtinDetails, selectedBuiltInName],
  )

  const builtInAgents = useMemo(() => (
    builtinDetails
      .slice()
      .sort((a, b) => {
        const score = (agent: BuiltInAgentDetail) => {
          if (agent.mode === 'primary') return 0
          if (!agent.hidden) return 1
          return 2
        }
        return score(a) - score(b) || a.label.localeCompare(b.label)
      })
  ), [builtinDetails])

  const filteredBuiltIns = useMemo(() => (
    builtInAgents.filter((agent) => matchesSearch(
      search,
      agent.label,
      agent.name,
      agent.description,
      agent.instructions,
      ...agent.skills,
      ...agent.toolAccess,
    ))
  ), [builtInAgents, search])

  const filteredCustom = useMemo(() => (
    agents.filter((agent) => matchesSearch(
      search,
      agent.name,
      agent.description,
      agent.instructions,
      ...agent.skillNames,
      ...agent.toolIds,
      ...agent.issues.map((issue) => issue.message),
    ))
  ), [agents, search])

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
          initialDraft={creating ? initialDraft : null}
          catalog={catalog}
          existingAgentNames={agents.map((entry) => entry.name)}
          projectDirectory={projectDirectory}
          onCancel={() => {
            setCreating(false)
            setSelectedName(null)
            onClearDraft?.()
          }}
          onSaved={() => {
            setCreating(false)
            setSelectedName(null)
            onClearDraft?.()
            refresh()
          }}
          onOpenCapabilities={onOpenCapabilities}
        />
    )
  }

  const showBuiltIns = filter !== 'custom'
  const showCustom = filter !== 'builtin'

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1040px] mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[18px] font-semibold text-text">Agents</h1>
            <p className="text-[13px] text-text-secondary mt-1">
              Inspect Open Cowork’s built-ins and create focused agents that can be delegated to or invoked with `@mentions`.
            </p>
          </div>
          <button onClick={onClose} className="text-[12px] text-text-muted hover:text-text-secondary cursor-pointer">Back to chat</button>
        </div>

        <div className="flex items-center gap-3 mb-6">
          <div className="flex-1">
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search agents, tools, skills, or instructions..."
              className="w-full px-4 py-2.5 rounded-xl bg-elevated border border-border-subtle text-[13px] text-text placeholder:text-text-muted outline-none focus:border-border"
            />
          </div>
          <div className="flex rounded-lg border border-border-subtle overflow-hidden">
            {(['all', 'builtin', 'custom'] as const).map((value) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={`px-3 py-1.5 text-[12px] font-medium cursor-pointer transition-colors capitalize ${filter === value ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text-secondary'}`}
              >
                {value === 'builtin' ? 'Built-in' : value}
              </button>
            ))}
          </div>
        </div>

        {showBuiltIns && (
          <div className="mb-8">
            <div className="flex items-start justify-between gap-4 mb-3">
              <div>
                <h2 className="text-[14px] font-semibold text-text">Built-in agents</h2>
                <p className="text-[12px] text-text-muted mt-1">
                  OpenCode’s built-in modes plus the focused agents Open Cowork ships on top of configured tools and skills.
                </p>
              </div>
              <span
                className="px-2 py-1 rounded-md text-[10px] font-medium shrink-0"
                style={statusPillStyle('readOnly')}
              >
                Built-in catalog
              </span>
            </div>

            {filteredBuiltIns.length === 0 ? (
              <div className="text-[12px] text-text-muted py-4 text-center rounded-xl border border-border-subtle border-dashed">
                No built-in agents matched your search.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {filteredBuiltIns.map((agent) => (
                  <button
                    key={agent.name}
                    onClick={() => setSelectedBuiltInName(agent.name)}
                    className="flex items-start gap-3.5 p-4 rounded-xl border border-border-subtle bg-surface hover:bg-surface-hover transition-colors cursor-pointer text-left"
                  >
                    <div
                      className="w-10 h-10 rounded-xl border flex items-center justify-center text-[14px] font-semibold shrink-0"
                      style={agentIconStyle(agent.color)}
                    >
                      {agentInitial(agent.label)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2 mb-1">
                        <span className="text-[13px] font-medium text-text">{agent.label}</span>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={statusPillStyle(agent.mode === 'primary' ? 'primary' : 'visible')}>
                          {agent.mode === 'primary' ? 'Top-level' : 'Sub-agent'}
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={statusPillStyle(agent.disabled ? 'disabled' : agent.hidden ? 'hidden' : 'visible')}>
                          {agent.disabled ? 'Disabled' : formatBuiltInSupport(agent)}
                        </span>
                        {agent.model && (
                          <span
                            className="px-1.5 py-0.5 rounded text-[9px] font-medium font-mono"
                            title={`Inference override: ${agent.model}`}
                            style={{
                              color: 'var(--color-info)',
                              background: 'color-mix(in srgb, var(--color-info) 12%, transparent)',
                            }}
                          >
                            {agent.model.split('/').pop()}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-text-muted leading-relaxed line-clamp-2">{agent.description}</p>
                      <div className="flex flex-wrap gap-2 mt-2 text-[10px] text-text-muted">
                        <span>{countLabel(agent.toolAccess.length, 'tool', 'tools')}</span>
                        <span>{countLabel(agent.skills.length, 'skill', 'skills')}</span>
                        <span>id: {agent.name}</span>
                        {typeof agent.temperature === 'number' && (
                          <span title="Configured temperature">temp {agent.temperature}</span>
                        )}
                        {typeof agent.steps === 'number' && (
                          <span title="Max agentic steps">{agent.steps} steps</span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {showCustom && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-[14px] font-semibold text-text">Custom agents</h2>
                <p className="text-[12px] text-text-muted mt-1">
                  Build your own focused agents by choosing tools, skills, and instructions.
                </p>
              </div>
              <button
                onClick={() => {
                  setSelectedName(null)
                  setSelectedBuiltInName(null)
                  setCreating(true)
                  onClearDraft?.()
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-accent hover:bg-surface-hover cursor-pointer border border-border-subtle"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="5" y1="1.5" x2="5" y2="8.5" /><line x1="1.5" y1="5" x2="8.5" y2="5" /></svg>
                New agent
              </button>
            </div>

            {filteredCustom.length === 0 ? (
              <div className="text-[12px] text-text-muted py-4 text-center rounded-xl border border-border-subtle border-dashed">
                {agents.length === 0
                  ? 'No custom agents yet. Create one to teach Open Cowork a new delegated role.'
                  : 'No custom agents matched your search.'}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {filteredCustom.map((agent) => (
                  <div key={agent.name} className="rounded-xl border border-border-subtle bg-surface overflow-hidden">
                    <button
                      onClick={() => setSelectedName(agent.name)}
                      className="w-full flex items-start gap-3.5 p-4 text-left hover:bg-surface-hover transition-colors cursor-pointer"
                    >
                      <div
                        className="w-10 h-10 rounded-xl border flex items-center justify-center text-[14px] font-semibold shrink-0"
                        style={agentIconStyle(agent.color)}
                      >
                        {agentInitial(agent.name)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="text-[13px] font-medium text-text">{agent.name}</span>
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={statusPillStyle(statusKindForCustom(agent))}>
                            {formatCustomStatus(agent)}
                          </span>
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={statusPillStyle(agent.enabled ? 'visible' : 'disabled')}>
                            {agent.enabled ? 'In chat' : 'Off'}
                          </span>
                        </div>
                        <p className="text-[11px] text-text-muted leading-relaxed line-clamp-2">{agent.description}</p>
                        <div className="flex flex-wrap gap-2 mt-2 text-[10px] text-text-muted">
                          <span>{countLabel(agent.toolIds.length, 'tool', 'tools')}</span>
                          <span>{countLabel(agent.skillNames.length, 'skill', 'skills')}</span>
                          <span>{agent.writeAccess ? 'Read + write' : 'Read only'}</span>
                        </div>
                        {agent.issues.length > 0 ? (
                          <div className="mt-2 text-[10px]" style={{ color: 'var(--color-amber)' }}>
                            {agent.issues[0]?.message}
                          </div>
                        ) : null}
                      </div>
                    </button>
                    <div
                      className="flex items-center justify-between px-4 py-2 border-t border-border-subtle"
                      style={{ background: 'color-mix(in srgb, var(--color-elevated) 60%, transparent)' }}
                    >
                      <span className="text-[10px] text-text-muted">Mention with @{agent.name}</span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setSelectedName(agent.name)}
                          className="text-[11px] text-text-secondary hover:text-text cursor-pointer"
                        >
                          Edit
                        </button>
                        <button
                          onClick={async () => {
                            const target = {
                              name: agent.name,
                              scope: agent.scope,
                              directory: agent.directory || null,
                            } as const
                            const confirmation = await confirmAgentRemoval(target)
                            if (!confirmation) return
                            const ok = await window.openCowork.agents.remove(target, confirmation.token)
                            if (ok) refresh()
                          }}
                          className="text-[11px] text-text-muted hover:text-red cursor-pointer"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <RuntimeAgentsSection runtimeAgents={runtimeAgents} builtinDetails={builtinDetails} customAgents={agents} />
      </div>
    </div>
  )
}

function RuntimeAgentsSection({
  runtimeAgents,
  builtinDetails,
  customAgents,
}: {
  runtimeAgents: RuntimeAgentDescriptor[]
  builtinDetails: BuiltInAgentDetail[]
  customAgents: CustomAgentSummary[]
}) {
  // Anything OpenCode registered that Cowork didn't author. This catches
  // agents injected by an SDK plugin or downstream config layer that bypass
  // our catalog. Knowns come from `builtinDetails` + `customAgents`.
  const knownNames = useMemo(() => {
    const set = new Set<string>()
    for (const agent of builtinDetails) set.add(agent.name)
    for (const agent of customAgents) set.add(agent.name)
    return set
  }, [builtinDetails, customAgents])

  const unknown = useMemo(
    () => runtimeAgents.filter((agent) => !knownNames.has(agent.name)),
    [runtimeAgents, knownNames],
  )

  if (unknown.length === 0) return null

  return (
    <div className="mt-10">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-[14px] font-semibold text-text">Runtime-registered agents</h2>
          <p className="text-[12px] text-text-muted mt-1">
            Agents OpenCode has registered that aren't defined in this app's config. Usually comes from a downstream plugin or SDK extension.
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-[0.08em] text-text-muted">
          via client.app.agents()
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {unknown.map((agent) => (
          <div
            key={agent.name}
            className="flex items-start gap-3.5 p-4 rounded-xl border border-border-subtle bg-surface"
          >
            <div
              className="w-10 h-10 rounded-xl border flex items-center justify-center text-[14px] font-semibold shrink-0"
              style={agentIconStyle(agent.color || 'accent')}
            >
              {agent.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <span className="text-[13px] font-medium text-text">{agent.name}</span>
                {agent.mode && (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={statusPillStyle(agent.mode === 'primary' ? 'primary' : 'visible')}>
                    {agent.mode === 'primary' ? 'Top-level' : 'Sub-agent'}
                  </span>
                )}
                {agent.disabled && (
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={statusPillStyle('disabled')}>
                    Disabled
                  </span>
                )}
              </div>
              {agent.description && (
                <p className="text-[11px] text-text-muted leading-relaxed line-clamp-2">{agent.description}</p>
              )}
              <div className="flex flex-wrap gap-2 mt-2 text-[10px] text-text-muted">
                {agent.model && <span className="font-mono">{agent.model.split('/').pop()}</span>}
                <span>id: {agent.name}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
