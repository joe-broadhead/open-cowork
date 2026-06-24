import { redactOperationalText } from '../operational-text-redaction.ts'
import {
  clone,
  normalizeNullableText,
  normalizeText,
  nowIso,
  stableJson,
} from './store-helpers.ts'
import { quotaExceeded } from '../control-plane-errors.ts'
import { normalizeChannelProviderId as normalizeProvider } from '../channel-provider-utils.ts'
import type {
  AckChannelDeliveryInput,
  ChannelBindingRecord,
  ChannelDeliveryRecord,
  ChannelSessionBindingRecord,
  ClaimChannelDeliveryInput,
  CreateChannelDeliveryInput,
  HeadlessAgentRecord,
  ListChannelDeliveriesInput,
  QuotaConsumptionRecord,
} from '../control-plane-store.ts'

const CHANNEL_TEXT_MAX_LENGTH = 256
const CHANNEL_METADATA_MAX_BYTES = 16_384
const CHANNEL_DELIVERY_ERROR_MAX_LENGTH = 1024

type ChannelDeliveryQuotaInput = NonNullable<ClaimChannelDeliveryInput['quota']> & { orgId: string }

type InMemoryChannelDeliveriesHost = {
  orgExists(orgId: string): boolean
  getHeadlessAgent(orgId: string, agentId: string): HeadlessAgentRecord | null
  getChannelBinding(orgId: string, bindingId: string): ChannelBindingRecord | null
  getChannelSessionBinding(orgId: string, bindingId: string): ChannelSessionBindingRecord | null
  consumeUsageQuota(input: ChannelDeliveryQuotaInput): QuotaConsumptionRecord
}

export class InMemoryChannelDeliveriesDomain {
  private readonly deliveries = new Map<string, ChannelDeliveryRecord>()
  private readonly host: InMemoryChannelDeliveriesHost

  constructor(host: InMemoryChannelDeliveriesHost) {
    this.host = host
  }

