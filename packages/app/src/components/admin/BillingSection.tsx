import type { AdminEntitlements } from '@open-cowork/shared'
import { Badge } from '../ui'
import { t } from '../../helpers/i18n'
import { AdminSectionHeader } from './AdminPrimitives'

// Billing section (#896) — rendered ONLY when the billing adapter is enabled
// (entitlements.billingEnabled). Presents the resolved plan, feature flags, and
// resource limits. When the adapter is off this section is never mounted, so there
// is no dead billing UI.
export function BillingSection({ entitlements }: { entitlements: AdminEntitlements }) {
  const features = Object.entries(entitlements.features)
  const limits = Object.entries(entitlements.limits)

  return (
    <div className="space-y-5">
      <AdminSectionHeader
        title={t('admin.billing.title', 'Billing')}
        description={t('admin.billing.description', 'Subscription plan, entitlements, and resource limits.')}
      />

      <section className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border-subtle bg-surface p-4">
          <div className="text-xs uppercase tracking-wide text-text-muted">{t('admin.billing.plan', 'Plan')}</div>
          <div className="mt-1 text-lg font-semibold text-text">{entitlements.planLabel || entitlements.planKey || t('admin.billing.default', 'Default')}</div>
        </div>
        <div className="rounded-lg border border-border-subtle bg-surface p-4">
          <div className="text-xs uppercase tracking-wide text-text-muted">{t('admin.billing.status', 'Status')}</div>
          <div className="mt-1"><Badge tone={entitlements.subscriptionStatus === 'active' ? 'success' : 'muted'}>{entitlements.subscriptionStatus || t('admin.billing.none', 'None')}</Badge></div>
        </div>
        <div className="rounded-lg border border-border-subtle bg-surface p-4">
          <div className="text-xs uppercase tracking-wide text-text-muted">{t('admin.billing.seats', 'Seats')}</div>
          <div className="mt-1 text-lg font-semibold text-text">{entitlements.seats ?? t('admin.billing.unlimited', 'Unlimited')}</div>
        </div>
      </section>

      <section aria-labelledby="admin-billing-features">
        <h3 id="admin-billing-features" className="mb-2 text-sm font-semibold text-text">{t('admin.billing.features', 'Features')}</h3>
        {features.length ? (
          <div className="flex flex-wrap gap-2">
            {features.map(([feature, enabled]) => (
              <Badge key={feature} tone={enabled ? 'success' : 'muted'}>{feature}</Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-muted">{t('admin.billing.noFeatures', 'No feature gates are configured.')}</p>
        )}
      </section>

      <section aria-labelledby="admin-billing-limits">
        <h3 id="admin-billing-limits" className="mb-2 text-sm font-semibold text-text">{t('admin.billing.limits', 'Limits')}</h3>
        {limits.length ? (
          <dl className="rounded-lg border border-border-subtle bg-surface p-4">
            {limits.map(([resource, value]) => (
              <div key={resource} className="flex items-center justify-between border-b border-border-subtle py-2 last:border-b-0">
                <dt className="text-sm text-text-muted">{resource}</dt>
                <dd className="text-sm font-medium text-text">{value === null || value === undefined ? t('admin.billing.unlimited', 'Unlimited') : value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-text-muted">{t('admin.billing.noLimits', 'No resource limits are configured.')}</p>
        )}
      </section>
    </div>
  )
}
