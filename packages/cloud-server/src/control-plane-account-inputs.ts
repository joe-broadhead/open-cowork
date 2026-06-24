import type {
  ApiTokenScope,
  AuditActorType,
  ByokSecretStatus,
  ControlPlaneMembershipStatus,
  ControlPlaneRole,
} from './control-plane-enums.ts'

// The control-plane's account / membership / API-token / audit / BYOK operation
// input shapes, extracted from the 4k-line in-memory store. Pure types depending
// only on the enum vocabulary and the intra-module audit-actor input.

export type CreateAccountInput = {
  accountId: string
  idpSubject?: string | null
  email: string
  displayName?: string | null
  createdAt?: Date
}

export type UpsertMembershipInput = {
  orgId: string
  accountId: string
  role: ControlPlaneRole
  status?: ControlPlaneMembershipStatus
  updatedAt?: Date
  actor?: AuditActorInput
}

export type AuditActorInput = {
  actorType: AuditActorType
  actorId?: string | null
  accountId?: string | null
}

export type IssueApiTokenInput = {
  orgId: string
  accountId?: string | null
  name: string
  scopes: ApiTokenScope[]
  expiresAt?: Date | null
  createdAt?: Date
  tokenId?: string
  secret?: string
  actor?: AuditActorInput
}

export type RevokeApiTokenInput = {
  tokenId: string
  orgId?: string | null
  revokedAt?: Date
  actor?: AuditActorInput
}

export type GrantApiTokenChannelBindingInput = {
  orgId: string
  tokenId: string
  channelBindingId: string
  createdAt?: Date
  actor?: AuditActorInput
}

export type ListApiTokenChannelBindingGrantsInput = {
  orgId: string
  tokenId: string
}

export type RecordAuditEventInput = {
  eventId?: string
  orgId: string
  accountId?: string | null
  actorType: AuditActorType
  actorId?: string | null
  eventType: string
  targetType?: string | null
  targetId?: string | null
  metadata?: Record<string, unknown>
  createdAt?: Date
}

export type CreateByokSecretInput = {
  secretId: string
  orgId: string
  providerId: string
  status?: ByokSecretStatus
  ciphertext?: string | null
  kmsRef?: string | null
  last4: string
  keyFingerprint: string
  createdByAccountId?: string | null
  rotatedFromSecretId?: string | null
  createdAt?: Date
  actor?: AuditActorInput
}

export type DisableByokSecretInput = {
  orgId: string
  providerId: string
  secretId?: string | null
  disabledAt?: Date
  actor?: AuditActorInput
}

export type RecordByokSecretValidationInput = {
  orgId: string
  providerId: string
  secretId?: string | null
  status?: ByokSecretStatus
  validationError?: string | null
  validatedAt?: Date
  actor?: AuditActorInput
}
