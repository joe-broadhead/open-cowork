import type {
  ControlPlaneStore,
  ApiTokenScope,
  ManagedWorkerCredentialRecord,
  ManagedWorkerHeartbeatRecord,
  ManagedWorkerPoolMode,
  ManagedWorkerPoolRecord,
  ManagedWorkerPoolStatus,
  ManagedWorkerRecord,
  ManagedWorkerStatus,
} from '../control-plane-store.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import type { CloudPrincipal } from '../session-service.ts'

export type PublicManagedWorkerCredentialRecord = Omit<ManagedWorkerCredentialRecord, 'tokenHash'>

export type IssuedPublicManagedWorkerCredentialRecord = {
  credential: PublicManagedWorkerCredentialRecord
  plaintext: string
}

export type CreateManagedWorkerPoolRequest = {
  poolId?: string
  name: string
  mode: ManagedWorkerPoolMode
  status?: ManagedWorkerPoolStatus
  tenantId?: string | null
  region?: string | null
  capabilities?: Record<string, unknown>
  maxWorkers?: number | null
  maxConcurrentWork?: number | null
}

export type UpdateManagedWorkerPoolRequest = {
  name?: string
  status?: ManagedWorkerPoolStatus
  region?: string | null
  capabilities?: Record<string, unknown>
  maxWorkers?: number | null
  maxConcurrentWork?: number | null
}

export type RegisterManagedWorkerRequest = {
  workerId?: string
  poolId: string
  tenantId?: string | null
  displayName: string
  status?: ManagedWorkerStatus
  version?: string | null
  capabilities?: Record<string, unknown>
}

export type ListManagedWorkersRequest = {
  poolId?: string | null
  status?: ManagedWorkerStatus | null
  limit?: number | null
}

export type ManagedWorkerHeartbeatRequest = {
  version?: string | null
  capabilities?: Record<string, unknown>
  currentLoad?: number
  activeWorkIds?: string[]
  lastErrorCode?: string | null
  lastErrorSummary?: string | null
  heartbeatSequence?: number | null
}

export class CloudManagedWorkerService {
  private readonly store: ControlPlaneStore
  private readonly ensurePrincipal: (principal: CloudPrincipal) => Promise<void>

  constructor(
    store: ControlPlaneStore,
    ensurePrincipal: (principal: CloudPrincipal) => Promise<void>,
  ) {
    this.store = store
    this.ensurePrincipal = ensurePrincipal
  }

  async createPool(
    principal: CloudPrincipal,
    input: CreateManagedWorkerPoolRequest,
  ): Promise<ManagedWorkerPoolRecord> {
    await this.ensurePrincipal(principal)
    this.assertWorkerAdmin(principal)
    return this.store.createManagedWorkerPool({
      ...input,
      orgId: principalOrgId(principal),
      actor: auditActor(principal),
    })
  }

