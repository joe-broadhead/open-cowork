import type { AutomationAgentOption } from './automation-view-model'

export function AutomationAgentTeamSelector({
  options,
  value,
  onChange,
  emptyLabel = 'No specialist agents are available in this context yet.',
}: {
  options: AutomationAgentOption[]
  value: string[]
  onChange: (next: string[]) => void
  emptyLabel?: string
}) {
  if (options.length === 0) {
    return <div className="text-[12px] text-text-muted">{emptyLabel}</div>
  }

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const selected = value.includes(option.id)
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(selected ? value.filter((entry) => entry !== option.id) : [...value, option.id])}
            className="rounded-full border px-3 py-1.5 text-left transition-colors cursor-pointer"
            style={{
              borderColor: selected ? 'var(--color-accent)' : 'var(--color-border)',
              background: selected ? 'color-mix(in srgb, var(--color-accent) 12%, var(--color-elevated))' : 'transparent',
            }}
            title={option.description}
          >
            <span className="text-[11px] font-medium text-text">{option.label}</span>
            <span className="ml-2 text-[10px] uppercase tracking-[0.14em] text-text-muted">{option.source}</span>
          </button>
        )
      })}
    </div>
  )
}
