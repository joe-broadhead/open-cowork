// Five-segment meter for agent attributes (Breadth / Range / Autonomy).
// Semantic-coloured: filled segments glow in the accent tone; empty
// segments sit on a faint track. Deliberately flat — no animation on
// mount, no glow beyond the filled tint — so a grid of cards stays
// calm.

type Props = {
  value: number // 0..5
  label: string
  icon: React.ReactNode
  tone?: string // CSS colour — var(--color-accent) by default
}

const SEGMENTS = 5

export function AgentAttributeBar({ value, label, icon, tone = 'var(--color-accent)' }: Props) {
  const filled = Math.max(0, Math.min(SEGMENTS, Math.round(value)))
  return (
    <div className="flex items-center gap-2 text-[10px] text-text-muted">
      <span
        className="shrink-0 inline-flex items-center justify-center w-4 h-4"
        style={{ color: tone }}
      >
        {icon}
      </span>
      <span className="w-[60px] truncate uppercase tracking-[0.08em]">{label}</span>
      <span className="flex items-center gap-[3px]">
        {Array.from({ length: SEGMENTS }).map((_, index) => {
          const isOn = index < filled
          return (
            <span
              key={index}
              className="inline-block w-[10px] h-[6px] rounded-sm"
              style={{
                background: isOn
                  ? tone
                  : 'color-mix(in srgb, var(--color-text-muted) 22%, transparent)',
                opacity: isOn ? 0.9 : 1,
              }}
            />
          )
        })}
      </span>
    </div>
  )
}
