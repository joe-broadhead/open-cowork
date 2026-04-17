import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CustomAgentConfig } from '@open-cowork/shared'
import type { CapabilitySkill, CapabilitySkillBundle, CapabilityTool, CustomMcpConfig, CustomSkillConfig } from '@open-cowork/shared'
import { CustomMcpForm } from '../plugins/CustomMcpForm'
import { CustomSkillForm } from '../plugins/CustomSkillForm'
import { useSessionStore } from '../../stores/session'
import { confirmMcpRemoval, confirmSkillRemoval } from '../../helpers/destructive-actions'
import { SkillSelectionCard, ToolSelectionCard } from './CapabilitySelectionCard'
import { getBrandName } from '../../helpers/brand'

type Tab = 'tools' | 'skills'
type Selection =
  | { type: 'tool'; id: string }
  | { type: 'skill'; name: string }
  | null

interface RuntimeToolInfo {
  id?: string
  name?: string
  description?: string
}

function stripFrontmatter(content: string) {
  return content.replace(/^---[\s\S]*?---\n?/, '').trim()
}

function prettyKind(tool: CapabilityTool) {
  if (tool.origin === 'opencode') return 'OpenCode tool'
  if (tool.source === 'custom') return 'Custom MCP'
  return tool.kind === 'built-in' ? 'Built-in tool' : 'MCP tool'
}

function prettySkillKind(skill: CapabilitySkill) {
  if (skill.source === 'custom') return 'Custom skill'
  return 'Built-in skill'
}

function prettySkillSource(skill: CapabilitySkill) {
  if (skill.origin === 'open-cowork') return `${getBrandName()} bundled skill`
  if (skill.scope === 'project') return 'Project skill'
  if (skill.scope === 'machine') return 'Machine skill'
  return 'Skill bundle'
}

function toolPrefixes(tool: CapabilityTool) {
  const prefixes = new Set<string>()

  if (tool.namespace) {
    prefixes.add(`mcp__${tool.namespace}__`)
    prefixes.add(`${tool.namespace}_`)
  }

  prefixes.add(`mcp__${tool.id}__`)
  prefixes.add(`${tool.id}_`)

  return Array.from(prefixes)
}

function safeText(value: string | null | undefined) {
  return typeof value === 'string' ? value : ''
}

function mergedRuntimeToolset(tool: CapabilityTool, runtimeTools: RuntimeToolInfo[]) {
  const prefixes = toolPrefixes(tool)
  const discovered = runtimeTools.filter((entry) => {
    const id = entry.id || entry.name || ''
    return id === tool.id || prefixes.some((prefix) => id.startsWith(prefix))
  })

  if (discovered.length > 0) {
    return discovered.map((entry) => ({
      id: entry.id || entry.name || 'unknown',
      description: entry.description || 'No description available for this MCP method.',
    }))
  }

  return tool.availableTools || []
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-elevated px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.08em] text-text-muted mb-1">{label}</div>
      <div className="text-[12px] text-text-secondary break-all">{value}</div>
    </div>
  )
}

function EmptyGrid({ message }: { message: string }) {
  return (
    <div className="text-[12px] text-text-muted py-6 text-center rounded-xl border border-border-subtle border-dashed">
      {message}
    </div>
  )
}

function suggestAgentId(value: string) {
  return `${value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'new'}-agent`
}

function buildAgentSeedFromTool(tool: CapabilityTool): Partial<CustomAgentConfig> {
  return {
    name: suggestAgentId(tool.id),
    description: tool.description,
    toolIds: [tool.id],
    instructions: '',
    skillNames: [],
    enabled: true,
    color: 'accent',
  }
}

function buildAgentSeedFromSkill(skill: CapabilitySkill): Partial<CustomAgentConfig> {
  return {
    name: suggestAgentId(skill.name),
    description: skill.description,
    toolIds: [...(skill.toolIds || [])],
    instructions: '',
    skillNames: [skill.name],
    enabled: true,
    color: 'accent',
  }
}

