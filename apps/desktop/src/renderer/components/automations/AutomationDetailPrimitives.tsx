import type { ReactNode } from 'react'

export function SummaryCard({
  label,
  value,
  detail,
  accent = false,
  compact = false,
}: {
  label: string
  value: string
  detail: string
  accent?: boolean
  compact?: boolean
}) {
  return (
    <div
      className="rounded-2xl border border-border-subtle p-4"
      style={{ background: accent ? 'color-mix(in srgb, var(--color-accent) 10%, var(--color-elevated))' : 'var(--color-elevated)' }}
    >
      <div className="text-[10px] uppercase tracking-[0.16em] text-text-muted">{label}</div>
      <div className={`mt-2 font-semibold text-text ${compact ? 'text-[15px] leading-6' : 'text-[22px]'} `}>{value}</div>
      <div className="mt-1 text-[12px] leading-5 text-text-secondary">{detail}</div>
    </div>
  )
}

export function DetailSection({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-border-subtle p-5" style={{ background: 'var(--color-elevated)' }}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[15px] font-semibold text-text">{title}</div>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  )
}

export function DetailGroup({
  label,
  values,
  empty = 'None',
}: {
  label: string
  values: string[]
  empty?: string
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-[0.14em] text-text-muted">{label}</div>
      {values.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {values.map((value) => (
            <span key={`${label}-${value}`} className="rounded-full border border-border px-2.5 py-1 text-[11px] text-text-secondary">
              {value}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-[12px] text-text-muted">{empty}</div>
      )}
    </div>
  )
}
