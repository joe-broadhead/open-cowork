import { nowIso, stableJson } from '../postgres-store-id-helpers.ts'
import { normalizePositiveInteger, normalizeText } from '../postgres-store-normalizers.ts'
import { billingSubscriptionFromRow } from '../postgres-domains/billing.ts'
import { jsonRecord, type QueryResult, type QueryRow } from '../postgres-domains/shared.ts'
import { redactAuditMetadata } from '../audit-redaction.ts'
import type { RecordAuditEventInput, UpsertBillingSubscriptionInput } from '../control-plane-store.ts'

// Billing-subscription SQL domain extracted from postgres-control-plane-store.ts.
// Owns the one-subscription-per-org upsert (with prior-state audit diff) plus the
// org and provider lookups. Org existence + audit recording arrive via the injected
// host (the same repository pattern as workers/quotas/byok). Behaviour-preserving;
// covered by the pglite + real-Postgres control-plane contract suites.

const BILLING_TEXT_MAX_LENGTH = 256

type PgExecutor = {
  query<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]): Promise<QueryResult<Row>>
}

type PostgresBillingRepositoryOptions = {
  pool: PgExecutor
  recordAuditEvent(executor: PgExecutor, input: RecordAuditEventInput): Promise<unknown>
}

export class PostgresBillingRepository {
  private readonly options: PostgresBillingRepositoryOptions

  constructor(options: PostgresBillingRepositoryOptions) {
    this.options = options
  }

  async upsertBillingSubscription(input: UpsertBillingSubscriptionInput) {
    await this.requireOrg(input.orgId)
    const now = nowIso(input.updatedAt)
    const priorRow = await this.maybeOne(
      `SELECT * FROM cloud_subscriptions WHERE org_id = $1`,
      [input.orgId],
    )
    const prior = priorRow ? billingSubscriptionFromRow(priorRow) : null
    const result = await this.options.pool.query(
      `INSERT INTO cloud_subscriptions (
        org_id, plan_key, provider_id, provider_customer_id, provider_subscription_id,
        status, seats, entitlements, current_period_end, cancel_at_period_end,
        metadata, created_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11::jsonb, $12, $12)
       ON CONFLICT (org_id) DO UPDATE
       SET plan_key = EXCLUDED.plan_key,
           provider_id = EXCLUDED.provider_id,
           provider_customer_id = EXCLUDED.provider_customer_id,
           provider_subscription_id = EXCLUDED.provider_subscription_id,
           status = EXCLUDED.status,
           seats = EXCLUDED.seats,
           entitlements = EXCLUDED.entitlements,
           current_period_end = EXCLUDED.current_period_end,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           metadata = EXCLUDED.metadata,
           updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        input.orgId,
        normalizeText(input.planKey, BILLING_TEXT_MAX_LENGTH, 'Billing plan key'),
        normalizeText(input.providerId, BILLING_TEXT_MAX_LENGTH, 'Billing provider id'),
        input.providerCustomerId ? normalizeText(input.providerCustomerId, BILLING_TEXT_MAX_LENGTH, 'Billing provider customer id') : null,
        input.providerSubscriptionId ? normalizeText(input.providerSubscriptionId, BILLING_TEXT_MAX_LENGTH, 'Billing provider subscription id') : null,
        input.status,
        normalizePositiveInteger(input.seats || 1, 'Billing seats'),
        JSON.stringify(jsonRecord(input.entitlements)),
        input.currentPeriodEnd ? (input.currentPeriodEnd instanceof Date ? input.currentPeriodEnd.toISOString() : new Date(input.currentPeriodEnd).toISOString()) : null,
        input.cancelAtPeriodEnd === true,
        JSON.stringify(redactAuditMetadata(input.metadata)),
        now,
      ],
    )
    const subscription = billingSubscriptionFromRow(result.rows[0])
    await this.options.recordAuditEvent(this.options.pool, {
      orgId: subscription.orgId,
      actorType: 'system',
      actorId: 'billing.subscription.upsert',
      eventType: prior ? 'billing.subscription.updated' : 'billing.subscription.created',
      targetType: 'billing_subscription',
      targetId: subscription.providerSubscriptionId || subscription.orgId,
      metadata: {
        providerId: subscription.providerId,
        previousPlanKey: prior?.planKey || null,
        previousStatus: prior?.status || null,
        previousEntitlementsHash: prior ? stableJson(prior.entitlements) : null,
        planKey: subscription.planKey,
        status: subscription.status,
        entitlementsHash: stableJson(subscription.entitlements),
        seats: subscription.seats,
        providerCustomerId: subscription.providerCustomerId,
        providerSubscriptionId: subscription.providerSubscriptionId,
        providerEventId: input.metadata?.stripeEventId || input.metadata?.eventId || null,
      },
      createdAt: input.updatedAt,
    })
    return subscription
  }

  async getBillingSubscription(orgId: string) {
    const row = await this.maybeOne(
      `SELECT * FROM cloud_subscriptions WHERE org_id = $1`,
      [orgId],
    )
    return row ? billingSubscriptionFromRow(row) : null
  }

  async findBillingSubscriptionByProvider(input: {
    providerId: string
    providerCustomerId?: string | null
    providerSubscriptionId?: string | null
  }) {
    const providerId = normalizeText(input.providerId, BILLING_TEXT_MAX_LENGTH, 'Billing provider id')
    const row = input.providerSubscriptionId
      ? await this.maybeOne(
        `SELECT * FROM cloud_subscriptions
         WHERE provider_id = $1 AND provider_subscription_id = $2`,
        [providerId, input.providerSubscriptionId],
      )
      : input.providerCustomerId
        ? await this.maybeOne(
          `SELECT * FROM cloud_subscriptions
           WHERE provider_id = $1 AND provider_customer_id = $2
           ORDER BY updated_at DESC
           LIMIT 1`,
          [providerId, input.providerCustomerId],
        )
        : null
    return row ? billingSubscriptionFromRow(row) : null
  }

  private async requireOrg(orgId: string) {
    const row = await this.maybeOne(`SELECT * FROM cloud_orgs WHERE org_id = $1`, [orgId])
    if (!row) throw new Error(`Unknown org ${orgId}.`)
    return row
  }

  private async maybeOne<Row extends QueryRow = QueryRow>(text: string, values?: unknown[]) {
    const result = await this.options.pool.query<Row>(text, values)
    return result.rows[0] || null
  }
}
