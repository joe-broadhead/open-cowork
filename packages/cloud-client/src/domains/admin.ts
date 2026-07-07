import type {
  AdminAccess,
  AdminCreateRoleInput,
  AdminCustomRole,
  AdminEntitlements,
  AdminMember,
  AdminMemberInviteInput,
  AdminMemberInviteResult,
  AdminMemberListInput,
  AdminMemberUpdateInput,
  AdminOverview,
  AdminUpdateRoleInput,
  ControlPlanePermission,
} from '@open-cowork/shared'
import type { CloudDomainClientContext } from './shared.js'
import { encodePath, queryString } from './shared.js'

// Raw-text transport for the audit export download (JSON or CSV). The standard
// `request` helper JSON-parses every body, which breaks the CSV format and drops
// the content-disposition filename — the governance client is handed this reader.
export type CloudRawTextResponse = {
  content: string
  contentType: string
  filename: string | null
}

export type CloudAdminDomainContext = CloudDomainClientContext & {
  requestText: (path: string) => Promise<CloudRawTextResponse>
}

// Admin control-plane client — identity half (#896): the caller's own access,
// entitlements, org overview, members, and custom roles. The governance half
// (policy/providers/usage/audit) lives in admin-governance.ts; both are spread into
// the transport adapter. Return shapes are enforced by CloudTransportAdapter.
export function createCloudAdminClient({ request }: CloudDomainClientContext) {
  return {
    async getAdminAccess(): Promise<AdminAccess> {
      return (await request<{ access: AdminAccess }>('/api/admin/access')).access
    },
    getEntitlements(): Promise<AdminEntitlements> {
      return request<AdminEntitlements>('/api/billing/entitlements')
    },
    async getAdminOverview(): Promise<AdminOverview> {
      return (await request<{ policy: AdminOverview }>('/api/admin')).policy
    },
    async listAdminMembers(input: AdminMemberListInput = {}): Promise<AdminMember[]> {
      return (await request<{ members: AdminMember[] }>(
        `/api/admin/members${queryString({ q: input.query, limit: input.limit ?? undefined })}`,
      )).members
    },
    inviteAdminMember(input: AdminMemberInviteInput): Promise<AdminMemberInviteResult> {
      return request<AdminMemberInviteResult>('/api/admin/members', {
        method: 'POST',
        body: { email: input.email, role: input.role ?? undefined },
      })
    },
    async updateAdminMember(accountId: string, input: AdminMemberUpdateInput): Promise<AdminMember> {
      return (await request<{ member: AdminMember }>(`/api/admin/members/${encodePath(accountId)}/update`, {
        method: 'POST',
        body: input,
      })).member
    },
    async assignAdminMemberRole(accountId: string, roleKey: string | null): Promise<AdminMember> {
      return (await request<{ member: AdminMember }>(`/api/admin/members/${encodePath(accountId)}/role`, {
        method: 'POST',
        body: { roleKey },
      })).member
    },
    async listPermissionCatalog(): Promise<ControlPlanePermission[]> {
      return (await request<{ permissions: ControlPlanePermission[] }>('/api/admin/permission-catalog')).permissions
    },
    async listCustomRoles(): Promise<AdminCustomRole[]> {
      return (await request<{ roles: AdminCustomRole[] }>('/api/admin/roles')).roles
    },
    async createCustomRole(input: AdminCreateRoleInput): Promise<AdminCustomRole> {
      return (await request<{ role: AdminCustomRole }>('/api/admin/roles', { method: 'POST', body: input })).role
    },
    async updateCustomRole(roleKey: string, input: AdminUpdateRoleInput): Promise<AdminCustomRole> {
      return (await request<{ role: AdminCustomRole }>(`/api/admin/roles/${encodePath(roleKey)}/update`, {
        method: 'POST',
        body: input,
      })).role
    },
    async deleteCustomRole(roleKey: string): Promise<boolean> {
      return Boolean((await request<{ deleted: boolean }>(`/api/admin/roles/${encodePath(roleKey)}`, {
        method: 'DELETE',
      })).deleted)
    },
  }
}
