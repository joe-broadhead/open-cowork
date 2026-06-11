import type {
  CoordinationTarget,
  CoordinationWatch,
  CoordinationWatchChannel,
  CoordinationWatchEventType,
  CoordinationWatchInput,
  CoordinationWatchRecipient,
  CoordinationWatchRecipientRole,
  CoordinationWatchStatus,
  CoordinationWatchUpdateInput,
  CoordinationWatchVerbosity,
} from '@open-cowork/shared'
import {
  WORKSPACE_PRODUCT_SURFACES,
  isCoordinationWatchEvent,
  isCoordinationWatchRecipientRole,
  isCoordinationWatchStatus,
  isCoordinationWatchTarget,
  isCoordinationWatchVerbosity,
} from '@open-cowork/shared'

const MAX_TEXT_BYTES = 32 * 1024
const MAX_TITLE_BYTES = 240
const MAX_AGENT_ID_BYTES = 256
const MAX_WATCH_EVENTS = 16
const MAX_CHANNEL_TARGET_BYTES = 16 * 1024

export type CreateCloudCoordinationWatchInput = CoordinationWatchInput & {
  workspaceId: string
  watchId?: string | null
  createdAt?: Date
}

export type UpdateCloudCoordinationWatchInput = {
  workspaceId: string
  watchId: string
  patch: CoordinationWatchUpdateInput
  updatedAt?: Date
}

export type ListCloudCoordinationWatchesInput = {
  workspaceId: string
  target?: CoordinationTarget | null
  status?: CoordinationWatchStatus | null
  limit?: number | null
}

export type ListMatchingCloudCoordinationWatchesInput = {
  workspaceId: string
  eventType: CoordinationWatchEventType
  targets: readonly CoordinationTarget[]
  limit?: number | null
}

function nowIso(now?: Date) {
  return (now || new Date()).toISOString()
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).length
}

function stringValue(value: unknown, label: string, options: { required?: boolean; maxBytes?: number } = {}) {
  if (value === undefined || value === null) {
    if (options.required) throw new Error(`${label} is required.`)
    return null
  }
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const trimmed = value.trim()
  if (!trimmed) {
    if (options.required) throw new Error(`${label} is required.`)
    return null
  }
  const maxBytes = options.maxBytes || MAX_TEXT_BYTES
  if (byteLength(trimmed) > maxBytes) throw new Error(`${label} is too large.`)
  return trimmed
}

function optionalString(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  return stringValue(value, label, { maxBytes })
}

function requiredString(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  return stringValue(value, label, { required: true, maxBytes })!
}

function jsonString(value: unknown, label: string, maxBytes = MAX_TEXT_BYTES) {
  const json = JSON.stringify(value)
  if (byteLength(json) > maxBytes) throw new Error(`${label} is too large.`)
  return json
}

function normalizeWorkspaceId(value: unknown) {
  return requiredString(value, 'Watch workspace id', 512)
}

function normalizeWatchTarget(value: unknown): CoordinationTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Watch target is required.')
  const record = value as Record<string, unknown>
  if (!isCoordinationWatchTarget(record.kind)) throw new Error('Watch target kind is invalid.')
  return {
    kind: record.kind,
    id: requiredString(record.id, 'Watch target id', 512),
  }
}

function normalizeWatchEvents(value: unknown): CoordinationWatchEventType[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Watch events must be a non-empty array.')
  const unique = new Set<CoordinationWatchEventType>()
  for (const entry of value) {
    if (!isCoordinationWatchEvent(entry)) throw new Error('Watch event is invalid.')
    unique.add(entry)
  }
  return Array.from(unique).slice(0, MAX_WATCH_EVENTS)
}

function normalizeWatchStatus(value: unknown, fallback: CoordinationWatchStatus): CoordinationWatchStatus {
  if (value === undefined || value === null) return fallback
  if (!isCoordinationWatchStatus(value)) throw new Error('Watch status is invalid.')
  return value
}

function normalizeWatchVerbosity(value: unknown, fallback: CoordinationWatchVerbosity): CoordinationWatchVerbosity {
  if (value === undefined || value === null) return fallback
  if (!isCoordinationWatchVerbosity(value)) throw new Error('Watch verbosity is invalid.')
  return value
}

function normalizeWatchDeliverySurface(value: unknown, fallback: CoordinationWatch['deliverySurface']): CoordinationWatch['deliverySurface'] {
  if (value === undefined || value === null) return fallback
  if (value === 'gateway_channel' || WORKSPACE_PRODUCT_SURFACES.includes(value as (typeof WORKSPACE_PRODUCT_SURFACES)[number])) {
    return value as CoordinationWatch['deliverySurface']
  }
  throw new Error('Watch delivery surface is invalid.')
}

