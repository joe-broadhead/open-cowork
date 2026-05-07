import type { ReactNode } from 'react'
import { ratio } from './pulse-page-support.tsx'

export function Pill({
  label,
  value,
  accent = 'var(--color-accent)',
}: {
  label: string
  value: string
  accent?: string
}) {
  return (
    <div
      className="rounded-2xl px-3.5 py-3 border border-border-subtle"
      style={{
        background: 'var(--color-elevated)',
        boxShadow: `inset 0 1px 0 color-mix(in srgb, ${accent} 6%, transparent)`,
      }}
    >
      <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{label}</div>
      <div className="mt-1.5 text-[13px] font-medium text-text truncate">{value}</div>
    </div>
  )
}

export function MetricCard({
  icon,
  eyebrow,
  title,
  children,
}: {
  icon: ReactNode
  eyebrow: string
  title: string
  children: ReactNode
}) {
  return (
    <section
      className="rounded-[26px] border border-border-subtle overflow-hidden shadow-card"
      style={{
        background: 'var(--color-elevated)',
      }}
    >
      <div className="px-5 py-4 border-b border-border-subtle flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-text-muted">{eyebrow}</div>
          <div className="mt-2 text-[18px] font-semibold text-text">{title}</div>
        </div>
        <span
          className="inline-flex h-9 w-9 items-center justify-center rounded-2xl bg-surface text-text-secondary"
          style={{
            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
          }}
        >
          {icon}
        </span>
      </div>
      <div className="p-5">{children}</div>
    </section>
  )
}

export function StatGrid({
  items,
}: {
  items: Array<{ label: string; value: string; tone?: 'default' | 'accent' }>
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-2xl px-3.5 py-3 border border-border-subtle bg-surface"
        >
          <div className="text-[10px] uppercase tracking-[0.12em] text-text-muted">{item.label}</div>
          <div
            className="mt-2 text-[22px] leading-none font-semibold font-mono"
            style={{ color: item.tone === 'accent' ? 'var(--color-accent)' : 'var(--color-text)' }}
          >
            {item.value}
          </div>
        </div>
      ))}
    </div>
  )
}

export function Row({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: string
  tone?: 'default' | 'accent' | 'muted'
}) {
  return (
    <div className="flex items-center justify-between gap-4 text-[12px]">
      <span className="text-text-muted">{label}</span>
      <span
        className="font-medium"
        style={{
          color: tone === 'accent'
            ? 'var(--color-accent)'
            : tone === 'muted'
              ? 'var(--color-text-secondary)'
              : 'var(--color-text)',
        }}
      >
        {value}
      </span>
    </div>
  )
}

export function TagRail({ items, emptyLabel }: { items: string[]; emptyLabel: string }) {
  if (items.length === 0) {
    return <div className="text-[12px] text-text-muted">{emptyLabel}</div>
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <span
          key={item}
          className="px-2.5 py-1 rounded-full bg-surface text-[11px] text-text-secondary"
          style={{
            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
          }}
        >
          {item}
        </span>
      ))}
    </div>
  )
}

export function UsageBar({
  segments,
}: {
  segments: Array<{ label: string; value: number; color: string }>
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)

  return (
    <div className="flex flex-col gap-2.5">
      <div
        className="h-2 rounded-full overflow-hidden bg-surface flex"
        style={{
          boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
        }}
      >
        {segments.map((segment) => (
          <div
            key={segment.label}
            style={{
              width: `${total > 0 ? (segment.value / total) * 100 : 0}%`,
              background: segment.color,
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-text-muted">
        {segments.map((segment) => (
          <span key={segment.label} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: segment.color }} />
            {segment.label} {total > 0 ? `${ratio(segment.value, total)}%` : '0%'}
          </span>
        ))}
      </div>
    </div>
  )
}
