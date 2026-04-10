import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Plugin } from '@cowork/shared'
import { PluginIcon } from './PluginIcon'
import { useSessionStore } from '../../stores/session'

interface RuntimeSkill { name: string; description: string }

export function PluginDetail({ plugin, onBack, onRefresh }: { plugin: Plugin; onBack: () => void; onRefresh: () => void }) {
  const [loading, setLoading] = useState(false)
  const [expandedItem, setExpandedItem] = useState<string | null>(null)
  const [skillContent, setSkillContent] = useState<Record<string, string | null>>({})
  const [runtimeSkills, setRuntimeSkills] = useState<RuntimeSkill[]>([])
  const mcpConnections = useSessionStore(s => s.mcpConnections)

  useEffect(() => {
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
    const lookupName = skillName.toLowerCase().replace(/ /g, '-')
    if (!(lookupName in skillContent)) {
      const content = await window.cowork.plugins.skillContent(lookupName)
      setSkillContent(prev => ({ ...prev, [lookupName]: content }))
    }
  }

  // Match MCPs by checking which connections match the plugin's allowed tools
  const mcpPrefixes = plugin.allowedTools
    .filter(t => t.startsWith('mcp__') && t.endsWith('__*'))
    .map(t => t.replace('mcp__', '').replace('__*', ''))

  // Get connection status for each MCP prefix
  const connectedMcps = mcpPrefixes.map(prefix => {
    const conn = mcpConnections.find(c => c.name === prefix)
    return { name: prefix, connected: conn?.connected ?? false }
  })

  // Match runtime skills to this plugin
  const matchedSkills = runtimeSkills.filter(rs =>
    plugin.skills.some(ps => {
      const psKey = ps.name.toLowerCase().replace(/ /g, '-')
      return psKey === rs.name || ps.name.toLowerCase() === rs.name
    })
  )
  // Use runtime skills if available, otherwise fall back to hardcoded
  const displaySkills = matchedSkills.length > 0
    ? matchedSkills.map(s => ({ name: s.name, description: s.description }))
    : plugin.skills.map(s => ({ name: s.name.toLowerCase().replace(/ /g, '-'), description: s.description }))

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

        {/* Apps */}
        {plugin.apps.length > 0 && (
          <div className="mb-6">
            <h2 className="text-[13px] font-semibold text-text mb-3">
              Apps <span className="text-text-muted font-normal">({plugin.apps.length})</span>
            </h2>
            <div className="flex flex-col gap-2">
              {plugin.apps.map(app => {
                // Find matching MCP connection
                const appKey = app.name.toLowerCase().replace('google ', 'google-').replace(/ /g, '-')
                const conn = connectedMcps.find(c => c.name === appKey || c.name === appKey.replace('google-', '') || app.name.toLowerCase().includes(c.name.replace('google-', '')))
                // Extract tool count from description
                const toolMatch = app.description.match(/\((\d+) tools?\)/)
                const toolCount = toolMatch ? toolMatch[1] : null

                return (
                  <div key={app.name} className="flex items-center gap-3 p-3 rounded-xl border border-border-subtle">
                    <PluginIcon icon={appKey} size={32} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-text">{app.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ color: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' }}>App</span>
                        {toolCount && <span className="text-[10px] text-text-muted">{toolCount} tools</span>}
                      </div>
                      <p className="text-[11px] text-text-muted mt-0.5 truncate">{app.description.replace(/\s*\(\d+ tools?\)/, '')}</p>
                    </div>
                    {conn && (
                      <div className="w-[6px] h-[6px] rounded-full shrink-0" style={{
                        background: conn.connected ? 'var(--color-green)' : 'var(--color-text-muted)',
                        boxShadow: conn.connected ? '0 0 4px var(--color-green)' : 'none',
                      }} />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Skills */}
        {displaySkills.length > 0 && (
          <div>
            <h2 className="text-[13px] font-semibold text-text mb-3">
              Skills <span className="text-text-muted font-normal">({displaySkills.length})</span>
            </h2>
            <div className="flex flex-col gap-2">
              {displaySkills.map(skill => {
                const lookupName = skill.name.toLowerCase().replace(/ /g, '-')
                const key = `skill:${skill.name}`
                const isExpanded = expandedItem === key
                const content = skillContent[lookupName]
                return (
                  <div key={skill.name} className="rounded-xl border border-border-subtle overflow-hidden">
                    <button onClick={() => handleExpandSkill(skill.name)}
                      className="w-full flex items-center justify-between p-3.5 hover:bg-surface-hover transition-colors cursor-pointer text-left">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-surface-hover flex items-center justify-center shrink-0">
                          <svg width="14" height="14" viewBox="0 0 12 12" fill="none" stroke="var(--color-amber)" strokeWidth="1.3">
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
                          ) : content === null ? (
                            <p className="text-text-muted text-[12px]">Skill file not found on disk.</p>
                          ) : (
                            <p className="text-text-muted text-[12px]">Loading...</p>
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
