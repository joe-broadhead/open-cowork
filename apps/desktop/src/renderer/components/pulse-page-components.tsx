import type { ReactNode } from 'react'
import type { DashboardTimeRangeKey } from '@open-cowork/shared'
import { t } from '../helpers/i18n'
import {
  dashboardRangeOptions,
  RefreshIcon,
  ratio,
} from './pulse-page-support.tsx'

type StatusPill = {
  label: string
  value: string
  accent?: string
}

function PulseWarningBanner({
  tone,
  children,
}: {
  tone: 'amber' | 'red' | 'muted'
  children: ReactNode
}) {
  const toneStyles = tone === 'red'
    ? {
        borderColor: 'color-mix(in srgb, var(--color-red) 40%, var(--color-border-subtle))',
        background: 'color-mix(in srgb, var(--color-red) 8%, transparent)',
        color: 'var(--color-red)',
      }
    : tone === 'amber'
      ? {
          borderColor: 'color-mix(in srgb, var(--color-amber) 40%, var(--color-border-subtle))',
          background: 'color-mix(in srgb, var(--color-amber) 8%, transparent)',
          color: 'var(--color-amber)',
        }
      : {
          borderColor: 'var(--color-border-subtle)',
          background: 'color-mix(in srgb, var(--color-text-muted) 6%, transparent)',
        }

  return (
    <div className="mt-4 rounded-xl border px-3 py-2 text-[11px]" style={toneStyles}>
      {children}
    </div>
  )
}

export function PulseHeader({
  brandName,
  statusPills,
  dashboardRange,
  dashboardError,
  backfillFailedCount,
  backfillPendingCount,
  loading,
  onDashboardRangeChange,
  onRefresh,
}: {
  brandName: string
  statusPills: StatusPill[]
  dashboardRange: DashboardTimeRangeKey
  dashboardError: string | null
  backfillFailedCount: number
  backfillPendingCount: number
  loading: boolean
  onDashboardRangeChange: (range: DashboardTimeRangeKey) => void
  onRefresh: () => void
}) {
  return (
    <div className="px-7 py-6 border-b border-border-subtle">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div className="max-w-[720px]">
          <div
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-[11px] font-medium text-text-secondary"
            style={{
              background: 'color-mix(in srgb, var(--color-surface) 72%, var(--color-elevated) 28%)',
              boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
            }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            {t('homepage.diagnostics', '{{brandName}} Diagnostics', { brandName })}
          </div>
          <h1 className="mt-4 text-[34px] leading-[1.02] tracking-[-0.04em] font-semibold text-text max-[720px]:text-[29px]">
            {t('homepage.title', 'Workspace state, capabilities, and execution health in one view.')}
          </h1>
          <p className="mt-3 text-[13px] leading-relaxed text-text-secondary max-w-[640px]">
            {t('homepage.subtitle', 'Use home as an observability surface, not a splash screen. Check what is loaded, what is connected, what OpenCode is using, and where to jump back in.')}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          <div
            className="inline-flex items-center gap-1 rounded-2xl p-1"
            style={{
              background: 'color-mix(in srgb, var(--color-surface) 74%, var(--color-elevated) 26%)',
              boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 4%, transparent)',
            }}
          >
            {dashboardRangeOptions().map((option) => {
              const selected = option.key === dashboardRange
              return (
                <button
                  key={option.key}
                  onClick={() => onDashboardRangeChange(option.key)}
                  className="px-3 py-1.5 rounded-xl text-[11px] transition-colors cursor-pointer"
                  style={{
                    color: selected ? 'var(--color-text)' : 'var(--color-text-muted)',
                    background: selected ? 'var(--color-elevated)' : 'transparent',
                    boxShadow: selected
                      ? 'inset 0 0 0 1px color-mix(in srgb, var(--color-accent) 14%, transparent)'
                      : 'none',
                  }}
                >
                  {option.label}
                </button>
              )
            })}
          </div>

          <button
            onClick={onRefresh}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-2xl bg-surface hover:bg-surface-hover text-[12px] text-text-secondary transition-colors cursor-pointer"
            style={{
              boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--color-text) 5%, transparent)',
            }}
          >
            <RefreshIcon />
            {loading ? t('homepage.refreshing', 'Refreshing…') : t('homepage.refresh', 'Refresh')}
          </button>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-5 gap-3 max-[1160px]:grid-cols-3 max-[760px]:grid-cols-2">
        {statusPills.map((pill) => (
          <Pill key={pill.label} label={pill.label} value={pill.value} accent={pill.accent} />
        ))}
      </div>

      {dashboardError ? (
        <PulseWarningBanner tone="red">
          {t('homepage.warning.dashboardFailed', 'Dashboard totals failed to load: {{error}}', { error: dashboardError })}
        </PulseWarningBanner>
      ) : null}

      {backfillFailedCount > 0 ? (
        <PulseWarningBanner tone="amber">
          {t('homepage.warning.backfillFailed', "{{count}} session(s) couldn't be reconstructed — totals below may be understated.", { count: String(backfillFailedCount) })}
        </PulseWarningBanner>
      ) : null}

      {backfillPendingCount > 0 ? (
        <PulseWarningBanner tone="muted">
          {t('homepage.warning.backfillPending', 'Still loading {{count}} older session(s) in the background. Totals will refresh automatically.', { count: String(backfillPendingCount) })}
        </PulseWarningBanner>
      ) : null}
    </div>
  )
}

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
