import type {
  ManagedDesktopPolicy,
  ManagedDesktopPolicyView,
  ManagedPolicyDisabledControls,
  ManagedPolicyExtensionClasses,
  ManagedPolicyKeyManagement,
  ManagedPolicyPermissionCeiling,
  ManagedPolicyPermissionCeilings,
  ManagedPolicyPermissionDimension,
} from '@open-cowork/shared'
import {
  MANAGED_POLICY_DISABLED_REASON,
  MANAGED_POLICY_KEY_MANAGEMENT_VALUES,
  MANAGED_POLICY_PERMISSION_DIMENSIONS,
} from '@open-cowork/shared'
import type { AuditActorInput } from './control-plane-account-inputs.ts'

// The org-managed workspace & desktop policy model (#898). Pure types + pure
// normalization/merge helpers only, so the store contract, both store
// implementations, the policy service, and the delivery route can share one
// authoritative model — mirroring how control-plane-permissions.ts owns the RBAC
// vocabulary. A policy is a single org-scoped record; a "set" merges a partial input
// onto the current record (or the unrestricted defaults when none exists), so an
// admin can tighten one control without restating the whole policy.

export type ManagedPolicyRecord = ManagedDesktopPolicy & {
  orgId: string
  createdAt: string
  updatedAt: string
}

// A partial update: every enforcement field is optional. An omitted field is left
// unchanged; a nullable allow-list may be set to null to clear it back to
// unrestricted, or to an array to constrain it.
export type SetManagedPolicyInput = {
  orgId: string
  allowedProviders?: readonly string[] | null
  deniedProviders?: readonly string[]
  allowedModels?: readonly string[] | null
  deniedModels?: readonly string[]
  keyManagement?: string | null
  extensions?: Partial<ManagedPolicyExtensionClasses> | null
  features?: Record<string, unknown> | null
  permissionCeilings?: Partial<Record<string, unknown>> | null
  updateChannel?: string | null
  updatedAt?: Date
  actor?: AuditActorInput
}

const UPDATE_CHANNEL_MAX_LENGTH = 64
const LIST_ENTRY_MAX_LENGTH = 200
const MAX_LIST_ENTRIES = 500
const FEATURE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/

const KEY_MANAGEMENT_SET = new Set<string>(MANAGED_POLICY_KEY_MANAGEMENT_VALUES)
const PERMISSION_CEILING_SET = new Set<ManagedPolicyPermissionCeiling>(['allow', 'ask', 'deny'])
const PERMISSION_DIMENSION_SET = new Set<string>(MANAGED_POLICY_PERMISSION_DIMENSIONS)

function defaultCeilings(): ManagedPolicyPermissionCeilings {
  const ceilings = {} as ManagedPolicyPermissionCeilings
  for (const dimension of MANAGED_POLICY_PERMISSION_DIMENSIONS) ceilings[dimension] = 'allow'
  return ceilings
}

// The unrestricted baseline: what an org (or an individual with no org) has when no
// policy is set. Every helper composes onto this so "no policy" is a real value.
export const DEFAULT_MANAGED_POLICY: ManagedDesktopPolicy = {
  allowedProviders: null,
  deniedProviders: [],
  allowedModels: null,
  deniedModels: [],
  keyManagement: 'any',
  extensions: { customProviders: true, customMcps: true, customSkills: true },
  features: {},
  permissionCeilings: defaultCeilings(),
  updateChannel: null,
}

export function isManagedPolicyPermissionCeiling(value: unknown): value is ManagedPolicyPermissionCeiling {
  return typeof value === 'string' && PERMISSION_CEILING_SET.has(value as ManagedPolicyPermissionCeiling)
}

function normalizeCeiling(value: unknown, label: string): ManagedPolicyPermissionCeiling {
  if (!isManagedPolicyPermissionCeiling(value)) {
    throw new Error(`${label} must be one of "allow", "ask" or "deny".`)
  }
  return value
}

function normalizeKeyManagement(value: unknown): ManagedPolicyKeyManagement {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!KEY_MANAGEMENT_SET.has(text)) {
    throw new Error(`Policy keyManagement must be one of ${MANAGED_POLICY_KEY_MANAGEMENT_VALUES.join(', ')}.`)
  }
  return text as ManagedPolicyKeyManagement
}

function normalizeIdList(values: readonly unknown[], label: string): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') throw new Error(`${label} entries must be strings.`)
    const trimmed = value.trim()
    if (!trimmed) continue
    if (trimmed.length > LIST_ENTRY_MAX_LENGTH) throw new Error(`${label} entry is too long.`)
    seen.add(trimmed)
    if (seen.size > MAX_LIST_ENTRIES) throw new Error(`${label} has too many entries.`)
  }
  return [...seen].sort()
}

// A nullable allow-list: null means "unrestricted", an array constrains. Callers pass
// undefined to leave it unchanged (handled by the merge, not here).
function normalizeAllowList(value: readonly unknown[] | null, label: string): string[] | null {
  if (value === null) return null
  if (!Array.isArray(value)) throw new Error(`${label} must be an array or null.`)
  return normalizeIdList(value, label)
}

