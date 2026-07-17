import { useMemo, useState } from 'react'
import { Icon, StudioPageHeader } from '@open-cowork/ui'
import { t } from '../../helpers/i18n'
import { AdminError, AdminLoading, AdminPermissionGate } from './AdminPrimitives'
import { useAdminResource } from './useAdminResource'
import {
  availableAdminSections,
  canManage,
  type AdminSectionId,
} from './admin-support'
import { MembersSection } from './MembersSection'
import { RolesSection } from './RolesSection'
import { PoliciesSection } from './PoliciesSection'
import { ProvidersSection } from './ProvidersSection'
import { UsageSection } from './UsageSection'
import { AuditSection } from './AuditSection'
import { DeploymentSection } from './DeploymentSection'
import { BillingSection } from './BillingSection'

// The Admin control plane (#896): a shared-renderer surface (desktop + cloud web)
// that gates its sections and actions on the caller's effective permissions and
// conditionally renders Billing only when the entitlements adapter is enabled.
export function AdminPage() {
  const access = useAdminResource(() => window.coworkApi.admin.access())
  const entitlements = useAdminResource(() => window.coworkApi.admin.entitlements())
  const [activeId, setActiveId] = useState<AdminSectionId | null>(null)

  const sections = useMemo(
    () => availableAdminSections(access.data, entitlements.data),
    [access.data, entitlements.data],
  )

  const active = useMemo(() => {
    if (sections.length === 0) return null
    return sections.find((section) => section.id === activeId) || sections[0]
  }, [activeId, sections])

  // Access + entitlements must resolve before we know which sections to offer.
  if ((access.loading && !access.data) || (entitlements.loading && !entitlements.data)) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <AdminLoading label={t('admin.loading', 'Loading admin controls…')} rows={5} />
      </div>
    )
  }

  if (access.error || entitlements.error) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <AdminError
          message={access.error || entitlements.error || t('admin.loadError', 'Could not load admin controls.')}
          onRetry={() => {
            access.reload()
            entitlements.reload()
          }}
        />
      </div>
    )
  }

  const accessData = access.data
  const entitlementsData = entitlements.data

  if (!accessData || !entitlementsData || sections.length === 0 || !active) {
    return (
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <AdminPermissionGate
          title={t('admin.gated.title', 'No admin access')}
          body={t('admin.gated.body', 'Your role does not grant access to any admin controls. Contact an org owner if you need access.')}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <StudioPageHeader
          eyebrow={t('admin.eyebrow', 'Control plane')}
          title={t('admin.title', 'Admin')}
          description={t('admin.subtitle', 'Manage members, roles, policy, providers, usage, audit, and deployment.')}
        />

        <div className="mt-6 flex flex-col gap-6 lg:flex-row">
          <nav aria-label={t('admin.sectionsNav', 'Admin sections')} className="lg:w-56 lg:flex-shrink-0">
            <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
              {sections.map((section) => {
                const isActive = section.id === active.id
                return (
                  <li key={section.id}>
                    <button
                      type="button"
                      onClick={() => setActiveId(section.id)}
                      aria-current={isActive ? 'page' : undefined}
                      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                        isActive ? 'bg-surface-active font-medium text-text' : 'text-text-muted hover:bg-surface-hover hover:text-text-secondary'
                      }`}
                    >
                      <Icon name={section.icon} size={16} aria-hidden="true" />
                      <span>{t(section.labelKey, section.fallback)}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>

          <section className="min-w-0 flex-1" aria-live="polite">
            {active.id === 'members' ? <MembersSection canManage={canManage(accessData, 'members:manage')} /> : null}
            {active.id === 'roles' ? <RolesSection /> : null}
            {active.id === 'policies' ? <PoliciesSection /> : null}
            {active.id === 'providers' ? (
              <ProvidersSection
                canManageKeys={canManage(accessData, 'policy:manage')}
                canViewSso={canManage(accessData, 'sso:manage')}
              />
            ) : null}
            {active.id === 'usage' ? <UsageSection /> : null}
            {active.id === 'audit' ? <AuditSection canRead={canManage(accessData, 'audit:read')} /> : null}
            {active.id === 'deployment' ? <DeploymentSection entitlements={entitlementsData} /> : null}
            {active.id === 'billing' ? <BillingSection entitlements={entitlementsData} /> : null}
          </section>
        </div>
      </div>
    </div>
  )
}
