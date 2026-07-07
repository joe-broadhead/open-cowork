import { useCallback, useState } from 'react'
import type { AdminByokSecret } from '@open-cowork/shared'
import { Badge, Button, Dialog, Input, toast } from '../ui'
import { ConfirmDialog } from '../ConfirmDialog'
import { t } from '../../helpers/i18n'
import { AdminSectionHeader, AdminStateBlock, AdminTable } from './AdminPrimitives'
import { useAdminResource } from './useAdminResource'
import { formatDateTime } from './admin-support'

function keyTone(status: AdminByokSecret['status']) {
  if (status === 'active') return 'success' as const
  if (status === 'pending_validation') return 'info' as const
  if (status === 'invalid' || status === 'expired') return 'danger' as const
  return 'muted' as const
}

// Providers & Models section: org BYOK key management (metadata only — keys are
// never shown) plus read-only SSO status. Managing keys requires policy:manage;
// SSO status requires sso:manage.
export function ProvidersSection({ canManageKeys, canViewSso }: { canManageKeys: boolean; canViewSso: boolean }) {
  const keys = useAdminResource(() => window.coworkApi.admin.providers.listKeys())
  const sso = useAdminResource(() => (canViewSso ? window.coworkApi.admin.providers.sso() : Promise.resolve(null)), [canViewSso])
  const [addOpen, setAddOpen] = useState(false)
  const [provider, setProvider] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState<AdminByokSecret | null>(null)

  const submit = useCallback(async () => {
    if (!provider.trim() || !apiKey.trim()) {
      setFormError(t('admin.providers.required', 'A provider and key are required.'))
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      await window.coworkApi.admin.providers.setKey(provider.trim(), { apiKey: apiKey.trim(), credentialKind: 'plaintext' })
      toast({ message: t('admin.providers.keySaved', 'Key saved.'), tone: 'success' })
      setAddOpen(false)
      setProvider('')
      setApiKey('')
      keys.reload()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [apiKey, provider, keys])

  const remove = useCallback(async (secret: AdminByokSecret) => {
    try {
      await window.coworkApi.admin.providers.deleteKey(secret.providerId)
      toast({ message: t('admin.providers.keyDeleted', 'Key removed.'), tone: 'success' })
      keys.reload()
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : String(err), tone: 'error' })
    } finally {
      setDeleting(null)
    }
  }, [keys])

  return (
    <div className="space-y-5">
      <AdminSectionHeader
        title={t('admin.providers.title', 'Providers & Models')}
        description={t('admin.providers.description', 'Manage bring-your-own-key credentials and identity providers.')}
        actions={canManageKeys ? <Button size="sm" onClick={() => setAddOpen(true)}>{t('admin.providers.addKey', 'Add key')}</Button> : null}
      />

      <section aria-labelledby="admin-byok-heading" className="space-y-3">
        <h3 id="admin-byok-heading" className="text-sm font-semibold text-text">{t('admin.providers.byok', 'BYOK keys')}</h3>
        <AdminStateBlock
          state={keys}
          loadingRows={3}
          emptyIcon="network"
          emptyTitle={t('admin.providers.empty.title', 'No provider keys')}
          emptyBody={t('admin.providers.empty.body', 'Add a bring-your-own-key credential to manage provider access.')}
          isEmpty={(data) => data.length === 0}
          emptyAction={canManageKeys ? <Button size="sm" onClick={() => setAddOpen(true)}>{t('admin.providers.addKey', 'Add key')}</Button> : undefined}
        >
          {(data) => (
            <AdminTable
              caption={t('admin.providers.byok', 'BYOK keys')}
              columns={[
                t('admin.providers.provider', 'Provider'),
                t('admin.providers.key', 'Key'),
                t('admin.providers.status', 'Status'),
                t('admin.providers.validated', 'Validated'),
                t('admin.providers.actions', 'Actions'),
              ]}
            >
              {data.map((secret) => (
                <tr key={secret.secretId} className="border-b border-border-subtle align-middle last:border-b-0">
                  <td className="px-4 py-2.5 font-medium text-text">{secret.providerId}</td>
                  <td className="px-4 py-2.5 font-mono text-text-muted">••••{secret.last4}</td>
                  <td className="px-4 py-2.5"><Badge tone={keyTone(secret.status)}>{secret.status}</Badge></td>
                  <td className="px-4 py-2.5 text-text-muted">{formatDateTime(secret.lastValidatedAt)}</td>
                  <td className="px-4 py-2.5">
                    {canManageKeys ? (
                      <Button variant="ghost" size="sm" onClick={() => setDeleting(secret)}>{t('common.remove', 'Remove')}</Button>
                    ) : (
                      <span className="text-xs text-text-muted">{t('admin.providers.readOnly', 'View only')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminStateBlock>
      </section>

      {canViewSso ? (
        <section aria-labelledby="admin-sso-heading" className="space-y-3">
          <h3 id="admin-sso-heading" className="text-sm font-semibold text-text">{t('admin.providers.sso', 'Single sign-on')}</h3>
          <AdminStateBlock
            state={sso}
            loadingRows={2}
            emptyTitle={t('admin.providers.ssoEmpty.title', 'SSO not configured')}
            emptyBody={t('admin.providers.ssoEmpty.body', 'No identity provider is connected for this organization.')}
            isEmpty={(data) => data === null}
          >
            {(data) => (data ? (
              <div className="rounded-lg border border-border-subtle bg-surface p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent">{data.protocol.toUpperCase()}</Badge>
                  <Badge tone={data.enabled ? 'success' : 'muted'}>{data.enabled ? t('common.enabled', 'Enabled') : t('common.disabled', 'Disabled')}</Badge>
                  {data.enforced ? <Badge tone="warning">{t('admin.providers.enforced', 'Enforced')}</Badge> : null}
                  {data.scimEnabled ? <Badge tone="info">{t('admin.providers.scim', 'SCIM')}</Badge> : null}
                </div>
                <div className="mt-2 text-text-muted">
                  {data.displayName || t('admin.providers.noName', 'Unnamed provider')}
                  {data.verifiedDomains.length ? ` · ${data.verifiedDomains.join(', ')}` : ''}
                </div>
              </div>
            ) : null)}
          </AdminStateBlock>
        </section>
      ) : null}

      {addOpen ? (
        <Dialog
          title={t('admin.providers.addKeyTitle', 'Add provider key')}
          size="sm"
          onClose={busy ? () => {} : () => setAddOpen(false)}
          footer={
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setAddOpen(false)} disabled={busy}>{t('common.cancel', 'Cancel')}</Button>
              <Button size="sm" onClick={() => void submit()} loading={busy}>{t('common.save', 'Save')}</Button>
            </div>
          }
        >
          <div className="space-y-3">
            {formError ? <div role="alert" className="rounded-md border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">{formError}</div> : null}
            <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
              <span>{t('admin.providers.provider', 'Provider')}</span>
              <Input value={provider} onChange={(event) => setProvider(event.currentTarget.value)} placeholder="anthropic" aria-label={t('admin.providers.provider', 'Provider')} autoFocus />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
              <span>{t('admin.providers.apiKey', 'API key')}</span>
              <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.currentTarget.value)} placeholder="sk-…" aria-label={t('admin.providers.apiKey', 'API key')} />
            </label>
            <p className="text-xs text-text-muted">{t('admin.providers.keyNote', 'The key is stored server-side and never displayed again.')}</p>
          </div>
        </Dialog>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={t('admin.providers.confirmTitle', 'Remove key?')}
        body={t('admin.providers.confirmBody', 'Members relying on this org key lose access until a new key is added.')}
        confirmLabel={t('common.remove', 'Remove')}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting ? remove(deleting) : undefined}
      />
    </div>
  )
}