function normalizeWatchRecipientRole(value: unknown): CoordinationWatchRecipientRole | null {
  if (value === undefined || value === null) return null
  if (!isCoordinationWatchRecipientRole(value)) throw new Error('Watch recipient role is invalid.')
  return value
}

function normalizeWatchChannel(value: unknown): CoordinationWatchChannel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Watch channel is required.')
  const record = value as Record<string, unknown>
  const target = record.target
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new Error('Watch channel target is required.')
  const normalized: CoordinationWatchChannel = {
    provider: requiredString(record.provider, 'Watch channel provider', 128),
    agentId: requiredString(record.agentId, 'Watch channel agent id', MAX_AGENT_ID_BYTES),
    channelBindingId: requiredString(record.channelBindingId, 'Watch channel binding id', 512),
    sessionBindingId: optionalString(record.sessionBindingId, 'Watch channel session binding id', 512),
    target: target as Record<string, unknown>,
  }
  jsonString(normalized.target, 'Watch channel target', MAX_CHANNEL_TARGET_BYTES)
  return normalized
}

function normalizeWatchRecipient(value: unknown): CoordinationWatchRecipient | null {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Watch recipient must be an object.')
  const record = value as Record<string, unknown>
  const recipient: CoordinationWatchRecipient = {
    identityId: optionalString(record.identityId, 'Watch recipient identity id', 512),
    role: normalizeWatchRecipientRole(record.role),
    label: optionalString(record.label, 'Watch recipient label', MAX_TITLE_BYTES),
  }
  return recipient.identityId || recipient.role || recipient.label ? recipient : null
}

function normalizeWatchCursor(value: unknown): string | number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return optionalString(value, 'Watch cursor', 512)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  throw new Error('Watch cursor must be a string, number, or null.')
}

export function normalizeCloudCoordinationWatchLimit(value: number | null | undefined, fallback = 500, max = 1000) {
  return Number.isInteger(value) && Number(value) > 0 ? Math.min(Number(value), max) : fallback
}

export function createCloudCoordinationWatchRecord(input: CreateCloudCoordinationWatchInput): CoordinationWatch {
  const createdAt = nowIso(input.createdAt)
  const workspaceId = normalizeWorkspaceId(input.workspaceId)
  return {
    id: input.watchId?.trim() || crypto.randomUUID(),
    kind: 'watch',
    workspaceId,
    ownerAuthority: 'cloud_channel_gateway',
    executionAuthority: 'cloud_channel_gateway',
    stateOwner: 'cloud_control_plane',
    target: normalizeWatchTarget(input.target),
    events: normalizeWatchEvents(input.events),
    channel: normalizeWatchChannel(input.channel),
    recipient: normalizeWatchRecipient(input.recipient),
    status: normalizeWatchStatus(input.status, 'active'),
    deliverySurface: normalizeWatchDeliverySurface(input.deliverySurface, 'gateway_channel'),
    verbosity: normalizeWatchVerbosity(input.verbosity, 'normal'),
    cursor: normalizeWatchCursor(input.cursor),
    createdAt,
    updatedAt: createdAt,
  }
}

export function updateCloudCoordinationWatchRecord(
  existing: CoordinationWatch,
  patch: CoordinationWatchUpdateInput,
  updatedAt?: Date,
): CoordinationWatch {
  return {
    ...existing,
    target: patch.target === undefined ? existing.target : normalizeWatchTarget(patch.target),
    events: patch.events === undefined ? existing.events : normalizeWatchEvents(patch.events),
    channel: patch.channel === undefined ? existing.channel : normalizeWatchChannel(patch.channel),
    recipient: patch.recipient === undefined ? existing.recipient ?? null : normalizeWatchRecipient(patch.recipient),
    status: patch.status === undefined ? existing.status : normalizeWatchStatus(patch.status, existing.status),
    deliverySurface: normalizeWatchDeliverySurface(patch.deliverySurface, existing.deliverySurface),
    verbosity: patch.verbosity === undefined ? existing.verbosity : normalizeWatchVerbosity(patch.verbosity, existing.verbosity),
    cursor: patch.cursor === undefined ? existing.cursor ?? null : normalizeWatchCursor(patch.cursor),
    updatedAt: nowIso(updatedAt),
  }
}

export function cloudCoordinationWatchMatchesEvent(
  watch: CoordinationWatch,
  input: ListMatchingCloudCoordinationWatchesInput,
) {
  if (watch.workspaceId !== input.workspaceId) return false
  if (watch.status !== 'active') return false
  if (!watch.events.includes(input.eventType)) return false
  return input.targets.some((target) => target.kind === watch.target.kind && target.id === watch.target.id)
}