function normalizeDenyList(value: readonly unknown[], label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`)
  return normalizeIdList(value, label)
}

function normalizeExtensions(
  existing: ManagedPolicyExtensionClasses,
  patch: Partial<ManagedPolicyExtensionClasses>,
): ManagedPolicyExtensionClasses {
  const next: ManagedPolicyExtensionClasses = { ...existing }
  for (const key of ['customProviders', 'customMcps', 'customSkills'] as const) {
    const value = patch[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') throw new Error(`Policy extensions.${key} must be a boolean.`)
    next[key] = value
  }
  return next
}

function normalizeFeatures(value: Record<string, unknown>): Record<string, boolean> {
  const features: Record<string, boolean> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!FEATURE_KEY_PATTERN.test(key)) throw new Error(`Policy feature key "${key}" is invalid.`)
    if (typeof raw !== 'boolean') throw new Error(`Policy feature "${key}" must be a boolean.`)
    features[key] = raw
  }
  return features
}

function normalizeCeilings(
  existing: ManagedPolicyPermissionCeilings,
  patch: Partial<Record<string, unknown>>,
): ManagedPolicyPermissionCeilings {
  const next: ManagedPolicyPermissionCeilings = { ...existing }
  for (const [dimension, value] of Object.entries(patch)) {
    if (!PERMISSION_DIMENSION_SET.has(dimension)) {
      throw new Error(`Policy permission ceiling "${dimension}" is not a known permission dimension.`)
    }
    next[dimension as ManagedPolicyPermissionDimension] = normalizeCeiling(value, `Policy ceiling "${dimension}"`)
  }
  return next
}

function normalizeUpdateChannel(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed.length > UPDATE_CHANNEL_MAX_LENGTH) throw new Error('Policy updateChannel is too long.')
  return trimmed
}

// Merge a partial input onto a base policy (the current record's fields, or the
// unrestricted defaults). Only fields present on the input change; each is validated.
export function applyManagedPolicyInput(
  base: ManagedDesktopPolicy,
  input: SetManagedPolicyInput,
): ManagedDesktopPolicy {
  return {
    allowedProviders: input.allowedProviders === undefined
      ? base.allowedProviders
      : normalizeAllowList(input.allowedProviders, 'allowedProviders'),
    deniedProviders: input.deniedProviders === undefined
      ? base.deniedProviders
      : normalizeDenyList(input.deniedProviders, 'deniedProviders'),
    allowedModels: input.allowedModels === undefined
      ? base.allowedModels
      : normalizeAllowList(input.allowedModels, 'allowedModels'),
    deniedModels: input.deniedModels === undefined
      ? base.deniedModels
      : normalizeDenyList(input.deniedModels, 'deniedModels'),
    keyManagement: input.keyManagement === undefined || input.keyManagement === null
      ? base.keyManagement
      : normalizeKeyManagement(input.keyManagement),
    extensions: input.extensions === undefined || input.extensions === null
      ? base.extensions
      : normalizeExtensions(base.extensions, input.extensions),
    features: input.features === undefined || input.features === null
      ? base.features
      : normalizeFeatures(input.features),
    permissionCeilings: input.permissionCeilings === undefined || input.permissionCeilings === null
      ? base.permissionCeilings
      : normalizeCeilings(base.permissionCeilings, input.permissionCeilings),
    updateChannel: input.updateChannel === undefined
      ? base.updateChannel
      : normalizeUpdateChannel(input.updateChannel),
  }
}

// The effective enforcement policy for an org: the stored record, or the unrestricted
// defaults when none is set. Individuals with no org resolve to the defaults too.
export function effectiveManagedPolicy(record: ManagedPolicyRecord | null): ManagedDesktopPolicy {
  if (!record) return { ...DEFAULT_MANAGED_POLICY, permissionCeilings: { ...DEFAULT_MANAGED_POLICY.permissionCeilings } }
  return {
    allowedProviders: record.allowedProviders,
    deniedProviders: record.deniedProviders,
    allowedModels: record.allowedModels,
    deniedModels: record.deniedModels,
    keyManagement: record.keyManagement,
    extensions: record.extensions,
    features: record.features,
    permissionCeilings: record.permissionCeilings,
    updateChannel: record.updateChannel,
  }
}

// The machine-readable "Managed by your organization" transparency signal: the set of
// controls a policy actively restricts relative to the unrestricted baseline. A UI
// hint renders reason strings from this; enforcement uses the policy fields directly.
export function managedPolicyDisabledControls(policy: ManagedDesktopPolicy): ManagedPolicyDisabledControls {
  const controls: ManagedPolicyDisabledControls = {}
  const mark = (id: string) => { controls[id] = { disabledByPolicy: true, reason: MANAGED_POLICY_DISABLED_REASON } }
  for (const dimension of MANAGED_POLICY_PERMISSION_DIMENSIONS) {
    if (policy.permissionCeilings[dimension] !== 'allow') mark(dimension)
  }
  if (policy.allowedProviders !== null || policy.deniedProviders.length > 0) mark('providers')
  if (policy.allowedModels !== null || policy.deniedModels.length > 0) mark('models')
  if (!policy.extensions.customProviders) mark('customProviders')
  if (!policy.extensions.customMcps) mark('customMcps')
  if (!policy.extensions.customSkills) mark('customSkills')
  if (policy.keyManagement !== 'any') mark('keyManagement')
  if (policy.updateChannel !== null) mark('updateChannel')
  return controls
}

// The delivered view: the effective policy plus its transparency map.
export function toManagedDesktopPolicyView(record: ManagedPolicyRecord | null): ManagedDesktopPolicyView {
  const policy = effectiveManagedPolicy(record)
  return { ...policy, disabledByPolicy: managedPolicyDisabledControls(policy) }
}
