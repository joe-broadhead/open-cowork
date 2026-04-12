import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AppSettings, Plugin } from '@open-cowork/shared'
import { PluginIcon } from './PluginIcon'
import { useSessionStore } from '../../stores/session'

interface RuntimeSkill { name: string; description: string }

export function PluginDetail({ plugin, onBack, onRefresh }: { plugin: Plugin; onBack: () => void; onRefresh: () => void }) {
  const [loading, setLoading] = useState(false)
  const [expandedItem, setExpandedItem] = useState<string | null>(null)
  const [skillContent, setSkillContent] = useState<Record<string, string | null>>({})
  const [runtimeSkills, setRuntimeSkills] = useState<RuntimeSkill[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({})
  const [credentialSaving, setCredentialSaving] = useState<string | null>(null)
  const mcpConnections = useSessionStore(s => s.mcpConnections)

  useEffect(() => {
    window.openCowork.plugins.runtimeSkills().then(setRuntimeSkills)
  }, [plugin.installed])

  useEffect(() => {
    window.openCowork.settings.get().then((next) => {
      setSettings(next)
      const values: Record<string, string> = {}
      for (const credential of plugin.credentials || []) {
        values[credential.key] = next.integrationCredentials?.[plugin.id]?.[credential.key] || ''
      }
      setCredentialValues(values)
    })
  }, [plugin.id, plugin.installed])

  const handleToggle = async () => {
    setLoading(true)
    try {
      if (plugin.installed) await window.openCowork.plugins.uninstall(plugin.id)
      else await window.openCowork.plugins.install(plugin.id)
      await onRefresh()
    } finally { setLoading(false) }
  }

  const handleExpandSkill = async (skillName: string) => {
    const key = `skill:${skillName}`
    if (expandedItem === key) { setExpandedItem(null); return }
    setExpandedItem(key)
    const lookupName = skillName.toLowerCase().replace(/ /g, '-')
    if (!(lookupName in skillContent)) {
      const content = await window.openCowork.plugins.skillContent(lookupName)
      setSkillContent(prev => ({ ...prev, [lookupName]: content }))
    }
  }

  const handleCredentialSave = async (key: string, valueOverride?: string | null) => {
    setCredentialSaving(key)
    try {
      const nextValue = valueOverride !== undefined ? valueOverride : (credentialValues[key] || '').trim()
      const trimmed = nextValue ? nextValue : null
      const updated = await window.openCowork.settings.set({
        integrationCredentials: {
          [plugin.id]: {
            ...(settings?.integrationCredentials?.[plugin.id] || {}),
            [key]: typeof trimmed === 'string' ? trimmed : '',
          },
        },
      } as Partial<AppSettings>)
      setSettings(updated)
      setCredentialValues((prev) => ({ ...prev, [key]: typeof trimmed === 'string' ? trimmed : '' }))
      await onRefresh()
    } finally {
      setCredentialSaving(null)
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
            {plugin.credentials?.length ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {plugin.credentials.every((credential) => credential.configured) ? (
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={{ color: 'var(--color-green)', background: 'color-mix(in srgb, var(--color-green) 12%, transparent)' }}>
                    Credentials configured
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-medium" style={{ color: 'var(--color-amber)', background: 'color-mix(in srgb, var(--color-amber) 12%, transparent)' }}>
                    Credential setup required
                  </span>
                )}
              </div>
            ) : null}
          </div>
          <button onClick={handleToggle} disabled={loading}
            className="shrink-0 px-4 py-2 rounded-lg text-[13px] font-medium transition-colors cursor-pointer"
            style={{ background: plugin.installed ? 'var(--color-surface-hover)' : 'var(--color-accent)', color: plugin.installed ? 'var(--color-text-secondary)' : '#fff', border: plugin.installed ? '1px solid var(--color-border)' : 'none' }}>
            {loading ? '...' : plugin.installed ? 'Remove' : 'Add to Open Cowork'}
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

        {plugin.credentials?.length ? (
          <div className="mb-6">
            <h2 className="text-[13px] font-semibold text-text mb-3">
              Authentication <span className="text-text-muted font-normal">({plugin.credentials.length})</span>
            </h2>
            <div className="flex flex-col gap-3">
              {plugin.credentials.map((credential) => (
                <div key={credential.key} className="rounded-xl border border-border-subtle p-4 flex flex-col gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[13px] font-medium text-text">{credential.label}</div>
                      <p className="text-[11px] text-text-muted mt-1 leading-relaxed">{credential.description}</p>
                    </div>
                    <span
                      className="px-2 py-0.5 rounded-md text-[10px] font-medium shrink-0"
                      style={{
                        color: credential.configured ? 'var(--color-green)' : 'var(--color-amber)',
                        background: credential.configured
                          ? 'color-mix(in srgb, var(--color-green) 12%, transparent)'
                          : 'color-mix(in srgb, var(--color-amber) 12%, transparent)',
                      }}
                    >
                      {credential.configured ? 'Configured' : 'Required'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type={credential.secret ? 'password' : 'text'}
                      value={credentialValues[credential.key] || ''}
                      onChange={(event) => setCredentialValues((prev) => ({ ...prev, [credential.key]: event.target.value }))}
                      placeholder={credential.placeholder}
                      className="flex-1 px-3 py-2 rounded-lg text-[12px] bg-base border border-border-subtle text-text placeholder:text-text-muted outline-none focus:border-accent/40 transition-colors"
                    />
                    <button
                      onClick={() => void handleCredentialSave(credential.key)}
                      disabled={credentialSaving === credential.key}
                      className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer transition-colors"
                      style={{ background: 'var(--color-accent)', color: '#fff' }}
                    >
                      {credentialSaving === credential.key ? 'Saving…' : credential.configured ? 'Update' : 'Save'}
                    </button>
                    {settings && settings.integrationCredentials?.[plugin.id]?.[credential.key] ? (
                      <button
                        onClick={() => void handleCredentialSave(credential.key, null)}
                        className="px-3 py-2 rounded-lg text-[12px] font-medium cursor-pointer transition-colors border border-border-subtle text-text-muted hover:text-text-secondary"
                      >
                        Clear
                      </button>
                    ) : null}
                  </div>
                  {plugin.id === 'github' ? (
                    <p className="text-[11px] text-text-muted leading-relaxed">
                      GitHub’s official MCP publishes toolsets plus MCP prompts and resources rather than product-specific `SKILL.md` packages. Open Cowork loads a bounded hosted GitHub toolset for repos, issues, PRs, Actions, and security.
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

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
