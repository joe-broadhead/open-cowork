import { useCallback, useMemo, useState } from 'react'
import type { AdminCustomRole, ControlPlanePermission, ControlPlaneRole } from '@open-cowork/shared'
import { Button, Dialog, Input, Select, Textarea, toast } from '../ui'
import { ConfirmDialog } from '../ConfirmDialog'
import { t } from '../../helpers/i18n'
import { AdminSectionHeader, AdminStateBlock, AdminTable } from './AdminPrimitives'
import { useAdminResource } from './useAdminResource'
import { formatDateTime, permissionCatalogByCategory, permissionCopy } from './admin-support'

const BASE_ROLE_OPTIONS = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
  { value: 'owner', label: 'Owner' },
]

type Editor = { mode: 'new' } | { mode: 'edit'; role: AdminCustomRole } | null

type Draft = {
  roleKey: string
  name: string
  description: string
  baseRole: ControlPlaneRole
  permissions: Set<ControlPlanePermission>
}

function draftFor(editor: Editor): Draft {
  if (editor && editor.mode === 'edit') {
    return {
      roleKey: editor.role.roleKey,
      name: editor.role.name,
      description: editor.role.description || '',
      baseRole: editor.role.baseRole,
      permissions: new Set(editor.role.permissions),
    }
  }
  return { roleKey: '', name: '', description: '', baseRole: 'member', permissions: new Set() }
}

