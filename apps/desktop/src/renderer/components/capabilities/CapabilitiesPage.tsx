import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CapabilitySkill, CapabilitySkillBundle, CapabilityTool, CustomMcpConfig, CustomSkillConfig } from '@open-cowork/shared'
import { CustomMcpForm } from '../plugins/CustomMcpForm'
import { CustomSkillForm } from '../plugins/CustomSkillForm'
import { useSessionStore } from '../../stores/session'

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

const clampedCardDescriptionStyle = {
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical' as const,
  WebkitLineClamp: 5,
  overflow: 'hidden',
}

export function CapabilitiesPage({ onClose }: { onClose: () => void }) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId)
  const [tab, setTab] = useState<Tab>('tools')
  const [search, setSearch] = useState('')
  const [tools, setTools] = useState<CapabilityTool[]>([])
  const [skills, setSkills] = useState<CapabilitySkill[]>([])
  const [customMcps, setCustomMcps] = useState<CustomMcpConfig[]>([])
  const [customSkills, setCustomSkills] = useState<CustomSkillConfig[]>([])
  const [showAddMcp, setShowAddMcp] = useState(false)
  const [showAddSkill, setShowAddSkill] = useState(false)
  const [selection, setSelection] = useState<Selection>(null)
  const [runtimeTools, setRuntimeTools] = useState<RuntimeToolInfo[]>([])
  const [selectedToolDetail, setSelectedToolDetail] = useState<CapabilityTool | null>(null)
  const [selectedSkillBundle, setSelectedSkillBundle] = useState<CapabilitySkillBundle | null>(null)

  const toolOptions = useMemo(
    () => currentSessionId ? { sessionId: currentSessionId } : undefined,
    [currentSessionId],
  )

  const loadAll = () => {
    window.openCowork.capabilities.tools(toolOptions).then(setTools)
    window.openCowork.capabilities.skills().then(setSkills)
    window.openCowork.custom.listMcps().then(setCustomMcps)
    window.openCowork.custom.listSkills().then(setCustomSkills)
    window.openCowork.tools.list(toolOptions).then(setRuntimeTools).catch(() => setRuntimeTools([]))
  }

  useEffect(() => {
    loadAll()
    const unsubscribe = window.openCowork.on.runtimeReady(() => loadAll())
    return unsubscribe
  }, [currentSessionId])

  useEffect(() => {
    if (selection?.type !== 'tool') {
      setSelectedToolDetail(null)
      return
    }

    window.openCowork.capabilities.tool(selection.id, toolOptions).then(setSelectedToolDetail).catch(() => setSelectedToolDetail(null))
    window.openCowork.tools.list(toolOptions).then(setRuntimeTools).catch(() => setRuntimeTools([]))
  }, [selection, toolOptions])

  useEffect(() => {
    if (selection?.type !== 'skill') {
      setSelectedSkillBundle(null)
      return
    }

    window.openCowork.capabilities.skillBundle(selection.name).then(setSelectedSkillBundle).catch(() => setSelectedSkillBundle(null))
  }, [selection])

  const filteredTools = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return tools
    return tools.filter((tool) => (
      tool.name.toLowerCase().includes(query)
      || tool.description.toLowerCase().includes(query)
      || tool.agentNames.some((agent) => agent.toLowerCase().includes(query))
    ))
  }, [search, tools])

  const filteredSkills = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return skills
    return skills.filter((skill) => (
      skill.label.toLowerCase().includes(query)
      || skill.description.toLowerCase().includes(query)
      || skill.agentNames.some((agent) => agent.toLowerCase().includes(query))
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

  if (showAddMcp) {
    return <div className="flex-1 overflow-y-auto"><div className="max-w-[640px] mx-auto px-8 py-8"><CustomMcpForm onSave={() => { setShowAddMcp(false); loadAll() }} onCancel={() => setShowAddMcp(false)} /></div></div>
  }

  if (showAddSkill) {
    return <div className="flex-1 overflow-y-auto"><div className="max-w-[760px] mx-auto px-8 py-8"><CustomSkillForm onSave={() => { setShowAddSkill(false); loadAll() }} onCancel={() => setShowAddSkill(false)} /></div></div>
  }

  if (selectedTool) {
    const custom = customMcps.find((entry) => entry.name === selectedTool.id) || null
    const availableTools = mergedRuntimeToolset(selectedTool, runtimeTools)

    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[920px] mx-auto px-8 py-8">
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
              {custom ? (
                <button
                  onClick={async () => {
                    await window.openCowork.custom.removeMcp(custom.name)
                    setSelection(null)
                    loadAll()
                  }}
                  className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer border border-border-subtle text-text-muted hover:text-red"
                >
                  Remove tool
                </button>
              ) : null}
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
                        : 'Open Cowork config'}
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
        <div className="max-w-[920px] mx-auto px-8 py-8">
          <button onClick={() => setSelection(null)} className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary cursor-pointer mb-6">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="7,2 3,6 7,10" /></svg>
            Capabilities
          </button>

          <div className="rounded-2xl border border-border-subtle bg-surface p-5 mb-5">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={{ color: selectedSkill.source === 'custom' ? 'var(--color-amber)' : 'var(--color-accent)', background: selectedSkill.source === 'custom' ? 'color-mix(in srgb, var(--color-amber) 12%, transparent)' : 'color-mix(in srgb, var(--color-accent) 12%, transparent)' }}>
                    {selectedSkill.source === 'custom' ? 'Custom skill' : 'Built-in skill'}
                  </span>
                </div>
                <h1 className="text-[20px] font-semibold text-text mb-1">{selectedSkill.label}</h1>
                <p className="text-[13px] text-text-secondary leading-relaxed">{selectedSkill.description}</p>
              </div>
              {custom ? (
                <button
                  onClick={async () => {
                    await window.openCowork.custom.removeSkill(custom.name)
                    setSelection(null)
                    loadAll()
                  }}
                  className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer border border-border-subtle text-text-muted hover:text-red"
                >
                  Remove skill
                </button>
              ) : null}
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
                  <StatBox label="Source" value={selectedSkill.source === 'custom' ? 'Custom skill bundle' : 'Open Cowork bundled skill'} />
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
      <div className="max-w-[920px] mx-auto px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-[18px] font-semibold text-text">Capabilities</h1>
            <p className="text-[13px] text-text-secondary mt-1">
              Inspect the configured tools and skill bundles Open Cowork exposes, plus any custom additions you have installed.
            </p>
          </div>
          <button onClick={onClose} className="text-[12px] text-text-muted hover:text-text-secondary cursor-pointer">Back to chat</button>
        </div>

        <div className="flex items-center gap-3 mb-6">
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
          <div className="flex-1">
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={`Search ${tab}...`}
              className="w-full px-4 py-2.5 rounded-xl bg-elevated border border-border-subtle text-[13px] text-text placeholder:text-text-muted outline-none focus:border-border"
            />
          </div>
          {tab === 'tools' ? (
            <button onClick={() => setShowAddMcp(true)} className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-accent hover:bg-surface-hover cursor-pointer border border-border-subtle">
              Add tool
            </button>
          ) : (
            <button onClick={() => setShowAddSkill(true)} className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-accent hover:bg-surface-hover cursor-pointer border border-border-subtle">
              Add skill
            </button>
          )}
        </div>

        {tab === 'tools' ? (
          <div className="grid grid-cols-2 gap-3">
            {filteredTools.map((tool) => {
              const custom = customMcps.find((entry) => entry.name === tool.id)
              const availableCount = mergedRuntimeToolset(tool, runtimeTools).length
              return (
                <div
                  key={tool.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelection({ type: 'tool', id: tool.id })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setSelection({ type: 'tool', id: tool.id })
                    }
                  }}
                  className="rounded-xl border border-border-subtle bg-surface p-4 text-left hover:bg-surface-hover transition-colors cursor-pointer min-h-[168px] flex flex-col"
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-medium text-text">{tool.name}</span>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={{ color: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' }}>
                          {tool.origin === 'opencode' ? 'OpenCode' : tool.kind === 'built-in' ? 'Built-in' : 'MCP'}
                        </span>
                        {tool.source === 'custom' ? (
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={{ color: 'var(--color-amber)', background: 'color-mix(in srgb, var(--color-amber) 12%, transparent)' }}>
                            Custom
                          </span>
                        ) : null}
                      </div>
                      <p
                        className="text-[11px] text-text-muted leading-relaxed mt-1"
                        style={clampedCardDescriptionStyle}
                      >
                        {tool.description}
                      </p>
                    </div>
                    {custom ? (
                      <button
                        onClick={async (event) => {
                          event.stopPropagation()
                          await window.openCowork.custom.removeMcp(custom.name)
                          loadAll()
                        }}
                        className="text-[11px] text-text-muted hover:text-red cursor-pointer"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2 text-[10px] text-text-muted mt-auto pt-2">
                    <span>{availableCount} methods</span>
                    <span>{tool.agentNames.length} agents</span>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {filteredSkills.map((skill) => {
              const custom = customSkills.find((entry) => entry.name === skill.name)
              return (
                <div
                  key={skill.name}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelection({ type: 'skill', name: skill.name })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      setSelection({ type: 'skill', name: skill.name })
                    }
                  }}
                  className="rounded-xl border border-border-subtle bg-surface p-4 text-left hover:bg-surface-hover transition-colors cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[13px] font-medium text-text">{skill.label}</span>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={{
                          color: skill.source === 'custom' ? 'var(--color-amber)' : 'var(--color-accent)',
                          background: skill.source === 'custom'
                            ? 'color-mix(in srgb, var(--color-amber) 12%, transparent)'
                            : 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
                        }}>
                          {skill.source === 'custom' ? 'Custom' : 'Built-in'}
                        </span>
                      </div>
                      <p className="text-[11px] text-text-muted leading-relaxed mt-1">{skill.description}</p>
                    </div>
                    {custom ? (
                      <button
                        onClick={async (event) => {
                          event.stopPropagation()
                          await window.openCowork.custom.removeSkill(custom.name)
                          loadAll()
                        }}
                        className="text-[11px] text-text-muted hover:text-red cursor-pointer"
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2 text-[10px] text-text-muted">
                    <span>{(skill.toolIds || []).length} tools</span>
                    <span>{skill.agentNames.length} agents</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
