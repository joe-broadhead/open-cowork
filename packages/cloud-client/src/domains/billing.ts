export type {
  CloudBillingCheckoutResult,
  CloudBillingPortalResult,
  CloudBillingSubscriptionPayload,
  CloudBillingSubscriptionRecord,
  CloudUsageQuotaWindowRecord,
  CloudUsageEventRecord,
  CloudUsageSummary,
  CloudUsageTotalRecord,
} from '../contracts.js'

import type {
  CloudBillingCheckoutResult,
  CloudBillingPortalResult,
  CloudBillingSubscriptionPayload,
  CloudDiagnosticsBundle,
  CloudUsageEventRecord,
  CloudUsageSummary,
} from '../contracts.js'
import type { CloudDomainClientContext } from './shared.js'
import { queryString } from './shared.js'

export type CloudBillingClient = {
  listUsageEvents(limit?: number): Promise<CloudUsageEventRecord[]>
  getUsageSummary(limit?: number): Promise<CloudUsageSummary>
  getDiagnosticsBundle(): Promise<CloudDiagnosticsBundle>
  getBillingSubscription(): Promise<CloudBillingSubscriptionPayload>
  createBillingCheckout(input?: {
    planKey?: string | null
    successUrl?: string | null
    cancelUrl?: string | null
  }): Promise<CloudBillingCheckoutResult>
  createBillingPortal(input?: { returnUrl?: string | null }): Promise<CloudBillingPortalResult>
}

export function createCloudBillingClient({ request }: CloudDomainClientContext): CloudBillingClient {
  return {
    async listUsageEvents(limit) {
      return (await request<{ events: CloudUsageEventRecord[] }>(`/api/usage/events${queryString({ limit })}`)).events
    },
    getUsageSummary(limit) {
      return request<CloudUsageSummary>(`/api/usage/summary${queryString({ limit })}`)
    },
    getDiagnosticsBundle() {
      return request<CloudDiagnosticsBundle>('/api/diagnostics')
    },
    getBillingSubscription() {
      return request<CloudBillingSubscriptionPayload>('/api/billing/subscription')
    },
    createBillingCheckout(input = {}) {
      return request<CloudBillingCheckoutResult>('/api/billing/checkout', {
        method: 'POST',
        body: input,
      })
    },
    createBillingPortal(input = {}) {
      return request<CloudBillingPortalResult>('/api/billing/portal', {
        method: 'POST',
        body: input,
      })
    },
  }
}
