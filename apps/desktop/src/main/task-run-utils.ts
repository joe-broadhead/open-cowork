const GENERIC_TASK_TITLES = new Set(['task', 'sub-agent task', 'sub agent task'])

export function toIsoTimestamp(value?: number) {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
  const ms = raw < 1_000_000_000_000 ? raw * 1000 : raw
  return new Date(ms).toISOString()
}

export function normalizeAgentName(value?: unknown) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const match = trimmed.match(/@([\w-]+)(?:\s+sub-?agent)?/i)
  if (match?.[1]) return match[1].toLowerCase()
  if (/^[\w-]+$/.test(trimmed)) return trimmed.toLowerCase()
  return null
}

export function extractAgentName(...candidates: unknown[]) {
  for (const candidate of candidates) {
    const normalized = normalizeAgentName(candidate)
    if (normalized) return normalized
  }
  return null
}

export function formatAgentLabel(agent?: string | null) {
  if (!agent) return 'Sub-Agent'
  return agent
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function stripAgentAnnotation(value: string) {
  return value
    .replace(/\(\s*@[\w-]+(?:\s+sub-?agent)?\s*\)/gi, ' ')
    .replace(/^\s*@[\w-]+(?:\s+sub-?agent)?\s*[:\-]?\s*/i, '')
    .replace(/\s+\(?@[\w-]+(?:\s+sub-?agent)?\s*\)?$/i, ' ')
}

export function normalizeTaskTitle(value?: unknown) {
  if (typeof value !== 'string') return null
  const cleaned = stripAgentAnnotation(value)
    .replace(/\s+/g, ' ')
    .trim()

  if (!cleaned) return null
  if (cleaned.toLowerCase() === 'sub-agent') return null
  if (GENERIC_TASK_TITLES.has(cleaned.toLowerCase())) return null
  if (cleaned.length <= 72) return cleaned
  return `${cleaned.slice(0, 69).trimEnd()}...`
}

export function isPlaceholderTaskTitle(value?: unknown, agent?: string | null) {
  const normalized = normalizeTaskTitle(value)
  if (!normalized) return true
  if (normalized.toLowerCase() === formatAgentLabel(agent).toLowerCase()) return true
  return false
}

export function chooseTaskTitle(agent?: string | null, ...candidates: unknown[]) {
  for (const candidate of candidates) {
    const normalized = normalizeTaskTitle(candidate)
    if (normalized) return normalized
  }
  return formatAgentLabel(agent)
}
