import { createElement } from 'react'
import type { CloudWebThreadView } from './thread-workbench.ts'

const h = createElement

// The cloud session projection (CloudSessionProjectionView) genuinely carries
// status, isGenerating, sessionCost, sessionTokens, and lastInputTokens. It does
// NOT carry a model name, a model context limit, contextState/compaction, an
// active agent, or an all-sessions total — so this status bar deliberately shows
// only the fields the cloud actually has, rather than faking a context meter or a
// model label. The visual treatment mirrors the desktop StatusBar (status dot +
// label, then a clickable token/cost cluster) using the shared design tokens.

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

// Compact token count — "1.5K", "1.2M" — matching the desktop StatusBar formatter.
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return `${n}`
}

// Precise cost — sub-cent values keep 4 decimals — matching the desktop
// StatusBar's formatCost(value, 'precise') treatment.
function formatCostPrecise(value: number): string {
  if (value === 0) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(2)}`
}

type StatusBarState = {
  isGenerating: boolean
  status: string
  sessionCost: number
  lastInputTokens: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  totalTokens: number
}

export function cloudStatusBarState(view: CloudWebThreadView | null | undefined): StatusBarState {
  const projection = record(view?.projection?.view)
  const rawTokens = record(projection.sessionTokens)
  const tokens = {
    input: numberValue(rawTokens.input),
    output: numberValue(rawTokens.output),
    reasoning: numberValue(rawTokens.reasoning),
    cacheRead: numberValue(rawTokens.cacheRead),
    cacheWrite: numberValue(rawTokens.cacheWrite),
  }
  return {
    isGenerating: Boolean(projection.isGenerating),
    status: String(projection.status || 'idle'),
    sessionCost: numberValue(projection.sessionCost),
    lastInputTokens: numberValue(projection.lastInputTokens),
    tokens,
    totalTokens: tokens.input + tokens.output + tokens.reasoning,
  }
}

function usageDetailRow(label: string, value: string) {
  return h('div', { className: 'statusbar-detail-row', key: label },
    h('span', { className: 'statusbar-detail-label' }, label),
    h('span', { className: 'statusbar-detail-value' }, value))
}

export function CloudStatusBar({ view }: { view: CloudWebThreadView | null | undefined }) {
  const state = cloudStatusBarState(view)
  const dotClass = state.isGenerating
    ? 'studio-status-dot--live'
    : state.status === 'errored'
      ? 'studio-status-dot--error'
      : 'studio-status-dot--idle'
  const statusLabel = state.isGenerating
    ? 'Working...'
    : state.status === 'errored'
      ? 'Error'
      : 'Ready'

  const detailRows = [
    usageDetailRow('Input tokens', formatTokens(state.tokens.input)),
    usageDetailRow('Output tokens', formatTokens(state.tokens.output)),
    state.tokens.reasoning > 0 ? usageDetailRow('Reasoning', formatTokens(state.tokens.reasoning)) : null,
    state.tokens.cacheRead > 0 ? usageDetailRow('Cache read', formatTokens(state.tokens.cacheRead)) : null,
    state.tokens.cacheWrite > 0 ? usageDetailRow('Cache write', formatTokens(state.tokens.cacheWrite)) : null,
    state.lastInputTokens > 0 ? usageDetailRow('Last measured input', formatTokens(state.lastInputTokens)) : null,
    usageDetailRow('Session cost', formatCostPrecise(state.sessionCost)),
  ].filter(Boolean)

  return h('div', { className: 'statusbar-inner', 'aria-label': 'Session status' },
    h('span', { className: 'statusbar-status' },
      h('span', { className: `studio-status-dot ${dotClass}`, 'aria-hidden': true }),
      h('span', { className: 'statusbar-status-label' }, statusLabel)),
    state.totalTokens > 0
      ? h('details', { className: 'statusbar-usage' },
          h('summary', { className: 'statusbar-usage-summary' },
            h('span', null, `${formatTokens(state.totalTokens)} tokens`),
            h('span', { className: 'statusbar-divider', 'aria-hidden': true }, '|'),
            h('span', null, formatCostPrecise(state.sessionCost))),
          h('div', { className: 'statusbar-detail' },
            h('div', { className: 'statusbar-detail-title' }, 'Session Usage'),
            detailRows))
      : null)
}
