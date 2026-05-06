import type {
  BuiltInAgentDetail,
  CapabilitySkill,
  CapabilityTool,
  CustomAgentSummary,
  CustomMcpConfig,
  DashboardTimeRangeKey,
  PerfCounterSnapshot,
  PerfDistributionSnapshot,
  PerfSnapshot,
  RuntimeInputDiagnostics,
} from '@open-cowork/shared'
import { formatCompactNumber as i18nFormatCompact, formatNumber as i18nFormatNumber, t } from '../helpers/i18n'

type RuntimeModel = {
  providerId: string | null
  modelId: string | null
  contextLimit: number | null
}

export type DiagnosticsState = {
  loading: boolean
  runtimeReady: boolean
  runtimeModel: RuntimeModel
  runtimeInputs: RuntimeInputDiagnostics | null
  skills: CapabilitySkill[]
  customMcps: CustomMcpConfig[]
  customSkills: Array<{ name: string; content: string }>
  tools: CapabilityTool[]
  builtinAgents: BuiltInAgentDetail[]
  customAgents: CustomAgentSummary[]
  perf: PerfSnapshot | null
  updatedAt: string | null
}

export const EMPTY_DIAGNOSTICS: DiagnosticsState = {
  loading: true,
  runtimeReady: false,
  runtimeModel: {
    providerId: null,
    modelId: null,
    contextLimit: null,
  },
  runtimeInputs: null,
  skills: [],
  customMcps: [],
  customSkills: [],
  tools: [],
  builtinAgents: [],
  customAgents: [],
  perf: null,
  updatedAt: null,
}

export const DASHBOARD_RANGE_KEYS: DashboardTimeRangeKey[] = ['last7d', 'last30d', 'ytd', 'all']
export const DASHBOARD_RANGE_STORAGE_KEY = 'open-cowork.dashboardRange.v1'
export const LEGACY_DASHBOARD_RANGE_STORAGE_KEY = 'opencowork.dashboardRange.v1'

export function dashboardRangeOptions(): Array<{ key: DashboardTimeRangeKey; label: string }> {
  return [
    { key: 'last7d', label: t('homepage.range.last7d', 'Last 7 days') },
    { key: 'last30d', label: t('homepage.range.last30d', 'Last 30 days') },
    { key: 'ytd', label: t('homepage.range.ytd', 'YTD') },
    { key: 'all', label: t('homepage.range.all', 'All time') },
  ]
}

export function readStoredRange(): DashboardTimeRangeKey {
  try {
    const stored = window.localStorage.getItem(DASHBOARD_RANGE_STORAGE_KEY)
      || window.localStorage.getItem(LEGACY_DASHBOARD_RANGE_STORAGE_KEY)
    if (stored && DASHBOARD_RANGE_KEYS.includes(stored as DashboardTimeRangeKey)) {
      return stored as DashboardTimeRangeKey
    }
  } catch {
    /* localStorage unavailable (private browsing, quota) — use default. */
  }
  return 'last7d'
}

// Locale-aware formatters that respect `config.i18n.locale`. Wrapped in
// the same object shape as Intl.NumberFormat so existing call sites
// (`.format(value)`) keep working after the rebind.
export const formatInteger = { format: (value: number) => i18nFormatNumber(value) }
export const formatCompact = { format: (value: number) => i18nFormatCompact(value) }

export function ArrowUpRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10L10 4" />
      <path d="M5 4H10V9" />
    </svg>
  )
}

export function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round">
      <path d="M7 3v8" />
      <path d="M3 7h8" />
    </svg>
  )
}

export function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.75 4.25h3.2l1.15 1.25h6.15v4.9a1.1 1.1 0 0 1-1.1 1.1H2.85a1.1 1.1 0 0 1-1.1-1.1v-5.05Z" />
      <path d="M1.75 4.2V3.55a1.05 1.05 0 0 1 1.05-1.05h2l1 1.15h1.35" />
    </svg>
  )
}

export function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.25 5.25A4.75 4.75 0 0 0 3.9 3.7" />
      <path d="M11.25 2.75v2.5h-2.5" />
      <path d="M2.75 8.75A4.75 4.75 0 0 0 10.1 10.3" />
      <path d="M2.75 11.25v-2.5h2.5" />
    </svg>
  )
}

export function DatabaseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="7" cy="3" rx="4.25" ry="1.75" />
      <path d="M2.75 3v3.75C2.75 7.72 4.65 8.5 7 8.5s4.25-.78 4.25-1.75V3" />
      <path d="M2.75 6.75v3.25C2.75 10.97 4.65 11.75 7 11.75s4.25-.78 4.25-1.75V6.75" />
    </svg>
  )
}

export function CircuitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="3" cy="3" r="1.1" />
      <circle cx="11" cy="3" r="1.1" />
      <circle cx="7" cy="11" r="1.1" />
      <path d="M4.1 3h2.1L7 5.6V9.9" />
      <path d="M9.9 3H7.8" />
    </svg>
  )
}

export function LightningIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7.75 1.75 3.9 7h2.55L5.8 12.25 10.1 6.9H7.45l.3-5.15Z" />
    </svg>
  )
}

export function LayersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="m7 2 4.75 2.55L7 7.1 2.25 4.55 7 2Z" />
      <path d="m2.25 7 4.75 2.55L11.75 7" />
      <path d="m2.25 9.95 4.75 2.55 4.75-2.55" />
    </svg>
  )
}

export function formatProviderLabel(providerId: string | null | undefined) {
  if (!providerId) return t('provider.none', 'No provider')
  return providerId
    .split(/[-_]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function formatSourceLabel(source: RuntimeInputDiagnostics['providerSource'] | RuntimeInputDiagnostics['modelSource']) {
  switch (source) {
    case 'settings':
      return t('runtime.source.settings', 'Settings override')
    case 'default':
      return t('runtime.source.default', 'Config default')
    default:
      return t('runtime.source.fallback', 'Fallback')
  }
}

export function formatRuntimeOptionValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((entry) => formatRuntimeOptionValue(entry)).join(', ')
  if (value && typeof value === 'object') return JSON.stringify(value)
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

export function formatLeadAgentLabel(agent: BuiltInAgentDetail | null) {
  if (!agent) return t('agent.unknown', 'Unknown')
  return agent.label
}

export function formatThreadPath(directory?: string | null) {
  if (!directory) return t('thread.sandbox', 'Sandbox thread')
  const parts = directory.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || directory
}

export function ratio(value: number, total: number) {
  if (!total || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((value / total) * 100)))
}

export function metricByName(perf: PerfSnapshot | null, name: string) {
  return perf?.distributions.find((metric) => metric.name === name) || null
}

export function counterByName(perf: PerfSnapshot | null, name: string) {
  return perf?.counters.find((metric) => metric.name === name) || null
}

export function formatMetricValue(metric: PerfDistributionSnapshot | null, accessor: 'p95' | 'avg' | 'last' = 'p95') {
  if (!metric || metric.count === 0) return '—'
  const value = metric[accessor]
  if (metric.unit === 'ms') return `${value.toFixed(value >= 10 ? 0 : 1)} ms`
  return formatInteger.format(Math.round(value))
}

export function formatCounterValue(metric: PerfCounterSnapshot | null) {
  if (!metric) return '—'
  return formatCompact.format(metric.value)
}
