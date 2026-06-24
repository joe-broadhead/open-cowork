export type ManagedWorkerPoolMode = 'saas_operated' | 'self_hosted' | 'customer_hosted' | 'hybrid'
export type ManagedWorkerPoolStatus = 'active' | 'paused' | 'retired'
export type ManagedWorkerStatus = 'pending' | 'active' | 'draining' | 'paused' | 'retired' | 'revoked' | 'unhealthy'
export type ManagedWorkerCredentialScope = 'heartbeat'

export type ManagedWorkerPoolRecord = {
  poolId: string
  orgId: string
  tenantId: string | null
  name: string
  mode: ManagedWorkerPoolMode
  status: ManagedWorkerPoolStatus
  region: string | null
  capabilities: Record<string, unknown>
  maxWorkers: number | null
  maxConcurrentWork: number | null
  createdAt: string
  updatedAt: string
}

export type ManagedWorkerRecord = {
  workerId: string
  orgId: string
  tenantId: string | null
  poolId: string
  displayName: string
  status: ManagedWorkerStatus
  version: string | null
  capabilities: Record<string, unknown>
  lastHeartbeatAt: string | null
  lastErrorCode: string | null
  lastErrorSummary: string | null
  currentLoad: number
  createdAt: string
  updatedAt: string
  revokedAt: string | null
}

export type ManagedWorkerCredentialRecord = {
  credentialId: string
  orgId: string
  workerId: string
  poolId: string
  tokenHash: string
  scopes: ManagedWorkerCredentialScope[]
  last4: string
  expiresAt: string
  revokedAt: string | null
  lastUsedAt: string | null
  rotatedFromCredentialId: string | null
  createdAt: string
  updatedAt: string
}

export type IssuedManagedWorkerCredentialRecord = {
  credential: ManagedWorkerCredentialRecord
  plaintext: string
}

export type ResolvedManagedWorkerCredentialRecord = {
  credential: ManagedWorkerCredentialRecord
  worker: ManagedWorkerRecord
  pool: ManagedWorkerPoolRecord
}

export type ManagedWorkerHeartbeatRecord = {
  workerId: string
  orgId: string
  tenantId: string | null
  poolId: string
  version: string | null
  capabilities: Record<string, unknown>
  currentLoad: number
  activeWorkIds: string[]
  lastErrorCode: string | null
  lastErrorSummary: string | null
  heartbeatSequence: number | null
  receivedAt: string
}

type ManagedWorkerActorInput = {
  actorType?: 'user' | 'api_token' | 'system'
  actorId?: string | null
  accountId?: string | null
}

export type CreateManagedWorkerPoolInput = {
  poolId?: string
  orgId: string
  name: string
  mode: ManagedWorkerPoolMode
  status?: ManagedWorkerPoolStatus
  region?: string | null
  capabilities?: Record<string, unknown>
  maxWorkers?: number | null
  maxConcurrentWork?: number | null
  createdAt?: Date
  actor?: ManagedWorkerActorInput
}

export type UpdateManagedWorkerPoolInput = {
  orgId: string
  poolId: string
  name?: string
  status?: ManagedWorkerPoolStatus
  region?: string | null
  capabilities?: Record<string, unknown>
  maxWorkers?: number | null
  maxConcurrentWork?: number | null
  updatedAt?: Date
  actor?: ManagedWorkerActorInput
}

export type RegisterManagedWorkerInput = {
  workerId?: string
  orgId: string
  poolId: string
  displayName: string
  status?: ManagedWorkerStatus
  version?: string | null
  capabilities?: Record<string, unknown>
  createdAt?: Date
  actor?: ManagedWorkerActorInput
}

export type UpdateManagedWorkerStatusInput = {
  orgId: string
  workerId: string
  status: ManagedWorkerStatus
  reason?: string | null
  updatedAt?: Date
  actor?: ManagedWorkerActorInput
}

export type IssueManagedWorkerCredentialInput = {
  orgId: string
  workerId: string
  scopes?: ManagedWorkerCredentialScope[]
  expiresAt?: Date
  credentialId?: string
  secret?: string
  rotatedFromCredentialId?: string | null
  createdAt?: Date
  actor?: ManagedWorkerActorInput
}

export type RevokeManagedWorkerCredentialInput = {
  orgId: string
  credentialId: string
  workerId?: string | null
  revokedAt?: Date
  actor?: ManagedWorkerActorInput
}

export type RecordManagedWorkerHeartbeatInput = {
  orgId: string
  workerId: string
  credentialId: string
  version?: string | null
  capabilities?: Record<string, unknown>
  currentLoad?: number
  activeWorkIds?: string[]
  lastErrorCode?: string | null
  lastErrorSummary?: string | null
  heartbeatSequence?: number | null
  now?: Date
}
