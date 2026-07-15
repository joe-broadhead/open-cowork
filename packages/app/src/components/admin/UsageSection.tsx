import { useState } from 'react'
import { Badge, SegmentedControl } from '@open-cowork/ui'
import { t } from '../../helpers/i18n'
import { AdminSectionHeader, AdminStateBlock, AdminTable } from './AdminPrimitives'
import { useAdminResource } from './useAdminResource'
import { formatDateTime, formatQuantity } from './admin-support'

const RANGE_OPTIONS = [
  { value: '50', label: '50' },
  { value: '200', label: '200' },
  { value: '1000', label: '1000' },
] as const

// Usage section: read-only analytics (recent events, totals, quota windows) with a
// selectable sample size. The cloud usage summary returns whatever the deployment's
// usage adapter tracks; when disabled it reports `enabled: false`.
export function UsageSection() {
  const [limit, setLimit] = useState('200')
  const usage = useAdminResource(() => window.coworkApi.admin.usage(Number(limit)), [limit])

  return (
    <div className="space-y-5">
      <AdminSectionHeader
        title={t('admin.usage.title', 'Usage')}
        description={t('admin.usage.description', 'Recent usage events, totals, and quota windows for this organization.')}
        actions={
          <SegmentedControl
            label={t('admin.usage.sampleSize', 'Sample size')}
            options={RANGE_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
            value={limit}
            onChange={setLimit}
          />
        }
      />
      <AdminStateBlock
        state={usage}
        loadingRows={4}
        emptyTitle={t('admin.usage.empty.title', 'No usage recorded')}
        emptyBody={t('admin.usage.empty.body', 'This organization has no usage events yet.')}
        isEmpty={(data) => data.events.length === 0 && data.totals.length === 0 && data.quotas.length === 0}
      >
        {(data) => (
          <div className="space-y-5">
            {!data.enabled ? (
              <div role="note" className="rounded-lg border border-border-subtle bg-surface px-4 py-3 text-sm text-text-muted">
                {t('admin.usage.disabled', 'Usage metering is disabled for this deployment. Showing whatever the adapter reports.')}
              </div>
            ) : null}
            {data.totals.length > 0 ? (
              <section aria-labelledby="admin-usage-totals">
                <h3 id="admin-usage-totals" className="mb-2 text-sm font-semibold text-text">{t('admin.usage.totals', 'Totals')}</h3>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {data.totals.map((total) => (
                    <div key={`${total.eventType}-${total.unit}`} className="rounded-lg border border-border-subtle bg-surface p-4">
                      <div className="text-xs uppercase tracking-wide text-text-muted">{total.eventType}</div>
                      <div className="mt-1 text-lg font-semibold text-text">{formatQuantity(total.quantity, total.unit)}</div>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}
            {data.quotas.length > 0 ? (
              <section aria-labelledby="admin-usage-quotas">
                <h3 id="admin-usage-quotas" className="mb-2 text-sm font-semibold text-text">{t('admin.usage.quotas', 'Quota windows')}</h3>
                <AdminTable
                  caption={t('admin.usage.quotas', 'Quota windows')}
                  columns={[
                    t('admin.usage.quota', 'Quota'),
                    t('admin.usage.used', 'Used'),
                    t('admin.usage.limit', 'Limit'),
                    t('admin.usage.resets', 'Resets'),
                  ]}
                >
                  {data.quotas.map((quota) => (
                    <tr key={quota.quotaKey} className="border-b border-border-subtle last:border-b-0">
                      <td className="px-4 py-2.5 text-text">{quota.label}</td>
                      <td className="px-4 py-2.5 text-text">{formatQuantity(quota.used, quota.unit)}</td>
                      <td className="px-4 py-2.5 text-text-muted">{quota.limit === null ? t('admin.usage.unlimited', 'Unlimited') : formatQuantity(quota.limit, quota.unit)}</td>
                      <td className="px-4 py-2.5 text-text-muted">{formatDateTime(quota.resetAt)}</td>
                    </tr>
                  ))}
                </AdminTable>
              </section>
            ) : null}
            {data.events.length > 0 ? (
              <section aria-labelledby="admin-usage-events">
                <h3 id="admin-usage-events" className="mb-2 text-sm font-semibold text-text">{t('admin.usage.events', 'Recent events')}</h3>
                <AdminTable
                  caption={t('admin.usage.events', 'Recent events')}
                  columns={[
                    t('admin.usage.event', 'Event'),
                    t('admin.usage.quantity', 'Quantity'),
                    t('admin.usage.when', 'When'),
                  ]}
                >
                  {data.events.map((event) => (
                    <tr key={event.eventId} className="border-b border-border-subtle last:border-b-0">
                      <td className="px-4 py-2.5">
                        <Badge tone="muted">{event.eventType}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-text">{formatQuantity(event.quantity, event.unit)}</td>
                      <td className="px-4 py-2.5 text-text-muted">{formatDateTime(event.createdAt)}</td>
                    </tr>
                  ))}
                </AdminTable>
              </section>
            ) : null}
          </div>
        )}
      </AdminStateBlock>
    </div>
  )
}
