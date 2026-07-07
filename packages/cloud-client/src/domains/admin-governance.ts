import type {
  AdminAuditExport,
  AdminAuditExportInput,
  AdminAuditPage,
  AdminAuditQuery,
  AdminManagedPolicyResult,
  AdminProviderKeySecret,
  AdminSetPolicyInput,
  AdminSetProviderKeyInput,
  AdminSsoConfig,
  AdminUsageSummary,
} from '@open-cowork/shared'
import type { CloudAdminDomainContext } from './admin.js'
import { encodePath, queryString } from './shared.js'

function auditQuery(input: AdminAuditQuery = {}) {
  return queryString({
    actorId: input.actorId,
    actorType: input.actorType,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    result: input.result,
    from: input.from,
    to: input.to,
    limit: input.limit,
    cursor: input.cursor,
  })
}

// Admin control-plane client — governance half (#896): managed policy, org
// providers/provider keys (metadata only), SSO status, usage analytics, and audit query +
// export. Spread into the transport adapter alongside the identity half.
export function createCloudAdminGovernanceClient({ request, requestText }: CloudAdminDomainContext) {
  return {
    getManagedPolicy(): Promise<AdminManagedPolicyResult> {
      return request<AdminManagedPolicyResult>('/api/policy')
    },
    setManagedPolicy(input: AdminSetPolicyInput): Promise<AdminManagedPolicyResult> {
      return request<AdminManagedPolicyResult>('/api/policy', { method: 'PUT', body: input })
    },
    async listProviderKeys(): Promise<AdminProviderKeySecret[]> {
      return (await request<{ secrets: AdminProviderKeySecret[] }>('/api/byok')).secrets
    },
    async setProviderKey(providerId: string, input: AdminSetProviderKeyInput): Promise<AdminProviderKeySecret> {
      return (await request<{ secret: AdminProviderKeySecret }>(`/api/byok/${encodePath(providerId)}`, {
        method: 'POST',
        body: input,
      })).secret
    },
    async deleteProviderKey(providerId: string): Promise<boolean> {
      const { secret } = await request<{ secret: AdminProviderKeySecret | null }>(`/api/byok/${encodePath(providerId)}`, {
        method: 'DELETE',
      })
      return secret !== undefined
    },
    async getSsoConfig(): Promise<AdminSsoConfig | null> {
      return (await request<{ sso: AdminSsoConfig | null }>('/api/admin/sso')).sso
    },
    getAdminUsageSummary(limit?: number): Promise<AdminUsageSummary> {
      return request<AdminUsageSummary>(`/api/usage/summary${queryString({ limit })}`)
    },
    queryAudit(filters: AdminAuditQuery = {}): Promise<AdminAuditPage> {
      return request<AdminAuditPage>(`/api/admin/audit${auditQuery(filters)}`)
    },
    async exportAudit(input: AdminAuditExportInput = {}): Promise<AdminAuditExport> {
      const format = input.format === 'csv' ? 'csv' : 'json'
      const query = queryString({
        actorId: input.actorId,
        actorType: input.actorType,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        result: input.result,
        from: input.from,
        to: input.to,
        format,
        unredacted: input.unredacted ? 'true' : undefined,
      })
      const raw = await requestText(`/api/admin/audit/export${query}`)
      return {
        content: raw.content,
        contentType: raw.contentType || (format === 'csv' ? 'text/csv' : 'application/json'),
        filename: raw.filename || `audit-export.${format}`,
      }
    },
  }
}