// Roles section: create, edit, and delete custom control-plane roles built against
// the permission catalog. Deleting a role is confirmed.
export function RolesSection() {
  const roles = useAdminResource(() => window.coworkApi.admin.roles.list())
  const catalog = useAdminResource(() => window.coworkApi.admin.roles.catalog())
  const [editor, setEditor] = useState<Editor>(null)
  const [draft, setDraft] = useState<Draft>(() => draftFor(null))
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<AdminCustomRole | null>(null)

  const grouped = useMemo(() => permissionCatalogByCategory(catalog.data || []), [catalog.data])

  const openEditor = useCallback((next: Editor) => {
    setDraft(draftFor(next))
    setFormError(null)
    setEditor(next)
  }, [])

  const togglePermission = useCallback((permission: ControlPlanePermission) => {
    setDraft((current) => {
      const permissions = new Set(current.permissions)
      if (permissions.has(permission)) permissions.delete(permission)
      else permissions.add(permission)
      return { ...current, permissions }
    })
  }, [])

  const save = useCallback(async () => {
    if (!editor) return
    if (!draft.name.trim() || (editor.mode === 'new' && !draft.roleKey.trim())) {
      setFormError(t('admin.roles.required', 'A role key and name are required.'))
      return
    }
    setSaving(true)
    setFormError(null)
    const permissions = [...draft.permissions]
    try {
      if (editor.mode === 'new') {
        await window.coworkApi.admin.roles.create({
          roleKey: draft.roleKey.trim(),
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          baseRole: draft.baseRole,
          permissions,
        })
      } else {
        await window.coworkApi.admin.roles.update(editor.role.roleKey, {
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          baseRole: draft.baseRole,
          permissions,
        })
      }
      toast({ message: t('admin.roles.saved', 'Role saved.'), tone: 'success' })
      setEditor(null)
      roles.reload()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [draft, editor, roles])

  const remove = useCallback(async (role: AdminCustomRole) => {
    try {
      await window.coworkApi.admin.roles.delete(role.roleKey)
      toast({ message: t('admin.roles.deleted', 'Role deleted.'), tone: 'success' })
      roles.reload()
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : String(err), tone: 'error' })
    } finally {
      setDeleting(null)
    }
  }, [roles])

  return (
    <div className="space-y-5">
      <AdminSectionHeader
        title={t('admin.roles.title', 'Roles')}
        description={t('admin.roles.description', 'Define custom roles from the permission catalog.')}
        actions={<Button size="sm" onClick={() => openEditor({ mode: 'new' })}>{t('admin.roles.create', 'New role')}</Button>}
      />

      <AdminStateBlock
        state={roles}
        loadingRows={3}
        emptyIcon="badge-check"
        emptyTitle={t('admin.roles.empty.title', 'No custom roles')}
        emptyBody={t('admin.roles.empty.body', 'Built-in roles apply until you add a custom role.')}
        isEmpty={(data) => data.length === 0}
        emptyAction={<Button size="sm" onClick={() => openEditor({ mode: 'new' })}>{t('admin.roles.create', 'New role')}</Button>}
      >
        {(data) => (
          <AdminTable
            caption={t('admin.roles.title', 'Roles')}
            columns={[
              t('admin.roles.role', 'Role'),
              t('admin.roles.permissions', 'Permissions'),
              t('admin.roles.updated', 'Updated'),
              t('admin.roles.actions', 'Actions'),
            ]}
          >
            {data.map((role) => (
              <tr key={role.roleKey} className="border-b border-border-subtle align-top last:border-b-0">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-text">{role.name}</div>
                  <div className="text-xs text-text-muted">{role.roleKey} · {role.baseRole}</div>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-text">{role.permissions.length}</span>
                  <span className="ml-1 text-text-muted">{t('admin.roles.granted', 'granted')}</span>
                </td>
                <td className="px-4 py-2.5 text-text-muted">{formatDateTime(role.updatedAt)}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => openEditor({ mode: 'edit', role })}>{t('common.edit', 'Edit')}</Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(role)}>{t('common.delete', 'Delete')}</Button>
                  </div>
                </td>
              </tr>
            ))}
          </AdminTable>
        )}
      </AdminStateBlock>

      {editor ? (
        <Dialog
          title={editor.mode === 'new' ? t('admin.roles.createTitle', 'New role') : t('admin.roles.editTitle', 'Edit role')}
          size="lg"
          onClose={saving ? () => {} : () => setEditor(null)}
          footer={
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setEditor(null)} disabled={saving}>{t('common.cancel', 'Cancel')}</Button>
              <Button size="sm" onClick={() => void save()} loading={saving}>{t('common.save', 'Save')}</Button>
            </div>
          }
        >
          <div className="space-y-4">
            {formError ? <div role="alert" className="rounded-md border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">{formError}</div> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                <span>{t('admin.roles.key', 'Role key')}</span>
                <Input
                  value={draft.roleKey}
                  disabled={editor.mode === 'edit'}
                  onChange={(event) => setDraft((current) => ({ ...current, roleKey: event.currentTarget.value }))}
                  placeholder="support-lead"
                  aria-label={t('admin.roles.key', 'Role key')}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
                <span>{t('admin.roles.name', 'Display name')}</span>
                <Input
                  value={draft.name}
                  onChange={(event) => setDraft((current) => ({ ...current, name: event.currentTarget.value }))}
                  placeholder="Support Lead"
                  aria-label={t('admin.roles.name', 'Display name')}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
              <span>{t('admin.roles.baseRole', 'Base role')}</span>
              <Select
                label={t('admin.roles.baseRole', 'Base role')}
                options={BASE_ROLE_OPTIONS}
                value={draft.baseRole}
                onChange={(value) => setDraft((current) => ({ ...current, baseRole: value as ControlPlaneRole }))}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
              <span>{t('admin.roles.descriptionLabel', 'Description')}</span>
              <Textarea
                value={draft.description}
                onChange={(event) => setDraft((current) => ({ ...current, description: event.currentTarget.value }))}
                aria-label={t('admin.roles.descriptionLabel', 'Description')}
                rows={2}
              />
            </label>
            <fieldset className="space-y-3">
              <legend className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t('admin.roles.permissions', 'Permissions')}</legend>
              {grouped.map((group) => (
                <div key={group.category}>
                  <div className="mb-1 text-xs font-medium text-text-secondary">{group.category}</div>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {group.entries.map((entry) => (
                      <label key={entry.permission} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-hover">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={draft.permissions.has(entry.permission)}
                          onChange={() => togglePermission(entry.permission)}
                        />
                        <span className="min-w-0 font-medium text-text">
                          {permissionCopy(entry.permission).label}
                          <span className="block text-xs font-normal text-text-muted">{entry.description}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </fieldset>
          </div>
        </Dialog>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={t('admin.roles.confirmTitle', 'Delete role?')}
        body={t('admin.roles.confirmBody', 'Members with this role fall back to their built-in role.')}
        confirmLabel={t('common.delete', 'Delete')}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting ? remove(deleting) : undefined}
      />
    </div>
  )
}