  async updatePool(
    principal: CloudPrincipal,
    poolId: string,
    input: UpdateManagedWorkerPoolRequest,
  ): Promise<ManagedWorkerPoolRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertWorkerAdmin(principal)
    return this.store.updateManagedWorkerPool({
      ...input,
      orgId: principalOrgId(principal),
      poolId,
      actor: auditActor(principal),
    })
  }

  async listPools(
    principal: CloudPrincipal,
    input: { status?: ManagedWorkerPoolStatus | null, limit?: number | null } = {},
  ): Promise<ManagedWorkerPoolRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertWorkerAdmin(principal)
    return this.store.listManagedWorkerPools(principalOrgId(principal), input)
  }

  async registerWorker(
    principal: CloudPrincipal,
    input: RegisterManagedWorkerRequest,
  ): Promise<ManagedWorkerRecord> {
    await this.ensurePrincipal(principal)
    this.assertWorkerAdmin(principal)
    return this.store.registerManagedWorker({
      ...input,
      orgId: principalOrgId(principal),
      actor: auditActor(principal),
    })
  }

  async listWorkers(
    principal: CloudPrincipal,
    input: ListManagedWorkersRequest = {},
  ): Promise<ManagedWorkerRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertWorkerAdmin(principal)
    return this.store.listManagedWorkers(principalOrgId(principal), input)
  }

  async getWorker(principal: CloudPrincipal, workerId: string): Promise<ManagedWorkerRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertWorkerAdmin(principal)
    return this.store.getManagedWorker(principalOrgId(principal), workerId)
  }

  async updateWorkerLifecycle(
    principal: CloudPrincipal,
    workerId: string,
    status: ManagedWorkerStatus,
    input: { reason?: string | null } = {},
  ): Promise<ManagedWorkerRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertWorkerAdmin(principal)
    try {
      return await this.store.updateManagedWorkerStatus({
        orgId: principalOrgId(principal),
        workerId,
        status,
        reason: input.reason || null,
        actor: auditActor(principal),
      })
    } catch (error) {
      if (error instanceof Error && /Invalid managed worker transition/.test(error.message)) {
        throw new CloudServiceError(400, error.message)
      }
      throw error
    }
  }

  async issueCredential(
    principal: CloudPrincipal,
    workerId: string,
    input: { scopes?: string[] | null, expiresAt?: Date | null } = {},
  ): Promise<IssuedPublicManagedWorkerCredentialRecord> {
    await this.ensurePrincipal(principal)
    this.assertWorkerAdmin(principal)
    const issued = await this.store.issueManagedWorkerCredential({
      orgId: principalOrgId(principal),
      workerId,
      scopes: normalizeCredentialScopes(input.scopes),
      expiresAt: input.expiresAt || undefined,
      actor: auditActor(principal),
    })
    return {
      credential: publicCredential(issued.credential),
      plaintext: issued.plaintext,
    }
  }

  async listCredentials(
    principal: CloudPrincipal,
    workerId: string,
  ): Promise<PublicManagedWorkerCredentialRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertWorkerAdmin(principal)
    return (await this.store.listManagedWorkerCredentials(principalOrgId(principal), workerId))
      .map(publicCredential)
  }

  async rotateCredential(
    principal: CloudPrincipal,
    workerId: string,
    credentialId: string,
    input: { expiresAt?: Date | null } = {},
  ): Promise<IssuedPublicManagedWorkerCredentialRecord> {
    await this.ensurePrincipal(principal)
    this.assertWorkerAdmin(principal)
    const orgId = principalOrgId(principal)
    const previous = await this.store.revokeManagedWorkerCredential({
      orgId,
      workerId,
      credentialId,
      actor: auditActor(principal),
    })
    if (!previous) throw new CloudServiceError(404, 'Managed worker credential was not found.')
    const issued = await this.store.issueManagedWorkerCredential({
      orgId,
      workerId,
      scopes: previous.scopes,
      expiresAt: input.expiresAt || undefined,
      rotatedFromCredentialId: previous.credentialId,
      actor: auditActor(principal),
    })
    return {
      credential: publicCredential(issued.credential),
      plaintext: issued.plaintext,
    }
  }

  async revokeCredential(
    principal: CloudPrincipal,
    workerId: string,
    credentialId: string,
  ): Promise<PublicManagedWorkerCredentialRecord | null> {
    await this.ensurePrincipal(principal)
    this.assertWorkerAdmin(principal)
    const credential = await this.store.revokeManagedWorkerCredential({
      orgId: principalOrgId(principal),
      workerId,
      credentialId,
      actor: auditActor(principal),
    })
    return credential ? publicCredential(credential) : null
  }

  async recordHeartbeat(
    principal: CloudPrincipal,
    workerId: string,
    input: ManagedWorkerHeartbeatRequest = {},
  ): Promise<ManagedWorkerHeartbeatRecord> {
    if (!principalCanHeartbeatWorker(principal, workerId)) {
      throw new CloudServiceError(403, 'Managed worker heartbeat requires this worker credential.')
    }
    return this.store.recordManagedWorkerHeartbeat({
      orgId: principalOrgId(principal),
      workerId,
      credentialId: principal.workerCredentialId || '',
      ...input,
    })
  }

  async listHeartbeats(
    principal: CloudPrincipal,
    input: { workerId?: string | null, limit?: number | null } = {},
  ): Promise<ManagedWorkerHeartbeatRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertWorkerAdmin(principal)
    return this.store.listManagedWorkerHeartbeats(principalOrgId(principal), input)
  }

  private assertWorkerAdmin(principal: CloudPrincipal) {
    if (!principalCanManageWorkers(principal)) {
      throw new CloudServiceError(403, 'Managed worker administration requires an org admin, operator, or admin-scoped API token.')
    }
  }
}

function hasTokenScope(principal: CloudPrincipal, scope: ApiTokenScope) {
  return principal.tokenScopes?.includes(scope) || principal.tokenScopes?.includes('admin') || false
}

function principalCanManageWorkers(principal: CloudPrincipal) {
  if (principal.authSource === 'local') return true
  if (principal.authSource === 'api_token') return hasTokenScope(principal, 'admin') || hasTokenScope(principal, 'operator')
  return principal.role === 'owner' || principal.role === 'admin'
}

function principalCanHeartbeatWorker(principal: CloudPrincipal, workerId: string) {
  return principal.authSource === 'worker'
    && principal.workerId === workerId
    && (principal.workerScopes || []).includes('heartbeat')
}

function principalOrgId(principal: CloudPrincipal) {
  return principal.orgId || principal.tenantId
}

function auditActor(principal: CloudPrincipal) {
  return {
    actorType: principal.authSource === 'api_token' ? 'api_token' as const : 'user' as const,
    actorId: principal.tokenId || principal.userId,
    accountId: principal.accountId || principal.userId,
  }
}

function normalizeCredentialScopes(scopes: string[] | null | undefined): Array<'heartbeat'> {
  const normalized = [...new Set(scopes?.length ? scopes : ['heartbeat'])]
  if (normalized.some((scope) => scope !== 'heartbeat')) {
    throw new CloudServiceError(400, 'Managed worker credential scope is unsupported.')
  }
  return normalized as Array<'heartbeat'>
}

function publicCredential(
  credential: ManagedWorkerCredentialRecord,
): PublicManagedWorkerCredentialRecord {
  const { tokenHash: _tokenHash, ...publicCredentialRecord } = credential
  return publicCredentialRecord
}
