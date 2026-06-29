import type {
  BillingSubscriptionRecord,
  ControlPlaneStore,
} from './control-plane-store.ts'
import { CloudServiceError } from './cloud-service-error.ts'
import {
  BillingAdapterError,
  evaluateBillingEntitlement,
  isBillingConfigured,
  resolvedBillingEntitlements,
  type BillingAdapter,
  type BillingCheckoutResult,
  type BillingPortalResult,
  type BillingWebhookResult,
} from './billing-adapter.ts'
import { type CloudRuntimePolicy } from './cloud-config.ts'
import { principalCanManageBilling } from './session-principal-access.ts'
import type { CloudBillingConfig } from '@open-cowork/shared'
import type { CloudPrincipal } from './session-service.ts'

export type CloudBillingOperationsServiceOptions = {
  store: ControlPlaneStore
  policy: CloudRuntimePolicy
  billingConfig: CloudBillingConfig | null
  billingAdapter: BillingAdapter | null
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
  principalOrgId: (principal: CloudPrincipal) => string
}

export class CloudBillingOperationsService {
  private readonly store: ControlPlaneStore
  private readonly policy: CloudRuntimePolicy
  private readonly billingConfig: CloudBillingConfig | null
  private readonly billingAdapter: BillingAdapter | null
  private readonly ensurePrincipal: CloudBillingOperationsServiceOptions['ensurePrincipal']
  private readonly principalOrgId: CloudBillingOperationsServiceOptions['principalOrgId']

  constructor(options: CloudBillingOperationsServiceOptions) {
    this.store = options.store
    this.policy = options.policy
    this.billingConfig = options.billingConfig
    this.billingAdapter = options.billingAdapter
    this.ensurePrincipal = options.ensurePrincipal
    this.principalOrgId = options.principalOrgId
  }

  async getBillingSubscription(principal: CloudPrincipal) {
    await this.ensurePrincipal(principal)
    const subscription = await this.store.getBillingSubscription(this.principalOrgId(principal))
    const billingEnabled = Boolean(this.billingConfig && isBillingConfigured(this.billingConfig))
    const providerId = this.billingAdapter?.providerId || this.billingConfig?.provider || 'none'
    const mode: 'self-host' | 'managed' = billingEnabled && providerId !== 'stub' ? 'managed' : 'self-host'
    return {
      enabled: billingEnabled,
      mode,
      providerId,
      subscription,
      entitlements: this.billingConfig ? resolvedBillingEntitlements(this.billingConfig, subscription) : {},
      active: this.billingConfig ? evaluateBillingEntitlement({
        config: this.billingConfig,
        subscription,
        action: 'session.create',
        profileName: this.policy.profileName,
      }).allowed : true,
      plans: Object.entries(this.billingConfig?.plans || {}).map(([planKey, plan]) => ({
        planKey,
        label: plan.label || planKey,
        default: planKey === this.billingConfig?.defaultPlanKey,
        entitlements: plan.entitlements || {},
      })),
    }
  }

  async createBillingCheckout(
    principal: CloudPrincipal,
    input: { planKey?: string | null, successUrl?: string | null, cancelUrl?: string | null },
  ): Promise<BillingCheckoutResult> {
    await this.ensurePrincipal(principal)
    this.assertBillingAdmin(principal)
    if (!this.billingConfig || !isBillingConfigured(this.billingConfig) || !this.billingAdapter) {
      throw new CloudServiceError(404, 'Billing is not enabled for this cloud deployment.')
    }
    const planKey = input.planKey || this.billingConfig.defaultPlanKey
    if (!this.billingConfig.plans[planKey]) throw new CloudServiceError(400, `Unknown billing plan "${planKey}".`)
    try {
      const result = await this.billingAdapter.createCheckoutSession({
        orgId: this.principalOrgId(principal),
        accountId: principal.accountId || principal.userId,
        email: principal.email,
        planKey,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      })
      if (result.subscription) await this.store.upsertBillingSubscription(result.subscription)
      await this.store.recordAuditEvent({
        orgId: this.principalOrgId(principal),
        accountId: principal.accountId || principal.userId,
        actorType: principal.authSource === 'api_token' ? 'api_token' : 'user',
        actorId: principal.tokenId || principal.userId,
        eventType: 'billing.checkout.created',
        targetType: 'billing_subscription',
        targetId: result.providerSessionId || planKey,
        metadata: { providerId: result.providerId, planKey },
      })
      return result
    } catch (error) {
      this.translateBillingAdapterError(error)
    }
  }

  async createBillingPortal(
    principal: CloudPrincipal,
    input: { returnUrl?: string | null },
  ): Promise<BillingPortalResult> {
    await this.ensurePrincipal(principal)
    this.assertBillingAdmin(principal)
    if (!this.billingConfig || !isBillingConfigured(this.billingConfig) || !this.billingAdapter) {
      throw new CloudServiceError(404, 'Billing is not enabled for this cloud deployment.')
    }
    try {
      const subscription = await this.store.getBillingSubscription(this.principalOrgId(principal))
      return await this.billingAdapter.createPortalSession({
        orgId: this.principalOrgId(principal),
        email: principal.email,
        subscription,
        returnUrl: input.returnUrl,
      })
    } catch (error) {
      this.translateBillingAdapterError(error)
    }
  }

  async verifyBillingWebhook(input: {
    headers: Record<string, string | undefined>
    rawBody: string
    body: Record<string, unknown>
  }): Promise<BillingWebhookResult> {
    if (!this.billingConfig || !isBillingConfigured(this.billingConfig) || !this.billingAdapter) {
      throw new CloudServiceError(404, 'Billing is not enabled for this cloud deployment.')
    }
    try {
      return this.billingAdapter.handleWebhook(input)
    } catch (error) {
      this.translateBillingAdapterError(error)
    }
  }

  async applyBillingWebhookResult(result: BillingWebhookResult): Promise<BillingWebhookResult & { subscriptionRecord?: BillingSubscriptionRecord | null }> {
    let subscriptionRecord: BillingSubscriptionRecord | null = null
    if (result.subscription) {
      subscriptionRecord = await this.store.upsertBillingSubscription(result.subscription)
      await this.store.recordAuditEvent({
        eventId: `billing_${result.providerId}_${result.eventId}`,
        orgId: result.subscription.orgId,
        actorType: 'system',
        actorId: `billing.${result.providerId}`,
        eventType: 'billing.webhook.processed',
        targetType: 'billing_subscription',
        targetId: result.subscription.providerSubscriptionId || result.subscription.orgId,
        metadata: {
          providerId: result.providerId,
          eventType: result.eventType,
          planKey: result.subscription.planKey,
          status: result.subscription.status,
        },
      })
    }
    return {
      ...result,
      subscriptionRecord,
    }
  }

  async handleBillingWebhook(input: {
    headers: Record<string, string | undefined>
    rawBody: string
    body: Record<string, unknown>
  }): Promise<BillingWebhookResult & { subscriptionRecord?: BillingSubscriptionRecord | null }> {
    return this.applyBillingWebhookResult(await this.verifyBillingWebhook(input))
  }

  private assertBillingAdmin(principal: CloudPrincipal) {
    if (!principalCanManageBilling(principal)) {
      throw new CloudServiceError(403, 'Billing administration requires an org admin or admin-scoped API token.')
    }
  }

  private translateBillingAdapterError(error: unknown): never {
    if (error instanceof BillingAdapterError) {
      throw new CloudServiceError(error.status, error.publicMessage)
    }
    throw error
  }
}
