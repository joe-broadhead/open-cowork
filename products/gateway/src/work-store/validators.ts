/**
 * Pure validation/normalization helpers for the work store.
 *
 * Input->output guards with no database, WorkState, config, or singleton access:
 * generic string/number/JSON normalizers used across the work-store mutation
 * surface. Split verbatim out of `work-store.ts` (#199 analytics-queries
 * pattern) with no behavior change — exported names and signatures are identical
 * to their previous `work-store.ts` definitions, and callers reach them here
 * directly. This module intentionally imports nothing from `work-store.ts` so it
 * stays a leaf (no dependency cycle); functions returning work-store-local
 * record/enum types remain in `work-store.ts`.
 */

export function normalizeRequiredString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const text = value.trim()
  if (!text) throw new Error(`${label} is required`)
  return text.substring(0, maxLength)
}

export function normalizeOptionalString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('text field must be a string')
  const text = value.trim()
  return text ? text.substring(0, maxLength) : undefined
}

export function normalizeStringList(values: unknown, maxLength: number): string[] {
  if (values === undefined || values === null) return []
  if (!Array.isArray(values)) throw new Error('list field must be an array')
  return values.map(value => normalizeOptionalString(value, maxLength)).filter(Boolean) as string[]
}

export function normalizeStage(value: unknown, label: string): string {
  const stage = normalizeRequiredString(value, label, 64)
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(stage)) throw new Error(`${label} must be 1-64 letters, numbers, underscores, or dashes`)
  return stage
}

export function normalizeOptionalIdentifier(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return normalizeStage(value, label)
}

export function normalizeProviderId(value: unknown, label: string): string {
  const provider = normalizeRequiredString(value, label, 40).toLowerCase()
  if (!/^[a-z0-9_-]+$/.test(provider)) throw new Error(`${label} must contain only lowercase letters, numbers, _, or -`)
  return provider
}

export function normalizeHash(value: unknown, label: string): string {
  const hash = normalizeRequiredString(value, label, 128).toLowerCase()
  if (!/^[a-f0-9]{32,128}$/.test(hash)) throw new Error(`${label} must be a hex hash`)
  return hash
}

export function normalizeOptionalIsoTime(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO timestamp`)
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`${label} must be an ISO timestamp`)
  return new Date(ms).toISOString()
}

export function normalizeOptionalEventId(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id < 0) throw new Error(`${label} must be a non-negative event cursor`)
  return id
}

export function normalizeJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function normalizeProjectAlias(value: unknown): string {
  if (typeof value !== 'string') throw new Error('project alias must be a string')
  const alias = value.trim().toLowerCase().replace(/[_\s]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 80)
  if (!alias) throw new Error('project alias is required')
  return alias
}

export function normalizePriority(value: unknown): 'HIGH' | 'MEDIUM' | 'LOW' {
  if (value === undefined || value === null || value === '') return 'MEDIUM'
  if (value === 'HIGH' || value === 'MEDIUM' || value === 'LOW') return value
  throw new Error(`priority must be HIGH, MEDIUM, or LOW: ${String(value)}`)
}

export function normalizeAlertEvidence(values: unknown[]): string[] {
  return values.map(value => String(value || '').trim().substring(0, 1000)).filter(Boolean).slice(0, 20)
}

export function normalizeThreadId(threadId?: string | null): string {
  return threadId ? String(threadId) : ''
}
