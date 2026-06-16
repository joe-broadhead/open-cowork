import type { ControlPlaneMembershipStatus, ControlPlaneRole } from './control-plane-enums.ts'

// The control-plane's core identity/org/account record shapes, extracted from the
// 4k-line in-memory store so the foundational data contracts live in one small,
// dependency-light module shared by the store, the Postgres store, the interface
// contract, and the route layer. Pure types only; they depend only on the
// enum vocabulary in control-plane-enums.ts.

export type TenantRecord = {
  tenantId: string
  name: string
  createdAt: string
}

export type UserRecord = {
  tenantId: string
  userId: string
  email: string
  role: ControlPlaneRole
  createdAt: string
}

export type OrgRecord = {
  orgId: string
  tenantId: string
  name: string
  planKey: string | null
  status: string
  createdAt: string
  updatedAt: string
}

export type AccountRecord = {
  accountId: string
  idpSubject: string | null
  email: string
  displayName: string | null
  createdAt: string
  updatedAt: string
}

export type MembershipRecord = {
  orgId: string
  accountId: string
  role: ControlPlaneRole
  status: ControlPlaneMembershipStatus
  createdAt: string
  updatedAt: string
}

export type OrgMemberRecord = {
  orgId: string
  accountId: string
  email: string
  displayName: string | null
  role: ControlPlaneRole
  status: ControlPlaneMembershipStatus
  createdAt: string
  updatedAt: string
}

export type PrincipalMembershipRecord = {
  org: OrgRecord
  account: AccountRecord
  membership: MembershipRecord
}
