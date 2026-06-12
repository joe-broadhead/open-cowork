import { DEFAULT_TOOL_TRACE_RULES, type CustomMcpConfig, type ToolTraceMatcher, type ToolTraceRule } from '@open-cowork/shared'

type ToolNameLike = {
  name: string
}

export type ParsedChartOutput =
  | { type: 'vega-lite' | 'vega'; spec: Record<string, unknown>; title?: string }
  | { type: 'mermaid'; diagram: string; title?: string }

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export const AGENT_LABELS: Record<string, string> = {
  build: 'Build',
  general: 'General',
  plan: 'Plan',
  'chief-of-staff': 'Cleo',
  explore: 'Explore',
}

export const SUB_AGENT_IDS = new Set(['general', 'explore'])

export function tryParseChartOutput(output: unknown): ParsedChartOutput | null {
  if (!output) return null

  let parsed: any = output
  if (typeof output === 'string') {
    try {
      parsed = JSON.parse(output)
    } catch {
      return null
    }
  }

  if ((parsed?.type === 'vega-lite' || parsed?.type === 'vega') && parsed?.spec) {
    if (typeof parsed.spec === 'string') {
      try {
        const spec = asObjectRecord(JSON.parse(parsed.spec))
        if (!spec) return null
        return {
          ...parsed,
          spec,
        }
      } catch {
        return null
      }
    }
    const spec = asObjectRecord(parsed.spec)
    if (!spec) return null
    return {
      ...parsed,
      spec,
    }
  }

  if (parsed?.type === 'mermaid' && parsed?.diagram) return parsed
  return null
}

const FALLBACK_TOOL_TRACE_RULE: ToolTraceRule = {
  id: 'tool call',
  label: 'tool call',
  pluralLabel: 'tool calls',
  match: [],
}

function normalizedList(values?: readonly string[]) {
  return (values || [])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
}

function matcherMatches(name: string, matcher: ToolTraceMatcher) {
  const exact = normalizedList(matcher.exact)
  const prefixes = normalizedList(matcher.prefixes)
  const contains = normalizedList(matcher.contains)
  if (exact.length === 0 && prefixes.length === 0 && contains.length === 0) return false
  if (exact.length > 0 && !exact.includes(name)) return false
  if (prefixes.length > 0 && !prefixes.some((prefix) => name.startsWith(prefix))) return false
  if (contains.length > 0 && !contains.some((needle) => name.includes(needle))) return false
  return true
}

function normalizedRules(rules?: readonly ToolTraceRule[]) {
  return rules?.length ? rules : DEFAULT_TOOL_TRACE_RULES
}

function toolTraceRuleForName(rawName: string, rules?: readonly ToolTraceRule[]) {
  const name = rawName.trim().toLowerCase()
  return normalizedRules(rules).find((rule) => {
    return rule.match.some((matcher) => matcherMatches(name, matcher))
  }) || FALLBACK_TOOL_TRACE_RULE
}

function pluralLabel(rule: ToolTraceRule) {
  return rule.pluralLabel || `${rule.label}s`
}

export function summarizeTools(tools: ToolNameLike[], rules?: readonly ToolTraceRule[]): string {
  const counts = new Map<string, { rule: ToolTraceRule; count: number }>()
  for (const tool of tools) {
    const rule = toolTraceRuleForName(tool.name, rules)
    const current = counts.get(rule.id)
    if (current) {
      current.count += 1
    } else {
      counts.set(rule.id, { rule, count: 1 })
    }
  }

  return Array.from(counts.values())
    .map(({ rule, count }) => `${count} ${count === 1 ? rule.label : pluralLabel(rule)}`)
    .join(', ')
}

export function buildCustomMcpToolTraceRules(mcps: readonly Pick<CustomMcpConfig, 'name' | 'label' | 'traceLabel' | 'tracePluralLabel'>[]): ToolTraceRule[] {
  return mcps
    .map((mcp): ToolTraceRule | null => {
      const name = mcp.name.trim()
      if (!name) return null
      const fallbackLabel = `${(mcp.label || name).trim()} tool`
      const label = mcp.traceLabel?.trim() || fallbackLabel
      return {
        id: `custom-mcp:${name}`,
        label,
        pluralLabel: mcp.tracePluralLabel?.trim() || `${label}s`,
        match: [{ prefixes: [`mcp__${name}__`, `${name}_`] }],
      }
    })
    .filter((rule): rule is ToolTraceRule => Boolean(rule))
}
