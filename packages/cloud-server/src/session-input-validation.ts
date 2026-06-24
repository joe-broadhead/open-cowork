import { createHash } from 'node:crypto'
import { CloudServiceError } from './cloud-service-error.ts'
import type { ControlPlaneMembershipStatus, ControlPlaneRole } from './control-plane-store.ts'

// Pure input-validation / normalization primitives for the cloud session
// service: coerce a plain record, read a trimmed/non-empty string (with fallback
// or nullable), bound a required/optional string to a max length, test allow-list
// membership, normalize control-plane role / membership status to the enum, mint
// a stable content-hashed id, and clamp a list limit. Extracted from
// session-service.ts; depends only on the role/status enums + node:crypto.

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function readString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value : fallback
}

export function readNullableString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function boundedText(value: unknown, label: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`)
  return normalized
}

export function boundedOptionalText(value: unknown, label: string, maxLength: number) {
  if (value === undefined || value === null || value === '') return null
  return boundedText(value, label, maxLength)
}

export function includesAllowed(value: string | null | undefined, allowed: string[] | null) {
  return !allowed || Boolean(value && allowed.includes(value))
}

export function normalizeEmailAddress(value: unknown) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new CloudServiceError(400, 'A valid member email address is required.')
  }
  return email
}

export function normalizeControlPlaneRole(value: unknown, fallback: ControlPlaneRole = 'member'): ControlPlaneRole {
  if (value === 'owner' || value === 'admin' || value === 'member') return value
  return fallback
}

export function normalizeMembershipStatus(
  value: unknown,
  fallback: ControlPlaneMembershipStatus = 'active',
): ControlPlaneMembershipStatus {
  if (value === 'active' || value === 'invited' || value === 'disabled') return value
  return fallback
}

export function stableCloudId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

export function normalizedCloudListLimit(value: number | null | undefined, fallback = 100, max = 500) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(max, Math.floor(value || fallback)))
}
