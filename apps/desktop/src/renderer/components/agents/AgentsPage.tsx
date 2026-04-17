import { useEffect, useMemo, useState } from 'react'
import type {
  AgentCatalog,
  BuiltInAgentDetail,
  CustomAgentConfig,
  CustomAgentSummary,
  RuntimeAgentDescriptor,
} from '@open-cowork/shared'
import { AgentBuilderPage } from './AgentBuilderPage'
import { AgentTemplatePicker } from './AgentTemplatePicker'
import {
  BuiltInSelectionCard,
  CustomSelectionCard,
  RuntimeSelectionCard,
} from './AgentSelectionCard'
import { confirmAgentRemoval } from '../../helpers/destructive-actions'
import { useSessionStore } from '../../stores/session'

type Filter = 'all' | 'custom' | 'builtin' | 'runtime'

// Entry to the builder. The list grid shows every agent (built-in, custom,
// runtime) as a portrait-style card. Clicking one opens the builder.
// Built-in / runtime agents open read-only; customs are full edit.

type SelectedEntry =
  | { kind: 'custom'; name: string }
  | { kind: 'builtin'; name: string }
  | { kind: 'runtime'; name: string }

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
  const [customs, setCustoms] = useState<CustomAgentSummary[]>([])
  const [catalog, setCatalog] = useState<AgentCatalog | null>(null)
  const [builtinDetails, setBuiltinDetails] = useState<BuiltInAgentDetail[]>([])
  const [runtimeAgents, setRuntimeAgents] = useState<RuntimeAgentDescriptor[]>([])
  const [selected, setSelected] = useState<SelectedEntry | null>(null)
  const [creating, setCreating] = useState(false)
  const [creatingSeed, setCreatingSeed] = useState<Partial<CustomAgentConfig> | null>(null)
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
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
    window.openCowork.agents.list(contextOptions).then(setCustoms)
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
    // External seeders (command palette) bypass the template picker —
    // the draft they hand us is the intent.
    setSelected(null)
    setCreatingSeed(initialDraft)
    setCreating(true)
    setTemplatePickerOpen(false)
  }, [initialDraft])

  // Any runtime-registered agent that isn't also a built-in or a Cowork
  // custom — these are SDK plugin injections; we still surface them.
  const runtimeUnknown = useMemo(() => {
    const known = new Set<string>()
    for (const agent of builtinDetails) known.add(agent.name)
    for (const agent of customs) known.add(agent.name)
    return runtimeAgents.filter((agent) => !known.has(agent.name))
  }, [builtinDetails, customs, runtimeAgents])

  const filteredCustoms = useMemo(() => (
    customs.filter((agent) => matchesSearch(search, agent.name, agent.description, agent.instructions, ...agent.skillNames, ...agent.toolIds))
  ), [customs, search])

  const filteredBuiltIns = useMemo(() => (
    builtinDetails.filter((agent) => matchesSearch(
      search, agent.label, agent.name, agent.description, agent.instructions,
      ...agent.skills, ...agent.toolAccess,
    ))
  ), [builtinDetails, search])

  const filteredRuntime = useMemo(() => (
    runtimeUnknown.filter((agent) => matchesSearch(search, agent.name, agent.description || ''))
  ), [runtimeUnknown, search])

  const selectedCustom = useMemo(
    () => selected?.kind === 'custom'
      ? customs.find((entry) => entry.name === selected.name) || null
      : null,
    [selected, customs],
  )

  const selectedBuiltIn = useMemo(
    () => selected?.kind === 'builtin'
      ? builtinDetails.find((entry) => entry.name === selected.name) || null
      : null,
    [selected, builtinDetails],
  )

  const selectedRuntime = useMemo(
    () => selected?.kind === 'runtime'
      ? runtimeAgents.find((entry) => entry.name === selected.name) || null
      : null,
    [selected, runtimeAgents],
  )

  // Route into the builder
  if (catalog && (creating || selectedCustom || selectedBuiltIn || selectedRuntime)) {
    return (
      <AgentBuilderPage
        target={
          selectedCustom
            ? { kind: 'custom', agent: selectedCustom }
            : selectedBuiltIn
              ? { kind: 'builtin', agent: selectedBuiltIn }
              : selectedRuntime
                ? { kind: 'runtime', agent: selectedRuntime }
                : { kind: 'new', seed: creatingSeed }
        }
        catalog={catalog}
        existingCustomNames={customs.map((entry) => entry.name)}
        projectDirectory={projectDirectory}
        onCancel={() => {
          setSelected(null)
          setCreating(false)
          setCreatingSeed(null)
          onClearDraft?.()
        }}
        onSaved={() => {
          setSelected(null)
          setCreating(false)
          setCreatingSeed(null)
          onClearDraft?.()
          refresh()
        }}
        onOpenCapabilities={onOpenCapabilities}
      />
    )
  }

  const showCustoms = filter === 'all' || filter === 'custom'
  const showBuiltIns = filter === 'all' || filter === 'builtin'
  const showRuntime = (filter === 'all' || filter === 'runtime') && runtimeUnknown.length > 0

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1200px] mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[18px] font-semibold text-text">Agents</h1>
            <p className="text-[13px] text-text-secondary mt-1">
              Compose specialists from skills, tools, and instructions. Click any card to open it in the builder.
            </p>
          </div>
          <button onClick={onClose} className="text-[12px] text-text-muted hover:text-text-secondary cursor-pointer">
            Back to chat
          </button>
        </div>

        <div className="flex items-center gap-3 mb-6">
          <div className="flex-1">
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search agents, skills, tools, or instructions…"
              className="w-full px-4 py-2.5 rounded-xl bg-elevated border border-border-subtle text-[13px] text-text placeholder:text-text-muted outline-none focus:border-border"
            />
          </div>
          <div className="flex rounded-lg border border-border-subtle overflow-hidden">
            {(['all', 'custom', 'builtin', 'runtime'] as const).map((value) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={`px-3 py-1.5 text-[12px] font-medium cursor-pointer transition-colors capitalize ${filter === value ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text-secondary'}`}
              >
                {value === 'builtin' ? 'Built-in' : value}
              </button>
            ))}
          </div>
          <button
            onClick={() => {
              setSelected(null)
              setTemplatePickerOpen(true)
              onClearDraft?.()
            }}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium hover:opacity-90 cursor-pointer"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="5" y1="1.5" x2="5" y2="8.5" /><line x1="1.5" y1="5" x2="8.5" y2="5" />
            </svg>
            New agent
          </button>
        </div>

        {showCustoms && (
          <ListSection
            label="Custom agents"
            sublabel="Built by you — edit, enable, or delete from the card."
            emptyState={customs.length === 0
              ? 'No custom agents yet. Click “New agent” to build your first specialist.'
              : 'No custom agents matched your search.'}
            empty={filteredCustoms.length === 0}
          >
            {filteredCustoms.map((agent) => (
              <CustomSelectionCard
                key={agent.name}
                agent={agent}
                catalog={catalog}
                onOpen={() => setSelected({ kind: 'custom', name: agent.name })}
                onDelete={async () => {
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
              />
            ))}
          </ListSection>
        )}

        {showBuiltIns && (
          <ListSection
            label="Built-in agents"
            sublabel="OpenCode's built-ins plus the focused agents Cowork ships on top."
            emptyState="No built-ins matched your search."
            empty={filteredBuiltIns.length === 0}
          >
            {filteredBuiltIns.map((agent) => (
              <BuiltInSelectionCard
                key={agent.name}
                agent={agent}
                onOpen={() => setSelected({ kind: 'builtin', name: agent.name })}
              />
            ))}
          </ListSection>
        )}

        {showRuntime && (
          <ListSection
            label="Runtime-registered agents"
            sublabel="Agents registered by an SDK plugin that bypass Cowork's catalog."
            emptyState="No runtime agents matched your search."
            empty={filteredRuntime.length === 0}
          >
            {filteredRuntime.map((agent) => (
              <RuntimeSelectionCard
                key={agent.name}
                agent={agent}
                onOpen={() => setSelected({ kind: 'runtime', name: agent.name })}
              />
            ))}
          </ListSection>
        )}
      </div>

      {templatePickerOpen && catalog && (
        <AgentTemplatePicker
          catalog={catalog}
          onPick={(seed) => {
            setTemplatePickerOpen(false)
            setCreatingSeed(seed)
            setCreating(true)
          }}
          onCancel={() => setTemplatePickerOpen(false)}
        />
      )}
    </div>
  )
}

function matchesSearch(search: string, ...values: Array<string | undefined | null>) {
  const query = search.trim().toLowerCase()
  if (!query) return true
  return values.some((value) => value?.toLowerCase().includes(query))
}

function ListSection({
  label,
  sublabel,
  empty,
  emptyState,
  children,
}: {
  label: string
  sublabel: string
  empty: boolean
  emptyState: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-8">
      <div className="mb-3">
        <h2 className="text-[14px] font-semibold text-text">{label}</h2>
        <p className="text-[12px] text-text-muted mt-0.5">{sublabel}</p>
      </div>
      {empty ? (
        <div className="text-[12px] text-text-muted py-6 text-center rounded-xl border border-border-subtle border-dashed">
          {emptyState}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">{children}</div>
      )}
    </section>
  )
}

