type ContextMessage = {
  role: string
  content: string
}

export type ContextBreakdownItem = {
  id: 'user' | 'assistant' | 'tool' | 'other'
  label: string
  color: string
  value: number
}

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  google: 'Google',
  gemini: 'Google',
  databricks: 'Databricks',
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return `${value}`
}

export function formatInteger(value: number): string {
  return new Intl.NumberFormat().format(value)
}

// SessionInspector uses the `'precise'` style (4-decimal readout for
// sub-cent values). Wraps the shared helper so callers within this
// module don't have to remember the style argument.
import { formatCost as sharedFormatCost } from '../../helpers/format.ts'
export function formatCost(value: number): string {
  return sharedFormatCost(value, 'precise')
}

export function formatProviderLabel(providerId: string | null | undefined) {
  if (!providerId) return 'Unknown'
  return PROVIDER_LABELS[providerId] || providerId.charAt(0).toUpperCase() + providerId.slice(1)
}

export function formatModelLabel(modelId: string | null | undefined) {
  if (!modelId) return 'Unknown'
  return modelId
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Unknown'
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function estimateTokensFromText(value: string) {
  const normalized = value.trim()
  if (!normalized) return 0
  return Math.max(1, Math.round(normalized.length / 4))
}

export function serializeToolPayload(value: unknown) {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value ?? '')
  }
}

export function computeBreakdown(input: {
  messages: ContextMessage[]
  toolPayloads: string[]
  totalContextTokens: number
}): ContextBreakdownItem[] {
  const user = input.messages
    .filter((message) => message.role === 'user')
    .reduce((sum, message) => sum + estimateTokensFromText(message.content), 0)
  const assistant = input.messages
    .filter((message) => message.role === 'assistant')
    .reduce((sum, message) => sum + estimateTokensFromText(message.content), 0)
  const tool = input.toolPayloads
    .reduce((sum, payload) => sum + estimateTokensFromText(payload), 0)

  const total = input.totalContextTokens
  if (total <= 0) {
    return [
      { id: 'user', label: 'User', color: 'var(--color-green)', value: 0 },
      { id: 'assistant', label: 'Assistant', color: 'var(--color-accent)', value: 0 },
      { id: 'tool', label: 'Tool Calls', color: 'var(--color-amber)', value: 0 },
      { id: 'other', label: 'Other', color: 'var(--color-text-muted)', value: 0 },
    ]
  }

  let breakdown: ContextBreakdownItem[] = [
    { id: 'user', label: 'User', color: 'var(--color-green)', value: user },
    { id: 'assistant', label: 'Assistant', color: 'var(--color-accent)', value: assistant },
    { id: 'tool', label: 'Tool Calls', color: 'var(--color-amber)', value: tool },
  ]
  const estimated = breakdown.reduce((sum, item) => sum + item.value, 0)
  if (estimated > total) {
    const scale = total / estimated
    breakdown = breakdown.map((item) => ({
      ...item,
      value: Math.round(item.value * scale),
    }))
  }

  const attributed = breakdown.reduce((sum, item) => sum + item.value, 0)
  return [
    ...breakdown,
    { id: 'other', label: 'Other', color: 'var(--color-text-muted)', value: Math.max(0, total - attributed) },
  ]
}
