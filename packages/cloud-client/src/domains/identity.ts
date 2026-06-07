export type {
  CloudAdminPolicyOverview,
  CloudApiTokenChannelBindingGrantRecord,
  CloudApiTokenRecord,
  CloudApiTokenScope,
  CloudAuditEventRecord,
  CloudIssuedApiTokenRecord,
  CloudOrgMemberRecord,
} from '../contracts.js'

import type {
  CloudAdminPolicyOverview,
  CloudApiTokenChannelBindingGrantRecord,
  CloudApiTokenRecord,
  CloudApiTokenScope,
  CloudAuditEventRecord,
  CloudIssuedApiTokenRecord,
  CloudOrgMemberRecord,
} from '../contracts.js'
import type { CloudDomainClientContext } from './shared.js'
import { encodePath, queryString } from './shared.js'

export type CloudIdentityClient = {
  listApiTokens(): Promise<CloudApiTokenRecord[]>
  issueApiToken(input: {
    name: string
    scopes: CloudApiTokenScope[]
    expiresAt?: string | null
    channelBindingIds?: readonly string[] | null
  }): Promise<CloudIssuedApiTokenRecord>
  revokeApiToken(tokenId: string): Promise<CloudApiTokenRecord | null>
  grantApiTokenChannelBinding(tokenId: string, input: {
    channelBindingId: string
  }): Promise<{ grant: CloudApiTokenChannelBindingGrantRecord, token: CloudApiTokenRecord }>
  getAdminPolicy(): Promise<CloudAdminPolicyOverview>
  listOrgMembers(input?: { query?: string | null, limit?: number | null }): Promise<CloudOrgMemberRecord[]>
  inviteOrgMember(input: { email: string, role?: 'owner' | 'admin' | 'member' | null }): Promise<CloudOrgMemberRecord>
  updateOrgMember(accountId: string, input: {
    role?: 'owner' | 'admin' | 'member' | null
    status?: 'active' | 'invited' | 'disabled' | null
    confirm?: string | null
  }): Promise<CloudOrgMemberRecord>
  listAdminAuditEvents(limit?: number): Promise<CloudAuditEventRecord[]>
}

export function createCloudIdentityClient({ request }: CloudDomainClientContext): CloudIdentityClient {
  return {
    async listApiTokens() {
      return (await request<{ tokens: CloudApiTokenRecord[] }>('/api/api-tokens')).tokens
    },
    issueApiToken(input) {
      return request<CloudIssuedApiTokenRecord>('/api/api-tokens', {
        method: 'POST',
        body: input,
      })
    },
    async revokeApiToken(tokenId) {
      return (await request<{ token: CloudApiTokenRecord | null }>(`/api/api-tokens/${encodePath(tokenId)}`, {
        method: 'DELETE',
      })).token
    },
    grantApiTokenChannelBinding(tokenId, input) {
      return request<{ grant: CloudApiTokenChannelBindingGrantRecord, token: CloudApiTokenRecord }>(
        `/api/api-tokens/${encodePath(tokenId)}/channel-bindings`,
        {
          method: 'POST',
          body: input,
        },
      )
    },
    async getAdminPolicy() {
      return (await request<{ policy: CloudAdminPolicyOverview }>('/api/admin/policy')).policy
    },
    async listOrgMembers(input = {}) {
      return (await request<{ members: CloudOrgMemberRecord[] }>(
        `/api/admin/members${queryString({ q: input.query, limit: input.limit })}`,
      )).members
    },
    async inviteOrgMember(input) {
      return (await request<{ member: CloudOrgMemberRecord }>('/api/admin/members', {
        method: 'POST',
        body: input,
      })).member
    },
    async updateOrgMember(accountId, input) {
      return (await request<{ member: CloudOrgMemberRecord }>(
        `/api/admin/members/${encodePath(accountId)}/update`,
        {
          method: 'POST',
          body: input,
        },
      )).member
    },
    async listAdminAuditEvents(limit) {
      return (await request<{ events: CloudAuditEventRecord[] }>(
        `/api/admin/audit${queryString({ limit })}`,
      )).events
    },
  }
}
