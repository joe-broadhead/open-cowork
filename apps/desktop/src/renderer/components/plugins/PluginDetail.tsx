import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Plugin } from '@cowork/shared'
import { PluginIcon } from './PluginIcon'

interface McpTool { id: string; mcp: string; tool: string }
interface RuntimeSkill { name: string; description: string }

export function PluginDetail({ plugin, onBack, onRefresh }: { plugin: Plugin; onBack: () => void; onRefresh: () => void }) {
  const [loading, setLoading] = useState(false)
  const [expandedItem, setExpandedItem] = useState<string | null>(null)
  const [skillContent, setSkillContent] = useState<Record<string, string | null>>({})
  const [mcpTools, setMcpTools] = useState<McpTool[]>([])
  const [runtimeSkills, setRuntimeSkills] = useState<RuntimeSkill[]>([])

  useEffect(() => {
    window.cowork.plugins.mcpTools().then(setMcpTools)
    window.cowork.plugins.runtimeSkills().then(setRuntimeSkills)
  }, [])

  const handleToggle = async () => {
    setLoading(true)
    try {
      if (plugin.installed) await window.cowork.plugins.uninstall(plugin.id)
      else await window.cowork.plugins.install(plugin.id)
      await onRefresh()
    } finally { setLoading(false) }
  }

  const handleExpandSkill = async (skillName: string) => {
    const key = `skill:${skillName}`
    if (expandedItem === key) { setExpandedItem(null); return }
    setExpandedItem(key)
    if (!(skillName in skillContent)) {
      const content = await window.cowork.plugins.skillContent(skillName.toLowerCase().replace(/ /g, '-'))
      setSkillContent(prev => ({ ...prev, [skillName]: content }))
    }
  }

  // Dynamically determine which MCPs belong to this plugin based on allowedTools patterns
  const mcpPrefixes = plugin.allowedTools
    .filter(t => t.startsWith('mcp__') && t.endsWith('__*'))
    .map(t => t.replace('mcp__', '').replace('__*', ''))

  // Group tools by MCP for this plugin
  const mcpGroups: Record<string, McpTool[]> = {}
  for (const prefix of mcpPrefixes) {
    const tools = mcpTools.filter(t => t.mcp === prefix)
    if (tools.length > 0 || mcpPrefixes.includes(prefix)) {
      mcpGroups[prefix] = tools
    }
  }

  // Find skills that match this plugin (by checking if the skill's name maps to a known skill)
  const pluginSkills = runtimeSkills.filter(s => {
    // Match skills by checking if any of the plugin's hardcoded skill names match
    return plugin.skills.some(ps =>
      ps.name.toLowerCase().replace(/ /g, '-') === s.name ||
      ps.name.toLowerCase() === s.name
    )
  })
  // Also include any runtime skills not in the hardcoded list that reference this plugin's MCPs
  // (for custom skills the user added)

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[640px] mx-auto px-8 py-8">
        <button onClick={onBack} className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary cursor-pointer mb-6">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="7,2 3,6 7,10" /></svg>
          Plugins
        </button>

        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <PluginIcon icon={plugin.icon} size={56} />
          <div className="flex-1">
            <h1 className="text-[18px] font-semibold text-text mb-1">{plugin.name}</h1>
            <p className="text-[13px] text-text-secondary leading-relaxed">{plugin.description}</p>
          </div>
          <button onClick={handleToggle} disabled={loading}
            className="shrink-0 px-4 py-2 rounded-lg text-[13px] font-medium transition-colors cursor-pointer"
            style={{ background: plugin.installed ? 'var(--color-surface-hover)' : 'var(--color-accent)', color: plugin.installed ? 'var(--color-text-secondary)' : '#fff', border: plugin.installed ? '1px solid var(--color-border)' : 'none' }}>
            {loading ? '...' : plugin.installed ? 'Remove' : 'Add to Cowork'}
          </button>
        </div>

        {plugin.longDescription && (
          <div className="p-4 rounded-xl bg-elevated border border-border-subtle mb-6">
            <p className="text-[13px] text-text-secondary leading-relaxed">{plugin.longDescription}</p>
          </div>
        )}

        <div className="flex items-center gap-4 text-[11px] text-text-muted mb-6">
          <span>v{plugin.version}</span>
          <span>By {plugin.author}</span>
          <span className="px-1.5 py-0.5 rounded bg-surface-hover">{plugin.category}</span>
        </div>

        {/* Connected MCPs (dynamic) */}
        {Object.keys(mcpGroups).length > 0 && (
          <div className="mb-6">
            <h2 className="text-[13px] font-semibold text-text mb-3">
              Apps <span className="text-text-muted font-normal">({Object.keys(mcpGroups).length} MCPs)</span>
            </h2>
            <div className="flex flex-col gap-2">
              {Object.entries(mcpGroups).map(([mcpName, tools]) => {
                const isExpanded = expandedItem === `mcp:${mcpName}`
                const hardcodedApp = plugin.apps.find(a => a.name.toLowerCase().replace('google ', '').replace(/ /g, '-') === mcpName.replace('google-', ''))
                return (
                  <div key={mcpName} className="rounded-xl border border-border-subtle overflow-hidden">
                    <button onClick={() => setExpandedItem(isExpanded ? null : `mcp:${mcpName}`)}
                      className="w-full flex items-center justify-between p-3.5 hover:bg-surface-hover transition-colors cursor-pointer text-left">
                      <div className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded-md bg-surface-hover flex items-center justify-center shrink-0">
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--color-accent)" strokeWidth="1.3"><rect x="2" y="2" width="8" height="8" rx="1.5" /></svg>
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-medium text-text">{hardcodedApp?.name || mcpName}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ color: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' }}>App</span>
                            <span className="text-[10px] text-text-muted">{tools.length} tools</span>
                          </div>
                          {hardcodedApp && <p className="text-[11px] text-text-muted mt-0.5">{hardcodedApp.description}</p>}
                        </div>
                      </div>
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.3" style={{ transform: isExpanded ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }}>
                        <polyline points="2.5,3.5 5,6.5 7.5,3.5" />
                      </svg>
                    </button>
                    {isExpanded && tools.length > 0 && (
                      <div className="px-4 pb-3 border-t border-border-subtle">
                        <div className="mt-3 grid grid-cols-2 gap-1.5">
                          {tools.map(t => (
                            <div key={t.id} className="px-2.5 py-1.5 rounded-md bg-base text-[10px] font-mono text-text-muted truncate">{t.tool}</div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Skills (dynamic from runtime) */}
        {(pluginSkills.length > 0 || plugin.skills.length > 0) && (
          <div>
            <h2 className="text-[13px] font-semibold text-text mb-3">
              Skills <span className="text-text-muted font-normal">({Math.max(pluginSkills.length, plugin.skills.length)})</span>
            </h2>
            <div className="flex flex-col gap-2">
              {(pluginSkills.length > 0 ? pluginSkills : plugin.skills.map(s => ({ name: s.name, description: s.description }))).map(skill => {
                const key = `skill:${skill.name}`
                const isExpanded = expandedItem === key
                const content = skillContent[skill.name]
                return (
                  <div key={skill.name} className="rounded-xl border border-border-subtle overflow-hidden">
                    <button onClick={() => handleExpandSkill(skill.name)}
                      className="w-full flex items-center justify-between p-3.5 hover:bg-surface-hover transition-colors cursor-pointer text-left">
                      <div className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded-md bg-surface-hover flex items-center justify-center shrink-0">
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--color-amber)" strokeWidth="1.3">
                            <path d="M6 1.5L7.5 4.5L10.5 5L8.25 7.25L8.75 10.5L6 9L3.25 10.5L3.75 7.25L1.5 5L4.5 4.5L6 1.5Z" />
                          </svg>
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-medium text-text capitalize">{skill.name.replace(/-/g, ' ')}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ color: 'var(--color-amber)', background: 'color-mix(in srgb, var(--color-amber) 12%, transparent)' }}>Skill</span>
                          </div>
                          <p className="text-[11px] text-text-muted mt-0.5">{skill.description.slice(0, 100)}{skill.description.length > 100 ? '...' : ''}</p>
                        </div>
                      </div>
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.3" style={{ transform: isExpanded ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }}>
                        <polyline points="2.5,3.5 5,6.5 7.5,3.5" />
                      </svg>
                    </button>
                    {isExpanded && (
                      <div className="border-t border-border-subtle">
                        <div className="p-4 max-h-[500px] overflow-y-auto">
                          {content ? (
                            <div className="text-[12px] prose text-text-secondary leading-relaxed">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content.replace(/^---[\s\S]*?---\n/, '')}</ReactMarkdown>
                            </div>
                          ) : (
                            <p className="text-text-muted text-[12px]">Loading skill content...</p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
