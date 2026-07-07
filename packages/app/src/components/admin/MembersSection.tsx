import { useCallback, useState } from 'react'
import type { AdminMember, ControlPlaneRole } from '@open-cowork/shared'
import { Badge, Button, Dialog, Input, Select, toast } from '../ui'
import { ConfirmDialog } from '../ConfirmDialog'
import { t } from '../../helpers/i18n'
import { AdminSectionHeader, AdminStateBlock, AdminTable } from './AdminPrimitives'
import { useAdminResource } from './useAdminResource'
import { formatDateTime, roleLabel } from './admin-support'

const ROLE_OPTIONS = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
  { value: 'owner', label: 'Owner' },
]

function statusTone(status: AdminMember['status']) {
  if (status === 'active') return 'success' as const
  if (status === 'invited') return 'info' as const
  return 'muted' as const
}

// Members section: list, invite, change role, and deprovision org members. Every
// mutation gates on `canManage`; disabling a member is confirmed and echoes the
// accountId the control plane requires for a deprovision.
export function MembersSection({ canManage }: { canManage: boolean }) {
  const members = useAdminResource(() => window.coworkApi.admin.members.list())
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<ControlPlaneRole>('member')
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteBusy, setInviteBusy] = useState(false)
  const [disabling, setDisabling] = useState<AdminMember | null>(null)
  const [busyAccount, setBusyAccount] = useState<string | null>(null)

  const submitInvite = useCallback(async () => {
    const email = inviteEmail.trim()
    if (!email || !email.includes('@')) {
      setInviteError(t('admin.members.invalidEmail', 'Enter a valid email address.'))
      return
    }
    setInviteBusy(true)
    setInviteError(null)
    try {
      await window.coworkApi.admin.members.invite({ email, role: inviteRole })
      toast({ message: t('admin.members.invited', 'Invitation sent.'), tone: 'success' })
      setInviteOpen(false)
      setInviteEmail('')
      setInviteRole('member')
      members.reload()
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : String(err))
    } finally {
      setInviteBusy(false)
    }
  }, [inviteEmail, inviteRole, members])

  const changeRole = useCallback(async (member: AdminMember, role: ControlPlaneRole) => {
    setBusyAccount(member.accountId)
    try {
      await window.coworkApi.admin.members.update(member.accountId, { role })
      toast({ message: t('admin.members.updated', 'Member updated.'), tone: 'success' })
      members.reload()
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : String(err), tone: 'error' })
    } finally {
      setBusyAccount(null)
    }
  }, [members])

  const setStatus = useCallback(async (member: AdminMember, status: AdminMember['status']) => {
    setBusyAccount(member.accountId)
    try {
      await window.coworkApi.admin.members.update(member.accountId, {
        status,
        confirm: status === 'disabled' ? member.accountId : undefined,
      })
      toast({
        message: status === 'disabled'
          ? t('admin.members.deprovisioned', 'Member deprovisioned.')
          : t('admin.members.reactivated', 'Member reactivated.'),
        tone: 'success',
      })
      members.reload()
    } catch (err) {
      toast({ message: err instanceof Error ? err.message : String(err), tone: 'error' })
    } finally {
      setBusyAccount(null)
      setDisabling(null)
    }
  }, [members])

  return (
    <div className="space-y-5">
      <AdminSectionHeader
        title={t('admin.members.title', 'Members')}
        description={t('admin.members.description', 'Invite teammates, change roles, and deprovision access.')}
        actions={
          canManage ? (
            <Button size="sm" onClick={() => setInviteOpen(true)}>{t('admin.members.invite', 'Invite member')}</Button>
          ) : null
        }
      />

      <AdminStateBlock
        state={members}
        loadingRows={4}
        emptyIcon="users"
        emptyTitle={t('admin.members.empty.title', 'No members yet')}
        emptyBody={t('admin.members.empty.body', 'Invite your first teammate to get started.')}
        isEmpty={(data) => data.length === 0}
        emptyAction={canManage ? <Button size="sm" onClick={() => setInviteOpen(true)}>{t('admin.members.invite', 'Invite member')}</Button> : undefined}
      >
        {(data) => (
          <AdminTable
            caption={t('admin.members.title', 'Members')}
            columns={[
              t('admin.members.member', 'Member'),
              t('admin.members.role', 'Role'),
              t('admin.members.status', 'Status'),
              t('admin.members.joined', 'Joined'),
              t('admin.members.actions', 'Actions'),
            ]}
          >
            {data.map((member) => (
              <tr key={member.accountId} className="border-b border-border-subtle align-middle last:border-b-0">
                <td className="px-4 py-2.5">
                  <div className="font-medium text-text">{member.displayName || member.email}</div>
                  <div className="text-xs text-text-muted">{member.email}</div>
                </td>
                <td className="px-4 py-2.5">
                  {canManage ? (
                    <Select
                      label={t('admin.members.roleFor', 'Role for {name}').replace('{name}', member.email)}
                      options={ROLE_OPTIONS}
                      value={member.role}
                      onChange={(value) => void changeRole(member, value as ControlPlaneRole)}
                      disabled={busyAccount === member.accountId}
                    />
                  ) : (
                    <span className="text-text">{roleLabel(member.role)}</span>
                  )}
                  {member.customRoleKey ? <Badge tone="accent" className="ml-2">{member.customRoleKey}</Badge> : null}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={statusTone(member.status)}>{member.status}</Badge>
                </td>
                <td className="px-4 py-2.5 text-text-muted">{formatDateTime(member.createdAt)}</td>
                <td className="px-4 py-2.5">
                  {canManage ? (
                    member.status === 'disabled' ? (
                      <Button variant="secondary" size="sm" onClick={() => void setStatus(member, 'active')} disabled={busyAccount === member.accountId}>
                        {t('admin.members.reactivate', 'Reactivate')}
                      </Button>
                    ) : (
                      <Button variant="danger" size="sm" onClick={() => setDisabling(member)} disabled={busyAccount === member.accountId}>
                        {t('admin.members.deprovision', 'Deprovision')}
                      </Button>
                    )
                  ) : (
                    <span className="text-xs text-text-muted">{t('admin.members.readOnly', 'View only')}</span>
                  )}
                </td>
              </tr>
            ))}
          </AdminTable>
        )}
      </AdminStateBlock>

      {inviteOpen ? (
        <Dialog
          title={t('admin.members.inviteTitle', 'Invite member')}
          size="sm"
          onClose={inviteBusy ? () => {} : () => setInviteOpen(false)}
          footer={
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setInviteOpen(false)} disabled={inviteBusy}>{t('common.cancel', 'Cancel')}</Button>
              <Button size="sm" onClick={() => void submitInvite()} loading={inviteBusy}>{t('admin.members.sendInvite', 'Send invite')}</Button>
            </div>
          }
        >
          <div className="space-y-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
              <span>{t('admin.members.email', 'Email')}</span>
              <Input
                type="email"
                value={inviteEmail}
                error={inviteError}
                onChange={(event) => setInviteEmail(event.currentTarget.value)}
                placeholder="teammate@example.com"
                aria-label={t('admin.members.email', 'Email')}
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-text-muted">
              <span>{t('admin.members.role', 'Role')}</span>
              <Select
                label={t('admin.members.role', 'Role')}
                options={ROLE_OPTIONS}
                value={inviteRole}
                onChange={(value) => setInviteRole(value as ControlPlaneRole)}
              />
            </label>
          </div>
        </Dialog>
      ) : null}

      <ConfirmDialog
        open={disabling !== null}
        title={t('admin.members.confirmTitle', 'Deprovision member?')}
        body={t('admin.members.confirmBody', 'This disables the member and revokes their access immediately.')}
        confirmLabel={t('admin.members.deprovision', 'Deprovision')}
        onCancel={() => setDisabling(null)}
        onConfirm={() => disabling ? setStatus(disabling, 'disabled') : undefined}
      />
    </div>
  )
}
