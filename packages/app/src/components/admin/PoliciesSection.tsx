import { useCallback, useEffect, useState } from 'react'
import type {
  AdminManagedPolicyResult, AdminSetPolicyInput, ManagedPolicyPermissionCeiling, ManagedPolicyPermissionDimension, } from '@open-cowork/shared'
import { MANAGED_POLICY_PERMISSION_DIMENSIONS } from '@open-cowork/shared'
import { Button, Input, SegmentedControl, Select, Switch } from '@open-cowork/ui'
import { toast } from '../ui/Toaster'
import { t } from '../../helpers/i18n'
import { AdminSectionHeader, AdminStateBlock } from './AdminPrimitives'
import { useAdminResource } from './useAdminResource'

const KEY_MANAGEMENT_OPTIONS = [
  { value: 'any', label: 'Any key' },
  { value: 'byok_required', label: 'BYOK required' },
  { value: 'org_managed_required', label: 'Org-managed required' },
]

const CEILING_OPTIONS = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask' },
  { value: 'deny', label: 'Deny' },
]

type Draft = {
  keyManagement: string
  updateChannel: string
  customProviders: boolean
  customMcps: boolean
  customSkills: boolean
  allowedProviders: string
  deniedProviders: string
  allowedModels: string
  deniedModels: string
  ceilings: Record<ManagedPolicyPermissionDimension, ManagedPolicyPermissionCeiling>
}

function parseList(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean)
}

function draftFrom(result: AdminManagedPolicyResult): Draft {
  const view = result.view
  return {
    keyManagement: view.keyManagement,
    updateChannel: view.updateChannel || '',
    customProviders: view.extensions.customProviders,
    customMcps: view.extensions.customMcps,
    customSkills: view.extensions.customSkills,
    allowedProviders: (view.allowedProviders || []).join(', '),
    deniedProviders: view.deniedProviders.join(', '),
    allowedModels: (view.allowedModels || []).join(', '),
    deniedModels: view.deniedModels.join(', '),
    ceilings: { ...view.permissionCeilings },
  }
}

function ToggleRow({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border-subtle py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm font-medium text-text">{label}</div>
        <div className="text-xs text-text-muted">{description}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  )
}

