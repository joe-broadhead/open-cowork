import { useState } from 'react'
import type { Plugin } from '@cowork/shared'

export function PluginDetail({ plugin, onBack, onRefresh }: { plugin: Plugin; onBack: () => void; onRefresh: () => void }) {
  const [loading, setLoading] = useState(false)
  const [expandedItem, setExpandedItem] = useState<string | null>(null)

  const handleToggle = async () => {
    setLoading(true)
    try {
      if (plugin.installed) {
        await window.cowork.plugins.uninstall(plugin.id)
      } else {
        await window.cowork.plugins.install(plugin.id)
      }
      await onRefresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[640px] mx-auto px-8 py-8">
        {/* Back */}
        <button onClick={onBack} className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary cursor-pointer mb-6">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><polyline points="7,2 3,6 7,10" /></svg>
          Plugins
        </button>

        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <div className="w-14 h-14 rounded-2xl bg-elevated border border-border flex items-center justify-center text-[28px] shrink-0">{plugin.icon}</div>
          <div className="flex-1">
            <h1 className="text-[18px] font-semibold text-text mb-1">{plugin.name}</h1>
            <p className="text-[13px] text-text-secondary leading-relaxed">{plugin.description}</p>
          </div>
          <button
            onClick={handleToggle}
            disabled={loading}
            className="shrink-0 px-4 py-2 rounded-lg text-[13px] font-medium transition-colors cursor-pointer"
            style={{
              background: plugin.installed ? 'var(--color-surface-hover)' : 'var(--color-accent)',
              color: plugin.installed ? 'var(--color-text-secondary)' : '#fff',
              border: plugin.installed ? '1px solid var(--color-border)' : 'none',
            }}
          >
            {loading ? '...' : plugin.installed ? 'Remove' : 'Add to Cowork'}
          </button>
        </div>

        {/* Description */}
        {plugin.longDescription && (
          <div className="p-4 rounded-xl bg-elevated border border-border-subtle mb-6">
            <p className="text-[13px] text-text-secondary leading-relaxed">{plugin.longDescription}</p>
          </div>
        )}

        {/* Meta */}
        <div className="flex items-center gap-4 text-[11px] text-text-muted mb-6">
          <span>v{plugin.version}</span>
          <span>By {plugin.author}</span>
          <span className="px-1.5 py-0.5 rounded bg-surface-hover">{plugin.category}</span>
          {plugin.builtin && <span className="px-1.5 py-0.5 rounded bg-surface-hover">Built-in</span>}
        </div>

        {/* Includes */}
        <h2 className="text-[13px] font-semibold text-text mb-3">Includes</h2>
        <div className="flex flex-col gap-2">
          {plugin.apps.map((item) => {
            const isExpanded = expandedItem === `app:${item.name}`
            return (
              <div key={item.name} className="rounded-xl border border-border-subtle overflow-hidden">
                <button
                  onClick={() => setExpandedItem(isExpanded ? null : `app:${item.name}`)}
                  className="w-full flex items-start gap-3 p-3.5 hover:bg-surface-hover transition-colors cursor-pointer text-left"
                >
                  <div className="w-6 h-6 rounded-md bg-surface-hover flex items-center justify-center shrink-0 mt-0.5">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--color-accent)" strokeWidth="1.3">
                      <rect x="2" y="2" width="8" height="8" rx="1.5" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-text">{item.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ color: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' }}>App</span>
                    </div>
                    <p className="text-[11px] text-text-muted mt-0.5">{item.description}</p>
                  </div>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.3" className="mt-2 shrink-0" style={{ transform: isExpanded ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }}>
                    <polyline points="2.5,3.5 5,6.5 7.5,3.5" />
                  </svg>
                </button>
                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-border-subtle">
                    <div className="mt-3 p-3 rounded-lg bg-base text-[12px] text-text-secondary leading-relaxed">
                      <div className="font-medium text-text mb-2">MCP Connection</div>
                      <p>{item.description}</p>
                      <div className="mt-2 text-[11px] text-text-muted">
                        This app connects to an external service and provides tools the assistant can use.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
          {plugin.skills.map((item) => {
            const isExpanded = expandedItem === `skill:${item.name}`
            return (
              <div key={item.name} className="rounded-xl border border-border-subtle overflow-hidden">
                <button
                  onClick={() => setExpandedItem(isExpanded ? null : `skill:${item.name}`)}
                  className="w-full flex items-start gap-3 p-3.5 hover:bg-surface-hover transition-colors cursor-pointer text-left"
                >
                  <div className="w-6 h-6 rounded-md bg-surface-hover flex items-center justify-center shrink-0 mt-0.5">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="var(--color-amber)" strokeWidth="1.3">
                      <path d="M6 1.5L7.5 4.5L10.5 5L8.25 7.25L8.75 10.5L6 9L3.25 10.5L3.75 7.25L1.5 5L4.5 4.5L6 1.5Z" />
                    </svg>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-text">{item.name}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ color: 'var(--color-amber)', background: 'color-mix(in srgb, var(--color-amber) 12%, transparent)' }}>Skill</span>
                    </div>
                    <p className="text-[11px] text-text-muted mt-0.5">{item.description}</p>
                  </div>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--color-text-muted)" strokeWidth="1.3" className="mt-2 shrink-0" style={{ transform: isExpanded ? 'rotate(180deg)' : '', transition: 'transform 0.15s' }}>
                    <polyline points="2.5,3.5 5,6.5 7.5,3.5" />
                  </svg>
                </button>
                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-border-subtle">
                    <div className="mt-3 p-3 rounded-lg bg-base text-[12px] text-text-secondary leading-relaxed prose">
                      <div className="font-medium text-text mb-2">Skill Instructions</div>
                      <p>{item.description}</p>
                      <div className="mt-2 text-[11px] text-text-muted">
                        This skill teaches the assistant a structured workflow. It is loaded on demand when the assistant determines it is relevant to your request.
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
