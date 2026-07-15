import type { AdminEntitlements } from '@open-cowork/shared'
import { Badge } from '@open-cowork/ui'
import { t } from '../../helpers/i18n'
import { AdminSectionHeader, AdminStateBlock } from './AdminPrimitives'
import { useAdminResource } from './useAdminResource'

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border-subtle py-2 last:border-b-0">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="text-sm font-medium text-text text-right">{value}</dd>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border-subtle bg-surface p-4">
      <h3 className="mb-2 text-sm font-semibold text-text">{title}</h3>
      <dl>{children}</dl>
    </section>
  )
}

// Deployment section: read-only org / deployment status plus the resolved
// entitlements/adapter status. Entitlements are provided by the shell (they also
// drive conditional billing), so this section only loads the org overview.
export function DeploymentSection({ entitlements }: { entitlements: AdminEntitlements }) {
  const overview = useAdminResource(() => window.coworkApi.admin.overview())

  return (
    <div className="space-y-5">
      <AdminSectionHeader
        title={t('admin.deployment.title', 'Deployment')}
        description={t('admin.deployment.description', 'Organization, deployment mode, and entitlement adapter status.')}
      />
      <AdminStateBlock
        state={overview}
        loadingRows={4}
        emptyTitle={t('admin.deployment.empty.title', 'No deployment details')}
        emptyBody={t('admin.deployment.empty.body', 'The control plane did not return an organization overview.')}
      >
        {(data) => (
          <div className="grid gap-4 md:grid-cols-2">
            <Panel title={t('admin.deployment.org', 'Organization')}>
              <Row label={t('admin.deployment.name', 'Name')} value={data.org.name} />
              <Row label={t('admin.deployment.plan', 'Plan')} value={data.org.planKey || t('admin.deployment.noPlan', 'Default')} />
              <Row
                label={t('admin.deployment.status', 'Status')}
                value={<Badge tone={data.org.status === 'active' ? 'success' : 'warning'}>{data.org.status}</Badge>}
              />
              <Row label={t('admin.deployment.profile', 'Profile')} value={data.profile.label || data.profile.name} />
            </Panel>
            <Panel title={t('admin.deployment.signup', 'Access & signup')}>
              <Row label={t('admin.deployment.signupMode', 'Signup mode')} value={data.signup.mode} />
              <Row
                label={t('admin.deployment.selfService', 'Self-service signup')}
                value={data.signup.allowSelfServiceSignup ? t('common.on', 'On') : t('common.off', 'Off')}
              />
              <Row
                label={t('admin.deployment.domains', 'Allowed domains')}
                value={data.signup.allowedEmailDomains.length ? data.signup.allowedEmailDomains.join(', ') : '—'}
              />
              <Row
                label={t('admin.deployment.channels', 'Channels')}
                value={data.gateway.channelsEnabled ? t('common.on', 'On') : t('common.off', 'Off')}
              />
            </Panel>
            <Panel title={t('admin.deployment.entitlements', 'Entitlements')}>
              <Row label={t('admin.deployment.provider', 'Adapter')} value={entitlements.provider} />
              <Row
                label={t('admin.deployment.gating', 'Gating')}
                value={<Badge tone={entitlements.gatingEnabled ? 'info' : 'muted'}>{entitlements.gatingEnabled ? t('common.on', 'On') : t('common.off', 'Off')}</Badge>}
              />
              <Row
                label={t('admin.deployment.billingAdapter', 'Billing adapter')}
                value={<Badge tone={entitlements.billingEnabled ? 'success' : 'muted'}>{entitlements.billingEnabled ? t('common.on', 'On') : t('common.off', 'Off')}</Badge>}
              />
              <Row label={t('admin.deployment.entPlan', 'Plan')} value={entitlements.planLabel || entitlements.planKey || t('admin.deployment.noPlan', 'Default')} />
            </Panel>
            <Panel title={t('admin.deployment.runtime', 'Runtime policy')}>
              <Row label={t('admin.deployment.configSource', 'Config source')} value={data.runtime.configSource} />
              <Row label={t('admin.deployment.machineRuntime', 'Machine runtime')} value={data.runtime.machineRuntimeConfig} />
              <Row label={t('admin.deployment.stdioMcps', 'Local stdio MCPs')} value={data.runtime.localStdioMcps} />
              <Row label={t('admin.deployment.hostDirs', 'Host directories')} value={data.runtime.hostProjectDirectories} />
            </Panel>
          </div>
        )}
      </AdminStateBlock>
    </div>
  )
}
