import { createHash } from 'node:crypto'
import type {
  ChannelIdentityRecord,
  ChannelIdentityRole,
  ChannelIdentityStatus,
  UpsertChannelIdentityInput,
  ListChannelIdentitiesInput,
} from '../in-memory-control-plane-store.ts'
import type { ChannelProviderId } from '../channel-provider-types.ts'
import { channelScopeKey, normalizeChannelProviderId as normalizeProvider } from '../channel-provider-utils.ts'

const CHANNEL_TEXT_MAX_LENGTH = 256
const CHANNEL_METADATA_MAX_BYTES = 16_384
const CHANNEL_IDENTITY_ROLES = new Set<ChannelIdentityRole>(['owner', 'admin', 'member', 'approver', 'viewer'])
const CHANNEL_IDENTITY_STATUSES = new Set<ChannelIdentityStatus>(['active', 'disabled', 'pending'])

type InMemoryChannelIdentitiesHost = {
  orgExists(orgId: string): boolean
  accountExists(accountId: string): boolean
}

export class InMemoryChannelIdentitiesDomain {
  private readonly identities = new Map<string, ChannelIdentityRecord>()
  private readonly identitiesByExternal = new Map<string, string>()
  private readonly host: InMemoryChannelIdentitiesHost

  constructor(host: InMemoryChannelIdentitiesHost) {
    this.host = host
  }

  upsert(input: UpsertChannelIdentityInput): ChannelIdentityRecord {
    if (!this.host.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    if (input.accountId && !this.host.accountExists(input.accountId)) throw new Error(`Unknown account ${input.accountId}.`)
    const provider = normalizeProvider(input.provider)
    const externalWorkspaceId = normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id')
    const externalUserId = normalizeText(input.externalUserId, CHANNEL_TEXT_MAX_LENGTH, 'External user id')
    const externalKey = key(input.orgId, channelScopeKey(provider, externalWorkspaceId, externalUserId))
    const existingId = this.identitiesByExternal.get(externalKey)
    const existing = existingId ? this.identities.get(existingId) : null
    const now = nowIso(input.updatedAt)
    const record: ChannelIdentityRecord = {
      identityId: existing?.identityId || input.identityId || stableId('chid', input.orgId, provider, externalWorkspaceId || '', externalUserId),
      orgId: input.orgId,
      provider,
      externalWorkspaceId,
      externalUserId,
      accountId: input.accountId === undefined ? existing?.accountId || null : input.accountId || null,
      role: input.role === undefined ? existing?.role || 'viewer' : normalizeChannelIdentityRole(input.role),
      status: input.status || existing?.status || 'pending',
      metadata: input.metadata === undefined ? existing?.metadata || {} : normalizeRecord(input.metadata, 'Channel identity metadata'),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    this.identities.set(record.identityId, record)
    this.identitiesByExternal.set(externalKey, record.identityId)
    return clone(record)
  }

  get(orgId: string, identityId: string): ChannelIdentityRecord | null {
    const identity = this.identities.get(identityId)
    return identity && identity.orgId === orgId ? clone(identity) : null
  }

  list(orgId: string, input: ListChannelIdentitiesInput = {}): ChannelIdentityRecord[] {
    const provider = input.provider ? normalizeProvider(input.provider) : null
    const externalWorkspaceId = input.externalWorkspaceId === undefined
      ? undefined
      : normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id')
    const role = input.role ? normalizeChannelIdentityRole(input.role) : null
    const status = input.status && CHANNEL_IDENTITY_STATUSES.has(input.status) ? input.status : null
    const limit = Number.isInteger(input.limit) && Number(input.limit) > 0 ? Math.min(Number(input.limit), 500) : 100
    return Array.from(this.identities.values())
      .filter((identity) => identity.orgId === orgId)
      .filter((identity) => !provider || identity.provider === provider)
      .filter((identity) => externalWorkspaceId === undefined || identity.externalWorkspaceId === externalWorkspaceId)
      .filter((identity) => !role || identity.role === role)
      .filter((identity) => !status || identity.status === status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.identityId.localeCompare(right.identityId))
      .slice(0, limit)
      .map((identity) => clone(identity))
  }

  find(input: {
    orgId: string
    provider: ChannelProviderId
    externalWorkspaceId?: string | null
    externalUserId: string
  }): ChannelIdentityRecord | null {
    const provider = normalizeProvider(input.provider)
    const externalWorkspaceId = normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'External workspace id')
    const externalUserId = normalizeText(input.externalUserId, CHANNEL_TEXT_MAX_LENGTH, 'External user id')
    const identityId = this.identitiesByExternal.get(key(input.orgId, channelScopeKey(provider, externalWorkspaceId, externalUserId)))
    return identityId ? clone(this.identities.get(identityId) || null) : null
  }
}

function normalizeText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`)
  return normalized
}

function normalizeNullableText(value: unknown, maxLength: number, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return normalizeText(value, maxLength, label)
}

function normalizeChannelIdentityRole(value: unknown): ChannelIdentityRole {
  const role = normalizeText(value || 'viewer', 32, 'Channel identity role') as ChannelIdentityRole
  if (!CHANNEL_IDENTITY_ROLES.has(role)) throw new Error(`Unsupported channel identity role ${role}.`)
  return role
}

function normalizeRecord(value: unknown, label: string, maxBytes = CHANNEL_METADATA_MAX_BYTES): Record<string, unknown> {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? clone(value as Record<string, unknown>)
    : {}
  const serialized = stableJson(record)
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  return record
}

function nowIso(now: Date | undefined) {
  return (now || new Date()).toISOString()
}

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

function key(...parts: string[]) {
  return parts.join('\0')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, entry]) => `${JSON.stringify(field)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
