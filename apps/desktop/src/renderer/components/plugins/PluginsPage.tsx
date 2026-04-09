import { useState, useEffect } from 'react'
import type { Plugin } from '@cowork/shared'
import { PluginDetail } from './PluginDetail'

export function PluginsPage({ onClose }: { onClose: () => void }) {
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'installed'>('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    window.cowork.plugins.list().then(setPlugins)
  }, [])

  const refresh = async () => {
    const updated = await window.cowork.plugins.list()
    setPlugins(updated)
  }

  const filtered = plugins.filter((p) => {
    if (filter === 'installed' && !p.installed) return false
    if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && !p.description.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const selected = selectedId ? plugins.find((p) => p.id === selectedId) : null

  if (selected) {
    return <PluginDetail plugin={selected} onBack={() => setSelectedId(null)} onRefresh={refresh} />
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[800px] mx-auto px-8 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-[18px] font-semibold text-text">Plugins</h1>
          <button
            onClick={onClose}
            className="text-[12px] text-text-muted hover:text-text-secondary cursor-pointer"
          >
            Back to chat
          </button>
        </div>

        {/* Search + filter */}
        <div className="flex items-center gap-3 mb-6">
          <div className="flex-1 relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search plugins..."
              className="w-full px-4 py-2.5 rounded-xl bg-elevated border border-border-subtle text-[13px] text-text placeholder:text-text-muted outline-none focus:border-border"
            />
          </div>
          <div className="flex rounded-lg border border-border-subtle overflow-hidden">
            <button
              onClick={() => setFilter('all')}
              className={`px-3 py-1.5 text-[12px] font-medium cursor-pointer transition-colors ${
                filter === 'all' ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setFilter('installed')}
              className={`px-3 py-1.5 text-[12px] font-medium cursor-pointer transition-colors ${
                filter === 'installed' ? 'bg-surface-active text-text' : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              Installed
            </button>
          </div>
        </div>

        {/* Plugin grid */}
        <div className="grid grid-cols-2 gap-3">
          {filtered.map((plugin) => (
            <button
              key={plugin.id}
              onClick={() => setSelectedId(plugin.id)}
              className="flex items-start gap-3.5 p-4 rounded-xl border border-border-subtle bg-surface hover:bg-surface-hover transition-colors cursor-pointer text-left"
            >
              <div className="w-10 h-10 rounded-xl bg-elevated border border-border flex items-center justify-center text-[20px] shrink-0">
                {plugin.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[13px] font-medium text-text">{plugin.name}</span>
                  {plugin.installed && (
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-medium" style={{ color: 'var(--color-green)', background: 'color-mix(in srgb, var(--color-green) 12%, transparent)' }}>
                      Active
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-text-muted leading-relaxed line-clamp-2">{plugin.description}</p>
              </div>
            </button>
          ))}
        </div>

        {filtered.length === 0 && (
          <div className="text-center py-12 text-text-muted text-[13px]">
            No plugins found
          </div>
        )}
      </div>
    </div>
  )
}