// Policies section: the managed desktop-policy editor. Clear on/off toggles for the
// extension classes, key-management + update-channel scoping, provider/model
// allow/deny lists, and per-dimension permission ceilings. Requires policy:manage.
export function PoliciesSection() {
  const policy = useAdminResource(() => window.coworkApi.admin.policy.get())
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (policy.data) setDraft(draftFrom(policy.data))
  }, [policy.data])

  const save = useCallback(async () => {
    if (!draft) return
    setSaving(true)
    const input: AdminSetPolicyInput = {
      keyManagement: draft.keyManagement as AdminSetPolicyInput['keyManagement'],
      updateChannel: draft.updateChannel.trim() || null,
      extensions: {
        customProviders: draft.customProviders,
        customMcps: draft.customMcps,
        customSkills: draft.customSkills,
      },
      allowedProviders: parseList(draft.allowedProviders).length ? parseList(draft.allowedProviders) : null,
      deniedProviders: parseList(draft.deniedProviders),
      allowedModels: parseList(draft.allowedModels).length ? parseList(draft.allowedModels) : null,
      deniedModels: parseList(draft.deniedModels),
      permissionCeilings: draft.ceilings,
    }
    try {
      const next = await window.coworkApi.admin.policy.set(input)
      setDraft(draftFrom(next))
      toast({ message: t('admin.policy.saved', 'Policy saved.'), tone: 'success' })
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : String(err), tone: 'error' })
    } finally {
      setSaving(false)
    }
  }, [draft])

  return (
    <div className="space-y-5">
      <AdminSectionHeader
        title={t('admin.policy.title', 'Policies')}
        description={t('admin.policy.description', 'Manage the org-wide desktop policy every seat enforces.')}
        actions={
          <Button size="sm" onClick={() => void save()} loading={saving} disabled={!draft}>
            {t('admin.policy.save', 'Save policy')}
          </Button>
        }
      />

      <AdminStateBlock
        state={policy}
        loadingRows={5}
        emptyTitle={t('admin.policy.empty.title', 'No policy')}
        emptyBody={t('admin.policy.empty.body', 'This organization has no managed policy configured yet.')}
      >
        {() => (draft ? (
          <div className="space-y-5">
            <section className="rounded-lg border border-border-subtle bg-surface p-4">
              <h3 className="mb-2 text-sm font-semibold text-text">{t('admin.policy.extensions', 'Extension classes')}</h3>
              <ToggleRow
                label={t('admin.policy.customProviders', 'Custom providers')}
                description={t('admin.policy.customProvidersDesc', 'Allow members to add their own providers.')}
                checked={draft.customProviders}
                onChange={(next) => setDraft((current) => current && { ...current, customProviders: next })}
              />
              <ToggleRow
                label={t('admin.policy.customMcps', 'Custom MCPs')}
                description={t('admin.policy.customMcpsDesc', 'Allow members to add their own MCP servers.')}
                checked={draft.customMcps}
                onChange={(next) => setDraft((current) => current && { ...current, customMcps: next })}
              />
              <ToggleRow
                label={t('admin.policy.customSkills', 'Custom skills')}
                description={t('admin.policy.customSkillsDesc', 'Allow members to author custom skills.')}
                checked={draft.customSkills}
                onChange={(next) => setDraft((current) => current && { ...current, customSkills: next })}
              />
            </section>

            <section className="grid gap-4 md:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                <span>{t('admin.policy.keyManagement', 'Key management')}</span>
                <Select
                  label={t('admin.policy.keyManagement', 'Key management')}
                  options={KEY_MANAGEMENT_OPTIONS}
                  value={draft.keyManagement}
                  onChange={(value) => setDraft((current) => current && { ...current, keyManagement: value })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                <span>{t('admin.policy.updateChannel', 'Update channel')}</span>
                <Input
                  value={draft.updateChannel}
                  onChange={(event) => setDraft((current) => current && { ...current, updateChannel: event.currentTarget.value })}
                  placeholder="stable"
                  aria-label={t('admin.policy.updateChannel', 'Update channel')}
                />
              </label>
            </section>

            <section className="grid gap-4 md:grid-cols-2">
              {([
                ['allowedProviders', t('admin.policy.allowedProviders', 'Allowed providers')],
                ['deniedProviders', t('admin.policy.deniedProviders', 'Denied providers')],
                ['allowedModels', t('admin.policy.allowedModels', 'Allowed models')],
                ['deniedModels', t('admin.policy.deniedModels', 'Denied models')],
              ] as const).map(([field, label]) => (
                <label key={field} className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                  <span>{label}</span>
                  <Input
                    value={draft[field]}
                    onChange={(event) => setDraft((current) => current && { ...current, [field]: event.currentTarget.value })}
                    placeholder={t('admin.policy.commaSeparated', 'Comma-separated, blank for all')}
                    aria-label={label}
                  />
                </label>
              ))}
            </section>

            <section className="rounded-lg border border-border-subtle bg-surface p-4">
              <h3 className="mb-3 text-sm font-semibold text-text">{t('admin.policy.ceilings', 'Permission ceilings')}</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {MANAGED_POLICY_PERMISSION_DIMENSIONS.map((dimension) => (
                  <div key={dimension} className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-text-muted">{dimension}</span>
                    <SegmentedControl
                      label={dimension}
                      options={CEILING_OPTIONS}
                      value={draft.ceilings[dimension]}
                      onChange={(value) => setDraft((current) => current && {
                        ...current,
                        ceilings: { ...current.ceilings, [dimension]: value as ManagedPolicyPermissionCeiling },
                      })}
                    />
                  </div>
                ))}
              </div>
            </section>
          </div>
        ) : null)}
      </AdminStateBlock>
    </div>
  )
}
