import type { ApiTokenScope, AuditActorType, ByokSecretStatus, HeadlessAgentStatus } from './control-plane-enums.ts'

// The control-plane's auth-adjacent record shapes — API tokens, audit events,
// BYOK secrets, and headless agents — extracted from the 4k-line in-memory
// store. Pure types depending only on the enum vocabulary.

export type ApiTokenRecord = {
  tokenId: string
  orgId: string
  accountId: string | null
  name: string
  tokenHash: string
  scopes: ApiTokenScope[]
  last4: string
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  createdAt: string
  updatedAt: string
}

export type ApiTokenChannelBindingGrantRecord = {
  orgId: string
  tokenId: string
  channelBindingId: string
  createdAt: string
}

export type IssuedApiTokenRecord = {
  token: ApiTokenRecord
  plaintext: string
}

export type AuditEventRecord = {
  eventId: string
  orgId: string
  accountId: string | null
  actorType: AuditActorType
  actorId: string | null
  eventType: string
  targetType: string | null
  targetId: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

export type ByokSecretRecord = {
  secretId: string
  orgId: string
  providerId: string
  status: ByokSecretStatus
  ciphertext: string | null
  kmsRef: string | null
  last4: string
  keyFingerprint: string
  createdByAccountId: string | null
  rotatedFromSecretId: string | null
  lastValidatedAt: string | null
  validationError: string | null
  createdAt: string
  updatedAt: string
}

export type HeadlessAgentRecord = {
  agentId: string
  orgId: string
  tenantId: string
  profileName: string
  name: string
  status: HeadlessAgentStatus
  managed: boolean
  createdByAccountId: string | null
  createdAt: string
  updatedAt: string
}
