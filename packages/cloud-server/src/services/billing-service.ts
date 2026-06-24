import type {
  BillingCheckoutResult,
  BillingPortalResult,
  BillingWebhookResult,
} from '../billing-adapter.ts'
import type { CloudPrincipal } from '../session-service.ts'

export type CloudBillingServiceDelegate = {
  getBillingSubscription(principal: CloudPrincipal): Promise<unknown>
  createBillingCheckout(principal: CloudPrincipal, input: {
    planKey?: string | null
    successUrl?: string | null
    cancelUrl?: string | null
  }): Promise<BillingCheckoutResult>
  createBillingPortal(principal: CloudPrincipal, input: {
    returnUrl?: string | null
  }): Promise<BillingPortalResult>
  handleBillingWebhook(input: {
    providerId: string
    headers: Record<string, string | string[] | undefined>
    body: Buffer
  }): Promise<BillingWebhookResult>
}

export class CloudBillingService {
  private readonly delegate: CloudBillingServiceDelegate

  constructor(delegate: CloudBillingServiceDelegate) {
    this.delegate = delegate
  }

  getSubscription(principal: CloudPrincipal) {
    return this.delegate.getBillingSubscription(principal)
  }

  createCheckout(principal: CloudPrincipal, input: {
    planKey?: string | null
    successUrl?: string | null
    cancelUrl?: string | null
  }) {
    return this.delegate.createBillingCheckout(principal, input)
  }

  createPortal(principal: CloudPrincipal, input: { returnUrl?: string | null }) {
    return this.delegate.createBillingPortal(principal, input)
  }

  handleWebhook(input: {
    providerId: string
    headers: Record<string, string | string[] | undefined>
    body: Buffer
  }) {
    return this.delegate.handleBillingWebhook(input)
  }
}
