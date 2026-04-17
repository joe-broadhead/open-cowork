import type { AgentCatalog } from '@open-cowork/shared'
import { PluginIcon } from '../plugins/PluginIcon'
import { McpRestrictionPanel } from './McpRestrictionPanel'

type Props = {
  catalog: AgentCatalog
  selectedToolIds: string[]
  onToggle: (toolId: string) => void
  readOnly?: boolean
  deniedToolPatterns: string[]
  onToggleDeniedPattern: (pattern: string) => void
  projectDirectory: string | null
}

// Tools workbench — grid of icon tiles from the catalog. Clicking a tile
// toggles the tool into the agent's loadout. Write-capable tools get a
// subtle amber mark so users see they're broadening the agent's footprint.
export function ToolLibraryTab({
  catalog,
  selectedToolIds,
  onToggle,
  readOnly,
  deniedToolPatterns,
  onToggleDeniedPattern,
  projectDirectory,
}: Props) {
  const selected = new Set(selectedToolIds)

  if (catalog.tools.length === 0) {
    return (
      <div className="text-[12px] text-text-muted py-8 text-center rounded-xl border border-border-subtle border-dashed">
        No tools available yet. Add an MCP from the Capabilities page.
      </div>
    )
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-2.5">
      {catalog.tools.map((tool) => {
        const isOn = selected.has(tool.id)
        return (
          <button
            key={tool.id}
            onClick={() => !readOnly && onToggle(tool.id)}
            disabled={readOnly}
            className="flex items-start gap-2.5 p-3 rounded-xl border text-left transition-colors cursor-pointer disabled:cursor-default"
            style={{
              borderColor: isOn ? 'var(--color-accent)' : 'var(--color-border-subtle)',
              background: isOn
                ? 'color-mix(in srgb, var(--color-accent) 10%, transparent)'
                : 'var(--color-surface)',
              boxShadow: isOn ? '0 0 0 1px var(--color-accent)' : 'none',
            }}
            title={tool.description}
          >
            <PluginIcon icon={tool.icon} size={28} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] font-medium text-text truncate">{tool.name}</span>
                {tool.supportsWrite && (
                  <span
                    className="shrink-0 text-[9px] uppercase tracking-[0.04em] px-1 py-px rounded"
                    style={{
                      color: 'var(--color-amber)',
                      background: 'color-mix(in srgb, var(--color-amber) 12%, transparent)',
                    }}
                    title="This tool can write — adds to the agent's footprint"
                  >
                    W
                  </span>
                )}
              </div>
              <div className="text-[10px] text-text-muted leading-relaxed line-clamp-2 mt-0.5">
                {tool.description}
              </div>
            </div>
          </button>
        )
      })}
      </div>
      <McpRestrictionPanel
        catalog={catalog}
        selectedToolIds={selectedToolIds}
        deniedToolPatterns={deniedToolPatterns}
        projectDirectory={projectDirectory}
        onTogglePattern={onToggleDeniedPattern}
        readOnly={readOnly}
      />
    </div>
  )
}
