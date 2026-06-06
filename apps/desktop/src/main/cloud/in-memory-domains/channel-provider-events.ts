import { createHash } from 'node:crypto'
import type {
  ChannelProviderEventClaimResult,
  ChannelProviderEventRecord,
  ChannelProviderEventType,
  ChannelProviderId,
  ClaimChannelProviderEventInput,
  CompleteChannelProviderEventInput,
} from '../channel-provider-types.ts'
import { normalizeChannelProviderId as normalizeProvider } from '../channel-provider-utils.ts'

const CHANNEL_TEXT_MAX_LENGTH = 256
const CHANNEL_METADATA_MAX_BYTES = 16_384
const CHANNEL_PROVIDER_EVENT_ERROR_MAX_LENGTH = 1024

type InMemoryChannelProviderEventsHost = {
  orgExists(orgId: string): boolean
}

export class InMemoryChannelProviderEventsDomain {
  private readonly events = new Map<string, ChannelProviderEventRecord>()
  private readonly host: InMemoryChannelProviderEventsHost

  constructor(host: InMemoryChannelProviderEventsHost) {
    this.host = host
  }

  claim(input: ClaimChannelProviderEventInput): ChannelProviderEventClaimResult {
    if (!this.host.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const now = input.now || new Date()
    const nowIsoValue = now.toISOString()
    const ttlMs = Math.max(1, Math.min(input.ttlMs || 5 * 60_000, 60 * 60_000))
    const eventKey = channelProviderEventKey(input)
    const existing = this.events.get(eventKey)
    const provider = normalizeProvider(input.provider)
    const eventType = normalizeChannelProviderEventType(input.eventType)
    const canReclaim = existing && (
      (existing.status === 'processing' && existing.claimExpiresAt && new Date(existing.claimExpiresAt).getTime() <= now.getTime())
      || (existing.status === 'failed' && existing.retryable)
      || existing.status === 'received'
    )

    if (!existing) {
      const record: ChannelProviderEventRecord = {
        eventId: normalizeText(
          input.eventId || stableId('channel_provider_event', input.orgId, provider, input.providerInstanceId, input.externalWorkspaceId || '', eventType, input.providerEventId),
          CHANNEL_TEXT_MAX_LENGTH,
          'Channel provider event id',
        ),
        orgId: input.orgId,
        provider,
        providerInstanceId: normalizeText(input.providerInstanceId, CHANNEL_TEXT_MAX_LENGTH, 'Channel provider instance id'),
        externalWorkspaceId: normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'Channel external workspace id'),
        providerEventId: normalizeText(input.providerEventId, CHANNEL_TEXT_MAX_LENGTH, 'Provider event id'),
        eventType,
        status: 'processing',
        claimedBy: normalizeText(input.claimedBy, CHANNEL_TEXT_MAX_LENGTH, 'Provider event claimant'),
        claimExpiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        attemptCount: 1,
        retryable: true,
        lastError: null,
        metadata: normalizeRecord(input.metadata || {}, 'Channel provider event metadata'),
        processedAt: null,
        createdAt: nowIsoValue,
        updatedAt: nowIsoValue,
      }
      this.events.set(eventKey, record)
      return { event: clone(record), claimed: true, duplicate: false }
    }

    existing.updatedAt = nowIsoValue
    if (canReclaim) {
      existing.provider = provider
      existing.eventType = eventType
      existing.status = 'processing'
      existing.claimedBy = normalizeText(input.claimedBy, CHANNEL_TEXT_MAX_LENGTH, 'Provider event claimant')
      existing.claimExpiresAt = new Date(now.getTime() + ttlMs).toISOString()
      existing.attemptCount += 1
      existing.retryable = true
      existing.lastError = null
      existing.metadata = normalizeRecord(input.metadata || existing.metadata, 'Channel provider event metadata')
      existing.processedAt = null
      return { event: clone(existing), claimed: true, duplicate: false }
    }

    return { event: clone(existing), claimed: false, duplicate: true }
  }

  complete(input: CompleteChannelProviderEventInput): ChannelProviderEventRecord | null {
    const event = Array.from(this.events.values())
      .find((candidate) => candidate.orgId === input.orgId && candidate.eventId === input.eventId)
    if (!event) return null
    if (event.claimedBy !== normalizeText(input.claimedBy, CHANNEL_TEXT_MAX_LENGTH, 'Provider event claimant')) return null

    const updatedAt = nowIso(input.updatedAt)
    event.status = input.status
    event.claimedBy = null
    event.claimExpiresAt = null
    event.retryable = input.status === 'failed' ? input.retryable !== false : false
    event.lastError = input.status === 'failed' && input.lastError
      ? redactOperationalText(input.lastError, CHANNEL_PROVIDER_EVENT_ERROR_MAX_LENGTH, 'Provider event error')
      : null
    event.processedAt = input.status === 'processed' ? updatedAt : event.processedAt
    event.updatedAt = updatedAt
    return clone(event)
  }
}

function channelProviderEventKey(input: {
  orgId: string
  provider: ChannelProviderId
  providerInstanceId: string
  externalWorkspaceId?: string | null
  eventType: ChannelProviderEventType
  providerEventId: string
}) {
  return key(
    input.orgId,
    normalizeProvider(input.provider),
    normalizeText(input.providerInstanceId, CHANNEL_TEXT_MAX_LENGTH, 'Channel provider instance id'),
    normalizeNullableText(input.externalWorkspaceId, CHANNEL_TEXT_MAX_LENGTH, 'Channel external workspace id') || '',
    normalizeText(input.eventType, CHANNEL_TEXT_MAX_LENGTH, 'Channel provider event type'),
    normalizeText(input.providerEventId, CHANNEL_TEXT_MAX_LENGTH, 'Channel provider event id'),
  )
}

function normalizeChannelProviderEventType(value: unknown): ChannelProviderEventType {
  const eventType = normalizeText(value || 'message', 32, 'Channel provider event type') as ChannelProviderEventType
  if (!['message', 'command', 'interaction'].includes(eventType)) throw new Error(`Unsupported channel provider event type ${eventType}.`)
  return eventType
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

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters.`)
  }
  return normalized
}

function normalizeNullableText(value: unknown, maxLength: number, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return normalizeText(value, maxLength, label)
}

function normalizeRecord(value: unknown, label: string, maxBytes = CHANNEL_METADATA_MAX_BYTES): Record<string, unknown> {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? clone(value as Record<string, unknown>)
    : {}
  const serialized = stableJson(record)
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  }
  return record
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

function redactOperationalText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const redacted = value.trim()
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/\b(api[_-]?key|token|secret|password|authorization)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/\b(gcp-sm|aws-sm|azure-kv|env):[^\s,)]+/gi, '$1:[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9._-]{6,}|oc[wc]_[A-Za-z0-9._-]{8,})\b/g, '[redacted]')
    .replace(/\b([A-Za-z0-9_-]{32,})\b/g, '[redacted]')
  return redacted.length <= maxLength ? redacted : `${redacted.slice(0, maxLength <= 3 ? maxLength : maxLength - 3)}${maxLength <= 3 ? '' : '...'}`
}
