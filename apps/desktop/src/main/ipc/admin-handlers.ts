import type {
  AdminAuditExportInput,
  AdminAuditQuery,
  AdminCreateRoleInput,
  AdminMemberInviteInput,
  AdminMemberListInput,
  AdminMemberUpdateInput,
  AdminSetByokInput,
  AdminSetPolicyInput,
  AdminUpdateRoleInput,
} from '@open-cowork/shared'
import type { IpcHandlerContext } from './context.ts'

// Admin control-plane IPC handlers (#896). The renderer's typed `admin.*` bridge
// funnels through here; each handler resolves the active cloud workspace's admin
// adapter and delegates. RBAC + audit are enforced server-side, so these handlers
// stay thin: validate shapes, then delegate.

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`)
  return value
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Expected a finite number.')
  return value
}

export function registerAdminHandlers(context: IpcHandlerContext) {
  const admin = (event: Parameters<typeof context.workspaceGateway.cloudAdmin>[0]) =>
    context.workspaceGateway.cloudAdmin(event)

  context.ipcMain.handle('admin:access', async (event) => (await admin(event)).getAdminAccess!())

  context.ipcMain.handle('admin:entitlements', async (event) => (await admin(event)).getEntitlements!())

  context.ipcMain.handle('admin:overview', async (event) => (await admin(event)).getAdminOverview!())

  context.ipcMain.handle('admin:members:list', async (event, input?: unknown) => {
    const record = optionalRecord(input, 'member list input') as AdminMemberListInput
    return (await admin(event)).listAdminMembers!(record)
  })

  context.ipcMain.handle('admin:members:invite', async (event, input: unknown) => {
    const record = optionalRecord(input, 'member invite input')
    const payload: AdminMemberInviteInput = {
      email: requireString(record.email, 'email'),
      role: (record.role as AdminMemberInviteInput['role']) ?? undefined,
    }
    return (await admin(event)).inviteAdminMember!(payload)
  })

  context.ipcMain.handle('admin:members:update', async (event, accountId: unknown, input: unknown) => {
    const id = requireString(accountId, 'accountId')
    return (await admin(event)).updateAdminMember!(id, optionalRecord(input, 'member update input') as AdminMemberUpdateInput)
  })

  context.ipcMain.handle('admin:members:assign-role', async (event, accountId: unknown, roleKey: unknown) => {
    const id = requireString(accountId, 'accountId')
    const key = roleKey === null ? null : requireString(roleKey, 'roleKey')
    return (await admin(event)).assignAdminMemberRole!(id, key)
  })

  context.ipcMain.handle('admin:roles:catalog', async (event) => (await admin(event)).listPermissionCatalog!())

  context.ipcMain.handle('admin:roles:list', async (event) => (await admin(event)).listCustomRoles!())

  context.ipcMain.handle('admin:roles:create', async (event, input: unknown) => {
    const record = optionalRecord(input, 'role input')
    const payload: AdminCreateRoleInput = {
      roleKey: requireString(record.roleKey, 'roleKey'),
      name: requireString(record.name, 'name'),
      description: (record.description as string | null | undefined) ?? undefined,
      baseRole: (record.baseRole as AdminCreateRoleInput['baseRole']) ?? undefined,
      permissions: Array.isArray(record.permissions) ? (record.permissions as AdminCreateRoleInput['permissions']) : [],
    }
    return (await admin(event)).createCustomRole!(payload)
  })

  context.ipcMain.handle('admin:roles:update', async (event, roleKey: unknown, input: unknown) => {
    const key = requireString(roleKey, 'roleKey')
    return (await admin(event)).updateCustomRole!(key, optionalRecord(input, 'role update input') as AdminUpdateRoleInput)
  })

  context.ipcMain.handle('admin:roles:delete', async (event, roleKey: unknown) => {
    const key = requireString(roleKey, 'roleKey')
    return (await admin(event)).deleteCustomRole!(key)
  })

  context.ipcMain.handle('admin:policy:get', async (event) => (await admin(event)).getManagedPolicy!())

  context.ipcMain.handle('admin:policy:set', async (event, input: unknown) =>
    (await admin(event)).setManagedPolicy!(optionalRecord(input, 'policy input') as AdminSetPolicyInput))

  context.ipcMain.handle('admin:providers:list-keys', async (event) => (await admin(event)).listByokKeys!())

  context.ipcMain.handle('admin:providers:set-key', async (event, providerId: unknown, input: unknown) => {
    const id = requireString(providerId, 'providerId')
    return (await admin(event)).setByokKey!(id, optionalRecord(input, 'byok input') as AdminSetByokInput)
  })

  context.ipcMain.handle('admin:providers:delete-key', async (event, providerId: unknown) => {
    const id = requireString(providerId, 'providerId')
    return (await admin(event)).deleteByokKey!(id)
  })

  context.ipcMain.handle('admin:providers:sso', async (event) => (await admin(event)).getSsoConfig!())

  context.ipcMain.handle('admin:usage', async (event, limit?: unknown) =>
    (await admin(event)).getAdminUsageSummary!(optionalNumber(limit)))

  context.ipcMain.handle('admin:audit:query', async (event, filters?: unknown) =>
    (await admin(event)).queryAudit!(optionalRecord(filters, 'audit filters') as AdminAuditQuery))

  context.ipcMain.handle('admin:audit:export', async (event, input?: unknown) =>
    (await admin(event)).exportAudit!(optionalRecord(input, 'audit export input') as AdminAuditExportInput))
}
