import {
  clone,
  key,
  normalizeNullableText,
  normalizePositiveInteger,
  normalizeText,
  nowIso,
  stableJson,
} from './store-helpers.ts'
import type { CloudBillingEntitlements } from '../../config-types.ts'
import { redactAuditMetadata } from '../audit-redaction.ts'
import type {
  AuditEventRecord,
  BillingSubscriptionRecord,
  BillingSubscriptionStatus,
  RecordAuditEventInput,
  UpsertBillingSubscriptionInput,
} from '../control-plane-store.ts'

// Billing-subscription domain extracted from in-memory-control-plane-store.ts.
// Owns the subscription record + the provider→org lookup indexes, and the upsert
// (with provider-index maintenance + audit) / get / find-by-provider lifecycle.
// Cross-domain needs (org existence, audit recording) arrive via the injected
// host, matching the other in-memory domain modules. Behaviour-preserving move —
// exercised by the cloud-http-server billing suite (50+ assertions).

const BILLING_TEXT_MAX_LENGTH = 256
const BILLING_METADATA_MAX_BYTES = 16_384
const CHANNEL_METADATA_MAX_BYTES = 16_384
const BILLING_SUBSCRIPTION_STATUSES = new Set<BillingSubscriptionStatus>([
  'trialing', 'active', 'past_due', 'canceled', 'incomplete',
])

type InMemoryBillingHost = {
  orgExists(orgId: string): boolean
  recordAuditEvent(input: RecordAuditEventInput): AuditEventRecord
}

export class InMemoryBillingDomain {
  private readonly billingSubscriptions = new Map<string, BillingSubscriptionRecord>()
  private readonly billingSubscriptionsByProviderSubscription = new Map<string, string>()
  private readonly billingSubscriptionsByProviderCustomer = new Map<string, string>()
  private readonly host: InMemoryBillingHost

  constructor(host: InMemoryBillingHost) {
    this.host = host
  }

  upsertBillingSubscription(input: UpsertBillingSubscriptionInput): BillingSubscriptionRecord {
    if (!this.host.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const existing = this.billingSubscriptions.get(input.orgId)
    const now = nowIso(input.updatedAt)
    const providerId = normalizeText(input.providerId, BILLING_TEXT_MAX_LENGTH, 'Billing provider id')
    const providerCustomerId = normalizeNullableText(input.providerCustomerId, BILLING_TEXT_MAX_LENGTH, 'Billing provider customer id')
    const providerSubscriptionId = normalizeNullableText(input.providerSubscriptionId, BILLING_TEXT_MAX_LENGTH, 'Billing provider subscription id')
    const record: BillingSubscriptionRecord = {
      orgId: input.orgId,
      planKey: normalizeText(input.planKey || existing?.planKey, BILLING_TEXT_MAX_LENGTH, 'Billing plan key'),
      providerId,
      providerCustomerId,
      providerSubscriptionId,
      status: normalizeBillingStatus(input.status),
      seats: normalizePositiveInteger(input.seats || existing?.seats || 1, 'Billing seats'),
      entitlements: normalizeRecord(input.entitlements, 'Billing entitlements', BILLING_METADATA_MAX_BYTES) as CloudBillingEntitlements,
      currentPeriodEnd: isoNullable(input.currentPeriodEnd),
      cancelAtPeriodEnd: input.cancelAtPeriodEnd === undefined ? existing?.cancelAtPeriodEnd || false : input.cancelAtPeriodEnd === true,
      metadata: redactAuditMetadata(normalizeRecord(input.metadata, 'Billing metadata', BILLING_METADATA_MAX_BYTES)),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    if (existing?.providerSubscriptionId) {
      this.billingSubscriptionsByProviderSubscription.delete(billingProviderKey(existing.providerId, existing.providerSubscriptionId))
    }
    if (existing?.providerCustomerId) {
      this.billingSubscriptionsByProviderCustomer.delete(billingProviderKey(existing.providerId, existing.providerCustomerId))
    }
    this.billingSubscriptions.set(record.orgId, record)
    if (record.providerSubscriptionId) {
      this.billingSubscriptionsByProviderSubscription.set(billingProviderKey(record.providerId, record.providerSubscriptionId), record.orgId)
    }
    if (record.providerCustomerId) {
      this.billingSubscriptionsByProviderCustomer.set(billingProviderKey(record.providerId, record.providerCustomerId), record.orgId)
    }
    this.host.recordAuditEvent({
      orgId: record.orgId,
      actorType: 'system',
      actorId: 'billing.subscription.upsert',
      eventType: existing ? 'billing.subscription.updated' : 'billing.subscription.created',
      targetType: 'billing_subscription',
      targetId: record.providerSubscriptionId || record.orgId,
      metadata: {
        providerId: record.providerId,
        previousPlanKey: existing?.planKey || null,
        previousStatus: existing?.status || null,
        previousEntitlementsHash: existing ? stableJson(existing.entitlements) : null,
        planKey: record.planKey,
        status: record.status,
        entitlementsHash: stableJson(record.entitlements),
        seats: record.seats,
        providerCustomerId: record.providerCustomerId,
        providerSubscriptionId: record.providerSubscriptionId,
        providerEventId: input.metadata?.stripeEventId || input.metadata?.eventId || null,
      },
      createdAt: input.updatedAt,
    })
    return clone(record)
  }

  getBillingSubscription(orgId: string): BillingSubscriptionRecord | null {
    const subscription = this.billingSubscriptions.get(orgId)
    return subscription ? clone(subscription) : null
  }

  findBillingSubscriptionByProvider(input: {
    providerId: string
    providerCustomerId?: string | null
    providerSubscriptionId?: string | null
  }): BillingSubscriptionRecord | null {
    const providerId = normalizeText(input.providerId, BILLING_TEXT_MAX_LENGTH, 'Billing provider id')
    const bySubscription = input.providerSubscriptionId
      ? this.billingSubscriptionsByProviderSubscription.get(billingProviderKey(providerId, input.providerSubscriptionId))
      : null
    const byCustomer = input.providerCustomerId
      ? this.billingSubscriptionsByProviderCustomer.get(billingProviderKey(providerId, input.providerCustomerId))
      : null
    const subscription = this.billingSubscriptions.get(bySubscription || byCustomer || '')
    return subscription ? clone(subscription) : null
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

function normalizeBillingStatus(value: unknown): BillingSubscriptionStatus {
  const status = normalizeText(value || 'incomplete', 32, 'Billing subscription status') as BillingSubscriptionStatus
  return BILLING_SUBSCRIPTION_STATUSES.has(status) ? status : 'incomplete'
}

function billingProviderKey(providerId: string, providerRecordId: string | null | undefined) {
  return key(normalizeText(providerId, BILLING_TEXT_MAX_LENGTH, 'Billing provider id'), providerRecordId || '')
}

function isoNullable(value: Date | string | null | undefined) {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}
