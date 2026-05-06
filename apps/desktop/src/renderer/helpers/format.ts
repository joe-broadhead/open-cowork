// Shared formatters for dollar amounts and token counts.
//
// Four different `formatCost` implementations used to live scattered
// across HomePage / StatusBar / session-inspector-utils / mission-control-utils
// with divergent behaviour for zero and sub-cent values — a cost pill
// sitting on a Mission Control lane would read `<$0.01` while the same
// value on the Home dashboard read `$0.00` and in the StatusBar it read
// `$0.0042`. Centralised here with an explicit `style` knob so each
// surface keeps its distinct behaviour but the rule lives in one place.

export type CostStyle =
  // Always shows `$X.XX`. Sub-cent values round to `$0.00`. Use for
  // aggregates on the Home dashboard / totals row / anywhere users
  // expect a plain two-decimal readout.
  | 'default'
  // 4-decimal precision for sub-cent values. Use for numeric-detail
  // surfaces (StatusBar, SessionInspector) where $0.0042 is more
  // informative than `$0.00`.
  | 'precise'
  // Hide zero (returns ''). Sub-cent reads as `<$0.01`. Use for
  // compact in-chat labels like Mission Control lane pills where a
  // `$0.00` chip is visual noise that dominates short lanes.
  | 'compact'

export function formatCost(value: number, style: CostStyle = 'default'): string {
  if (style === 'compact') {
    if (!value) return ''
    if (value < 0.01) return '<$0.01'
    return `$${value.toFixed(2)}`
  }
  if (style === 'precise') {
    if (value === 0) return '$0.00'
    if (value < 0.01) return `$${value.toFixed(4)}`
    return `$${value.toFixed(2)}`
  }
  // default
  return `$${value.toFixed(2)}`
}

// Compact token count — "14k", "1.2M", etc. Shared between Mission
// Control lanes, the drill-in scorecard, and the dashboard's Agent
// usage card.
export function formatTokensCompact(total: number): string {
  if (total <= 0) return ''
  if (total < 1_000) return `${total}`
  if (total < 10_000) return `${(total / 1_000).toFixed(1)}k`
  if (total < 1_000_000) return `${Math.round(total / 1_000)}k`
  return `${(total / 1_000_000).toFixed(1)}M`
}

export function compactDescription(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`
}
