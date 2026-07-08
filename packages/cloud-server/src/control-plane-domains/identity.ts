import type { ControlPlaneStore } from '../control-plane-store.ts'

export type IdentityControlPlaneStore = Pick<ControlPlaneStore,
  | 'createTenant'
  | 'ensureUser'
  | 'ensureOrgForTenant'
  | 'createAccount'
  | 'findAccountBySubject'
  | 'findAccountByEmail'
  | 'upsertMembership'
  | 'listOrgMembers'
  | 'listOrgMembersPage'
  | 'listMembershipsForAccount'
  | 'resolvePrincipalMembership'
  | 'recordAuditEvent'
  | 'listAuditEvents'
>

export type ApiTokenControlPlaneStore = Pick<ControlPlaneStore,
  | 'issueApiToken'
  | 'listApiTokens'
  | 'findApiTokenByPlaintext'
  | 'revokeApiToken'
>