export function CapabilitiesPage({
  onClose,
  onCreateAgent,
}: {
  onClose: () => void
  onCreateAgent: (seed: Partial<CustomAgentConfig>) => void
}) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const sessions = useSessionStore((state) => state.sessions)
  const [tab, setTab] = useState<Tab>('tools')
  const [search, setSearch] = useState('')
  const [tools, setTools] = useState<CapabilityTool[]>([])
  const [skills, setSkills] = useState<CapabilitySkill[]>([])
  const [customMcps, setCustomMcps] = useState<CustomMcpConfig[]>([])
  const [customSkills, setCustomSkills] = useState<CustomSkillConfig[]>([])
  // Each pair drives one form surface. `null` hides it; `'new'` opens a
  // blank form; a CustomMcpConfig / CustomSkillConfig opens the form in
  // edit mode seeded with that bundle's current state.
  const [mcpForm, setMcpForm] = useState<'new' | CustomMcpConfig | null>(null)
  const [skillForm, setSkillForm] = useState<'new' | CustomSkillConfig | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [runtimeTools, setRuntimeTools] = useState<RuntimeToolInfo[]>([])
  const [selectedToolDetail, setSelectedToolDetail] = useState<CapabilityTool | null>(null)
  const [selectedSkillBundle, setSelectedSkillBundle] = useState<CapabilitySkillBundle | null>(null)

  const currentProjectDirectory = useMemo(
    () => sessions.find((session) => session.id === currentSessionId)?.directory || null,
    [currentSessionId, sessions],
  )
  const toolOptions = useMemo(
    () => currentSessionId ? { sessionId: currentSessionId } : undefined,
    [currentSessionId],
  )
  const contextOptions = useMemo(
    () => currentProjectDirectory ? { directory: currentProjectDirectory } : undefined,
    [currentProjectDirectory],
  )

  const loadAll = () => {
    window.coworkApi.capabilities.tools(toolOptions).then(setTools)
    window.coworkApi.capabilities.skills(contextOptions).then(setSkills)
    window.coworkApi.custom.listMcps(contextOptions).then(setCustomMcps)
    window.coworkApi.custom.listSkills(contextOptions).then(setCustomSkills)
    window.coworkApi.tools.list(toolOptions).then(setRuntimeTools).catch(() => setRuntimeTools([]))
  }

  useEffect(() => {
    loadAll()
    const unsubscribe = window.coworkApi.on.runtimeReady(() => loadAll())
    return unsubscribe
  }, [currentSessionId, currentProjectDirectory])

  useEffect(() => {
    if (selection?.type !== 'tool') {
      setSelectedToolDetail(null)
      return
    }

    window.coworkApi.capabilities.tool(selection.id, toolOptions).then(setSelectedToolDetail).catch(() => setSelectedToolDetail(null))
    window.coworkApi.tools.list(toolOptions).then(setRuntimeTools).catch(() => setRuntimeTools([]))
  }, [selection, toolOptions])

  useEffect(() => {
    if (selection?.type !== 'skill') {
      setSelectedSkillBundle(null)
      return
    }

    window.coworkApi.capabilities.skillBundle(selection.name, contextOptions).then(setSelectedSkillBundle).catch(() => setSelectedSkillBundle(null))
  }, [selection, contextOptions])

  const filteredTools = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return tools
    return tools.filter((tool) => (
      safeText(tool.name).toLowerCase().includes(query)
      || safeText(tool.description).toLowerCase().includes(query)
      || (tool.agentNames || []).some((agent) => safeText(agent).toLowerCase().includes(query))
    ))
  }, [search, tools])

  const filteredSkills = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return skills
    return skills.filter((skill) => (
      safeText(skill.label).toLowerCase().includes(query)
      || safeText(skill.description).toLowerCase().includes(query)
      || (skill.agentNames || []).some((agent) => safeText(agent).toLowerCase().includes(query))
    ))
  }, [search, skills])

  const selectedTool = selection?.type === 'tool'
    ? selectedToolDetail || tools.find((tool) => tool.id === selection.id) || null
    : null
  const selectedSkill = selection?.type === 'skill'
    ? skills.find((skill) => skill.name === selection.name) || null
    : null
  const toolNameById = useMemo(
    () => new Map(tools.map((tool) => [tool.id, tool.name])),
    [tools],
  )

  if (mcpForm) {
    return (
      <CustomMcpForm
        projectDirectory={currentProjectDirectory}
        existing={mcpForm === 'new' ? null : mcpForm}
        onSave={() => { setMcpForm(null); loadAll() }}
        onCancel={() => setMcpForm(null)}
      />
    )
  }

  if (skillForm) {
    return (
      <CustomSkillForm
        projectDirectory={currentProjectDirectory}
        existing={skillForm === 'new' ? null : skillForm}
        onSave={() => { setSkillForm(null); loadAll() }}
        onCancel={() => setSkillForm(null)}
      />
    )
  }

  if (selectedTool) {
    const custom = customMcps.find((entry) => entry.name === selectedTool.id) || null
    const availableTools = mergedRuntimeToolset(selectedTool, runtimeTools)

    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1200px] mx-auto px-8 py-8">
          <button onClick={() => setSelection(null)} className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary cursor-pointer mb-6">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="7,2 3,6 7,10" /></svg>
            Capabilities
          </button>

          <div className="rounded-2xl border border-border-subtle bg-surface p-5 mb-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={{ color: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' }}>
                    {prettyKind(selectedTool)}
                  </span>
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={{
                    color: selectedTool.source === 'custom' ? 'var(--color-amber)' : 'var(--color-green)',
                    background: selectedTool.source === 'custom'
                      ? 'color-mix(in srgb, var(--color-amber) 12%, transparent)'
                      : 'color-mix(in srgb, var(--color-green) 12%, transparent)',
                  }}>
                    {selectedTool.source === 'custom' ? 'Installed' : 'Built-in'}
                  </span>
                </div>
                <h1 className="text-[20px] font-semibold text-text mb-1">{selectedTool.name}</h1>
                <p className="text-[13px] text-text-secondary leading-relaxed">{selectedTool.description}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => onCreateAgent(buildAgentSeedFromTool(selectedTool))}
                  className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer border border-border-subtle text-accent hover:bg-surface-hover"
                >
                  Create agent
                </button>
                {custom ? (
                  <>
                    <button
                      onClick={() => setMcpForm(custom)}
                      className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer border border-border-subtle text-accent hover:bg-surface-hover"
                    >
                      Edit tool
                    </button>
                    <button
                      onClick={async () => {
                        const target = {
                          name: custom.name,
                          scope: custom.scope,
                          directory: custom.directory || null,
                        } as const
                        const confirmation = await confirmMcpRemoval(target)
                        if (!confirmation) return
                        const ok = await window.coworkApi.custom.removeMcp(target, confirmation.token)
                        if (!ok) return
                        setSelection(null)
                        loadAll()
                      }}
                      className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer border border-border-subtle text-text-muted hover:text-red"
                    >
                      Remove tool
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5">
            <div className="flex flex-col gap-5">
              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">Details</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <StatBox label="Identifier" value={selectedTool.id} />
                  <StatBox
                    label="Source"
                    value={selectedTool.origin === 'opencode'
                      ? 'OpenCode runtime'
                      : selectedTool.source === 'custom'
                        ? (custom?.label?.trim() || custom?.name || 'Custom MCP')
                        : `${getBrandName()} config`}
                  />
                  <StatBox label="Runtime namespace" value={selectedTool.namespace || selectedTool.id} />
                  <StatBox label="Used by agents" value={selectedTool.agentNames.length > 0 ? selectedTool.agentNames.join(', ') : 'No agents yet'} />
                </div>
              </div>

              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                    {selectedTool.origin === 'opencode' ? 'Runtime metadata' : 'Available methods'}
                  </div>
                  <span className="text-[10px] text-text-muted">
                    {selectedTool.origin === 'opencode' ? `${availableTools.length} entries` : `${availableTools.length} methods`}
                  </span>
                </div>
                {availableTools.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    {availableTools.map((entry) => (
                      <div key={entry.id} className="rounded-xl border border-border-subtle bg-elevated px-3 py-3">
                        <div className="text-[12px] font-medium text-text">{entry.id}</div>
                        <div className="text-[11px] text-text-muted mt-1 leading-relaxed">{entry.description}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-text-muted">
                    {selectedTool.origin === 'opencode'
                      ? 'No runtime metadata is available for this tool yet.'
                      : 'No MCP methods have been discovered for this tool yet.'}
                  </div>
                )}
              </div>

              {custom ? (
                <div className="rounded-xl border border-border-subtle bg-surface p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">Connection</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <StatBox label="Type" value={custom.type === 'stdio' ? 'Local stdio MCP' : 'Remote HTTP / SSE MCP'} />
                    {custom.type === 'stdio' ? (
                      <StatBox label="Command" value={custom.command || 'Not set'} />
                    ) : (
                      <StatBox label="Endpoint" value={custom.url || 'Not set'} />
                    )}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="flex flex-col gap-5">
              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">Linked agents</div>
                {selectedTool.agentNames.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedTool.agentNames.map((agentName) => (
                      <span key={agentName} className="px-2 py-1 rounded-md border border-border-subtle text-[10px] text-text-secondary">
                        {agentName}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-text-muted">No built-in or custom agents use this tool yet.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (selectedSkill) {
    const custom = customSkills.find((entry) => entry.name === selectedSkill.name) || null
    const bundle = selectedSkillBundle || null
    const linkedToolNames = (selectedSkill.toolIds || []).map((toolId) => toolNameById.get(toolId) || toolId)

    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1200px] mx-auto px-8 py-8">
          <button onClick={() => setSelection(null)} className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary cursor-pointer mb-6">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="7,2 3,6 7,10" /></svg>
            Capabilities
          </button>

          <div className="rounded-2xl border border-border-subtle bg-surface p-5 mb-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={{
                    color: selectedSkill.source === 'custom'
                      ? 'var(--color-amber)'
                      : 'var(--color-accent)',
                    background: selectedSkill.source === 'custom'
                      ? 'color-mix(in srgb, var(--color-amber) 12%, transparent)'
                      : 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
                  }}>
                    {prettySkillKind(selectedSkill)}
                  </span>
                </div>
                <h1 className="text-[20px] font-semibold text-text mb-1">{selectedSkill.label}</h1>
                <p className="text-[13px] text-text-secondary leading-relaxed">{selectedSkill.description}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => onCreateAgent(buildAgentSeedFromSkill(selectedSkill))}
                  className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer border border-border-subtle text-accent hover:bg-surface-hover"
                >
                  Create agent
                </button>
                {custom ? (
                  <>
                    <button
                      onClick={() => setSkillForm(custom)}
                      className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer border border-border-subtle text-accent hover:bg-surface-hover"
                    >
                      Edit skill
                    </button>
                    <button
                      onClick={async () => {
                        const target = {
                          name: custom.name,
                          scope: custom.scope,
                          directory: custom.directory || null,
                        } as const
                        const confirmation = await confirmSkillRemoval(target)
                        if (!confirmation) return
                        const ok = await window.coworkApi.custom.removeSkill(target, confirmation.token)
                        if (!ok) return
                        setSelection(null)
                        loadAll()
                      }}
                      className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer border border-border-subtle text-text-muted hover:text-red"
                    >
                      Remove skill
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5">
            <div className="rounded-xl border border-border-subtle bg-surface p-4">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">Skill Content</div>
              {bundle?.content ? (
                <div className="prose prose-invert max-w-none text-[12px] text-text-secondary leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {stripFrontmatter(bundle.content)}
                  </ReactMarkdown>
                </div>
              ) : (
                <div className="text-[12px] text-text-muted">No skill bundle content is available yet.</div>
              )}
            </div>

            <div className="flex flex-col gap-5">
              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">Details</div>
                <div className="flex flex-col gap-3">
                  <StatBox label="Identifier" value={selectedSkill.name} />
                  <StatBox label="Source" value={prettySkillSource(selectedSkill)} />
                  {selectedSkill.location ? (
                    <StatBox label="Location" value={selectedSkill.location} />
                  ) : null}
                </div>
              </div>

              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">Linked tools</div>
                {linkedToolNames.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {linkedToolNames.map((toolName) => (
                      <span key={toolName} className="px-2 py-1 rounded-md border border-border-subtle text-[10px] text-text-secondary">
                        {toolName}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-text-muted">This skill is not tied to a specific tool.</div>
                )}
              </div>

              <div className="rounded-xl border border-border-subtle bg-surface p-4">
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-3">Used by agents</div>
                {selectedSkill.agentNames.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {selectedSkill.agentNames.map((agentName) => (
                      <span key={agentName} className="px-2 py-1 rounded-md border border-border-subtle text-[10px] text-text-secondary">
                        {agentName}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="text-[12px] text-text-muted">No built-in or custom agents use this skill yet.</div>
                )}
              </div>

              {bundle?.files.length ? (
                <div className="rounded-xl border border-border-subtle bg-surface p-4">
                  <div className="flex items-center justify-between gap-3 mb-3">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-muted">Bundle files</div>
                    <span className="text-[10px] text-text-muted">{bundle.files.length} files</span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {bundle.files.map((file) => (
                      <div key={file.path} className="rounded-xl border border-border-subtle bg-elevated px-3 py-3">
                        <div className="text-[12px] font-medium text-text">{file.path}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1200px] mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[18px] font-semibold text-text">Capabilities</h1>
            <p className="text-[13px] text-text-secondary mt-1">
              Inspect the tools and skill bundles available in the current OpenCode context, including bundled, machine, project, and custom additions.
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
              placeholder={`Search ${tab}, descriptions, or agents…`}
              className="w-full px-4 py-2.5 rounded-xl bg-elevated border border-border-subtle text-[13px] text-text placeholder:text-text-muted outline-none focus:border-border"
            />
          </div>
          <div className="flex rounded-lg border border-border-subtle overflow-hidden">
            {(['tools', 'skills'] as const).map((value) => (
              <button
                key={value}
                onClick={() => setTab(value)}
                className={`px-3 py-1.5 text-[12px] font-medium cursor-pointer transition-colors capitalize ${tab === value ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text-secondary'}`}
              >
                {value}
              </button>
            ))}
          </div>
          <button
            onClick={() => tab === 'tools' ? setMcpForm('new') : setSkillForm('new')}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-medium hover:opacity-90 cursor-pointer"
            style={{ background: 'var(--color-accent)', color: 'var(--color-accent-foreground)' }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="5" y1="1.5" x2="5" y2="8.5" /><line x1="1.5" y1="5" x2="8.5" y2="5" />
            </svg>
            {tab === 'tools' ? 'Add tool' : 'Add skill'}
          </button>
        </div>

        {tab === 'tools' ? (
          filteredTools.length === 0 ? (
            <EmptyGrid message={tools.length === 0
              ? 'No tools discovered yet. Add a custom MCP to extend the runtime.'
              : 'No tools matched your search.'} />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {filteredTools.map((tool) => {
                const custom = customMcps.find((entry) => entry.name === tool.id)
                const availableCount = mergedRuntimeToolset(tool, runtimeTools).length
                return (
                  <ToolSelectionCard
                    key={tool.id}
                    tool={tool}
                    methodsCount={availableCount}
                    isCustom={Boolean(custom)}
                    onOpen={() => setSelection({ type: 'tool', id: tool.id })}
                    onRemove={custom
                      ? async () => {
                          const target = {
                            name: custom.name,
                            scope: custom.scope,
                            directory: custom.directory || null,
                          } as const
                          const confirmation = await confirmMcpRemoval(target)
                          if (!confirmation) return
                          const ok = await window.coworkApi.custom.removeMcp(target, confirmation.token)
                          if (!ok) return
                          loadAll()
                        }
                      : undefined}
                  />
                )
              })}
            </div>
          )
        ) : (
          filteredSkills.length === 0 ? (
            <EmptyGrid message={skills.length === 0
              ? 'No skills discovered yet. Add a custom skill bundle to extend agents.'
              : 'No skills matched your search.'} />
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {filteredSkills.map((skill) => {
                const custom = customSkills.find((entry) => entry.name === skill.name)
                return (
                  <SkillSelectionCard
                    key={skill.name}
                    skill={skill}
                    isCustom={Boolean(custom)}
                    onOpen={() => setSelection({ type: 'skill', name: skill.name })}
                    onRemove={custom
                      ? async () => {
                          const target = {
                            name: custom.name,
                            scope: custom.scope,
                            directory: custom.directory || null,
                          } as const
                          const confirmation = await confirmSkillRemoval(target)
                          if (!confirmation) return
                          const ok = await window.coworkApi.custom.removeSkill(target, confirmation.token)
                          if (!ok) return
                          loadAll()
                        }
                      : undefined}
                  />
                )
              })}
            </div>
          )
        )}
      </div>
    </div>
  )
}