  create(input: CreateChannelDeliveryInput): ChannelDeliveryRecord {
    if (!this.host.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const agent = this.host.getHeadlessAgent(input.orgId, input.agentId)
    if (!agent) throw new Error(`Unknown headless agent ${input.agentId}.`)
    const channelBinding = this.host.getChannelBinding(input.orgId, input.channelBindingId)
    if (!channelBinding) throw new Error(`Unknown channel binding ${input.channelBindingId}.`)
    const provider = normalizeProvider(input.provider)
    if (channelBinding.agentId !== agent.agentId) throw new Error('Channel delivery binding does not match headless agent.')
    if (channelBinding.provider !== provider) throw new Error('Channel delivery provider does not match channel binding.')
    if (input.sessionBindingId) {
      const sessionBinding = this.host.getChannelSessionBinding(input.orgId, input.sessionBindingId)
      if (!sessionBinding) throw new Error(`Unknown channel session binding ${input.sessionBindingId}.`)
      if (
        sessionBinding.agentId !== agent.agentId
        || sessionBinding.channelBindingId !== channelBinding.bindingId
        || sessionBinding.provider !== provider
      ) {
        throw new Error('Channel delivery session binding does not match channel binding.')
      }
    }
    const existing = this.deliveries.get(input.deliveryId)
    if (existing) return clone(existing)
    const now = nowIso(input.createdAt)
    const record: ChannelDeliveryRecord = {
      deliveryId: normalizeText(input.deliveryId, CHANNEL_TEXT_MAX_LENGTH, 'Channel delivery id'),
      orgId: input.orgId,
      agentId: normalizeText(input.agentId, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent id'),
      channelBindingId: normalizeText(input.channelBindingId, CHANNEL_TEXT_MAX_LENGTH, 'Channel binding id'),
      sessionBindingId: normalizeNullableText(input.sessionBindingId, CHANNEL_TEXT_MAX_LENGTH, 'Channel session binding id'),
      provider,
      target: normalizeRecord(input.target, 'Channel delivery target'),
      eventType: normalizeText(input.eventType, CHANNEL_TEXT_MAX_LENGTH, 'Channel delivery event type'),
      payload: normalizeRecord(input.payload, 'Channel delivery payload'),
      status: input.status || 'pending',
      attemptCount: 0,
      claimedBy: null,
      lastClaimedBy: null,
      claimExpiresAt: null,
      nextAttemptAt: (input.nextAttemptAt || input.createdAt || new Date()).toISOString(),
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }
    this.deliveries.set(record.deliveryId, record)
    return clone(record)
  }

  list(input: ListChannelDeliveriesInput): ChannelDeliveryRecord[] {
    if (input.channelBindingIds?.length === 0) return []
    const limit = Math.max(1, Math.min(200, input.limit || 50))
    return Array.from(this.deliveries.values())
      .filter((delivery) => delivery.orgId === input.orgId)
      .filter((delivery) => !input.deliveryId || delivery.deliveryId === input.deliveryId)
      .filter((delivery) => !input.status || delivery.status === input.status)
      .filter((delivery) => !input.channelBindingId || delivery.channelBindingId === input.channelBindingId)
      .filter((delivery) => !input.channelBindingIds || input.channelBindingIds.includes(delivery.channelBindingId))
      .filter((delivery) => !input.lastClaimedBy || delivery.lastClaimedBy === input.lastClaimedBy)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(clone)
  }

  claimNext(input: ClaimChannelDeliveryInput): ChannelDeliveryRecord | null {
    if (input.channelBindingIds?.length === 0) return null
    const now = input.now || new Date()
    const nowMs = now.getTime()
    const candidate = Array.from(this.deliveries.values())
      .filter((delivery) => delivery.orgId === input.orgId)
      .filter((delivery) => !input.channelBindingIds || input.channelBindingIds.includes(delivery.channelBindingId))
      .filter((delivery) => (
        (delivery.status === 'pending' && new Date(delivery.nextAttemptAt).getTime() <= nowMs)
        || (delivery.status === 'failed' && new Date(delivery.nextAttemptAt).getTime() <= nowMs)
        || (delivery.status === 'claimed' && delivery.claimExpiresAt && new Date(delivery.claimExpiresAt).getTime() <= nowMs)
      ))
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt) || left.createdAt.localeCompare(right.createdAt))[0]
    if (!candidate) return null
    if (input.quota) {
      const quota = this.host.consumeUsageQuota({ ...input.quota, orgId: input.orgId, now })
      if (!quota.allowed) {
        quotaExceeded({
          message: 'Gateway delivery quota exceeded.',
          policyCode: quota.policyCode || 'quota.gateway_deliveries_per_hour_exceeded',
          retryAfterMs: quota.retryAfterMs,
          limit: quota.limit,
          used: quota.used,
          resetAt: quota.resetAt,
        })
      }
    }
    candidate.status = 'claimed'
    candidate.claimedBy = normalizeText(input.claimedBy, CHANNEL_TEXT_MAX_LENGTH, 'Delivery claimant')
    candidate.lastClaimedBy = normalizeText(input.lastClaimedBy || input.claimedBy, CHANNEL_TEXT_MAX_LENGTH, 'Delivery owner')
    candidate.claimExpiresAt = new Date(nowMs + (input.ttlMs || 30_000)).toISOString()
    candidate.attemptCount += 1
    candidate.updatedAt = now.toISOString()
    return clone(candidate)
  }

  ack(input: AckChannelDeliveryInput): ChannelDeliveryRecord | null {
    if (input.channelBindingIds?.length === 0) return null
    const delivery = this.deliveries.get(input.deliveryId)
    if (!delivery || delivery.orgId !== input.orgId) return null
    if (input.channelBindingIds && !input.channelBindingIds.includes(delivery.channelBindingId)) return null
    if (input.claimedBy && delivery.claimedBy !== input.claimedBy) return null
    if (input.lastClaimedBy && delivery.lastClaimedBy !== input.lastClaimedBy) {
      const legacyClaimMatches = delivery.lastClaimedBy === null && Boolean(input.claimedBy) && delivery.claimedBy === input.claimedBy
      if (!legacyClaimMatches) return null
      delivery.lastClaimedBy = input.lastClaimedBy
    }
    const updatedAt = nowIso(input.updatedAt)
    delivery.status = input.status
    delivery.claimedBy = null
    delivery.claimExpiresAt = null
    delivery.lastError = input.lastError ? redactOperationalText(input.lastError, CHANNEL_DELIVERY_ERROR_MAX_LENGTH, 'Delivery error') : null
    delivery.nextAttemptAt = (input.nextAttemptAt || input.updatedAt || new Date()).toISOString()
    delivery.updatedAt = updatedAt
    return clone(delivery)
  }
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

