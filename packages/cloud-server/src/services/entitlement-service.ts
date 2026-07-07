import type { BillingAction } from '../billing-adapter.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import {
  assertEntitled,
  EntitlementDeniedError,
  type EntitlementContext,
  type EntitlementFeature,
  type EntitlementPlanStatus,
  type EntitlementQuotaVerdict,
  type EntitlementResolver,
  type EntitlementResource,
} from '../entitlements/entitlement-resolver.ts'

// App-integration glue between the pluggable EntitlementResolver and the session
// service. It reuses the existing billing-action vocabulary on WRITE paths so the
// resolver is consulted exactly where creation/writes happen — never on reads.
const ACTION_FEATURE: Record<BillingAction, EntitlementFeature> = {
  'session.create': 'sessions',
  'prompt.enqueue': 'prompts',
  'worker.execute': 'workers',
  'byok.provider': 'byok',
  'artifact.upload': 'artifacts',
  'gateway.session.bind': 'channels',
  'channel.manage': 'channels',
}

export class CloudEntitlementService {
  private readonly resolver: EntitlementResolver

  constructor(input: { resolver: EntitlementResolver }) {
    this.resolver = input.resolver
  }

  get provider(): string {
    return this.resolver.provider
  }

  // Whether gating is live. The admin plane reads this to decide whether to
  // surface a Billing section; false ⇒ nothing is ever denied.
  get gatingEnabled(): boolean {
    return this.resolver.gating
  }

  // WRITE-ONLY gate. Invoked from create/write paths via `assertBillingAllowed`.
  // Translates a resolver denial into a CloudServiceError (402 by default).
  async assertAction(action: BillingAction, context: EntitlementContext): Promise<void> {
    try {
      await assertEntitled(this.resolver, ACTION_FEATURE[action], context)
    } catch (error) {
      if (error instanceof EntitlementDeniedError) {
        throw new CloudServiceError(error.status, error.publicMessage, { policyCode: error.policyCode })
      }
      throw error
    }
  }

  checkQuota(
    resource: EntitlementResource,
    amount: number,
    context: EntitlementContext,
  ): Promise<EntitlementQuotaVerdict> | EntitlementQuotaVerdict {
    return this.resolver.checkQuota(resource, amount, context)
  }

  // Read-only plan/entitlement status the future Billing UI (and admin plane) call.
  // Safe on any read path: it never gates and carries no secrets.
  describe(context: EntitlementContext): Promise<EntitlementPlanStatus> {
    return Promise.resolve(this.resolver.describeEntitlements(context))
  }
}
