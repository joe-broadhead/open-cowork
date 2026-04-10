import { useState, useEffect } from 'react'
import type { Plugin, CustomMcpConfig, CustomSkillConfig } from '@cowork/shared'
import { PluginDetail } from './PluginDetail'
import { PluginIcon } from './PluginIcon'
import { CustomMcpForm } from './CustomMcpForm'
import { CustomSkillForm } from './CustomSkillForm'

export function PluginsPage({ onClose }: { onClose: () => void }) {
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'installed' | 'custom'>('all')
  const [search, setSearch] = useState('')
  const [showAddMcp, setShowAddMcp] = useState(false)
  const [showAddSkill, setShowAddSkill] = useState(false)
  const [customMcps, setCustomMcps] = useState<CustomMcpConfig[]>([])
  const [customSkills, setCustomSkills] = useState<CustomSkillConfig[]>([])

  const loadAll = () => {
    window.cowork.plugins.list().then(setPlugins)
    window.cowork.custom.listMcps().then(setCustomMcps)
    window.cowork.custom.listSkills().then(setCustomSkills)
  }

  useEffect(() => { loadAll() }, [])

  const refresh = async () => { loadAll() }

  const filtered = plugins.filter((p) => {
    if (filter === 'installed' && !p.installed) return false
    if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && !p.description.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const selected = selectedId ? plugins.find((p) => p.id === selectedId) : null
  if (selected) return <PluginDetail plugin={selected} onBack={() => setSelectedId(null)} onRefresh={refresh} />
  if (showAddMcp) return <div className="flex-1 overflow-y-auto"><div className="max-w-[640px] mx-auto px-8 py-8"><CustomMcpForm onSave={() => { setShowAddMcp(false); loadAll() }} onCancel={() => setShowAddMcp(false)} /></div></div>
  if (showAddSkill) return <div className="flex-1 overflow-y-auto"><div className="max-w-[640px] mx-auto px-8 py-8"><CustomSkillForm onSave={() => { setShowAddSkill(false); loadAll() }} onCancel={() => setShowAddSkill(false)} /></div></div>

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[800px] mx-auto px-8 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-[18px] font-semibold text-text">Plugins</h1>
          <button onClick={onClose} className="text-[12px] text-text-muted hover:text-text-secondary cursor-pointer">Back to chat</button>
        </div>

        {/* Search + filter */}
        <div className="flex items-center gap-3 mb-6">
          <div className="flex-1">
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search plugins..."
              className="w-full px-4 py-2.5 rounded-xl bg-elevated border border-border-subtle text-[13px] text-text placeholder:text-text-muted outline-none focus:border-border" />
          </div>
          <div className="flex rounded-lg border border-border-subtle overflow-hidden">
            {(['all', 'installed', 'custom'] as const).map(f => (
              <button key={f} onClick={() => setFilter(f)} className={`px-3 py-1.5 text-[12px] font-medium cursor-pointer transition-colors capitalize ${filter === f ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text-secondary'}`}>
                {f}
              </button>
            ))}
          </div>
        </div>

        {/* Built-in plugins */}
        {filter !== 'custom' && (
          <>
            <div className="grid grid-cols-2 gap-3 mb-8">
              {filtered.map((plugin) => (
                <button key={plugin.id} onClick={() => setSelectedId(plugin.id)}
                  className="flex items-start gap-3.5 p-4 rounded-xl border border-border-subtle bg-surface hover:bg-surface-hover transition-colors cursor-pointer text-left">
                  <PluginIcon icon={plugin.icon} size={40} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[13px] font-medium text-text">{plugin.name}</span>
                      {plugin.installed && <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={{ color: 'var(--color-green)', background: 'color-mix(in srgb, var(--color-green) 12%, transparent)' }}>Active</span>}
                    </div>
                    <p className="text-[11px] text-text-muted leading-relaxed line-clamp-2">{plugin.description}</p>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {/* Custom MCPs & Skills */}
        {(filter === 'all' || filter === 'custom') && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[14px] font-semibold text-text">Custom MCPs</h2>
              <button onClick={() => setShowAddMcp(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-accent hover:bg-surface-hover cursor-pointer border border-border-subtle">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="5" y1="1.5" x2="5" y2="8.5" /><line x1="1.5" y1="5" x2="8.5" y2="5" /></svg>
                Add MCP
              </button>
            </div>
            {customMcps.length === 0 ? (
              <p className="text-[12px] text-text-muted mb-6 py-4 text-center rounded-xl border border-border-subtle border-dashed">No custom MCPs added yet. Add a GitHub, Jira, Slack, or any MCP server.</p>
            ) : (
              <div className="flex flex-col gap-2 mb-6">
                {customMcps.map(mcp => (
                  <div key={mcp.name} className="flex items-center justify-between p-3 rounded-xl border border-border-subtle">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-elevated border border-border flex items-center justify-center text-[11px] font-mono text-text-muted">{mcp.type === 'stdio' ? '>' : '~'}</div>
                      <div>
                        <div className="text-[13px] font-medium text-text">{mcp.name}</div>
                        <div className="text-[11px] text-text-muted">{mcp.type === 'stdio' ? `${mcp.command} ${(mcp.args || []).join(' ')}` : mcp.url}</div>
                      </div>
                    </div>
                    <button onClick={async () => { await window.cowork.custom.removeMcp(mcp.name); loadAll() }}
                      className="text-[11px] text-text-muted hover:text-red cursor-pointer px-2 py-1 rounded">Remove</button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[14px] font-semibold text-text">Custom Skills</h2>
              <button onClick={() => setShowAddSkill(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-accent hover:bg-surface-hover cursor-pointer border border-border-subtle">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="5" y1="1.5" x2="5" y2="8.5" /><line x1="1.5" y1="5" x2="8.5" y2="5" /></svg>
                Add Skill
              </button>
            </div>
            {customSkills.length === 0 ? (
              <p className="text-[12px] text-text-muted py-4 text-center rounded-xl border border-border-subtle border-dashed">No custom skills added yet. Add a skill to teach the agent your workflows.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {customSkills.map(skill => (
                  <div key={skill.name} className="flex items-center justify-between p-3 rounded-xl border border-border-subtle">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-elevated border border-border flex items-center justify-center">
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--color-amber)" strokeWidth="1.3"><path d="M6 1.5L7.5 4.5L10.5 5L8.25 7.25L8.75 10.5L6 9L3.25 10.5L3.75 7.25L1.5 5L4.5 4.5L6 1.5Z" /></svg>
                      </div>
                      <div>
                        <div className="text-[13px] font-medium text-text">{skill.name}</div>
                        <div className="text-[11px] text-text-muted">{skill.content.slice(0, 80)}...</div>
                      </div>
                    </div>
                    <button onClick={async () => { await window.cowork.custom.removeSkill(skill.name); loadAll() }}
                      className="text-[11px] text-text-muted hover:text-red cursor-pointer px-2 py-1 rounded">Remove</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {filtered.length === 0 && filter !== 'custom' && (
          <div className="text-center py-12 text-text-muted text-[13px]">No plugins found</div>
        )}
      </div>
    </div>
  )
}
