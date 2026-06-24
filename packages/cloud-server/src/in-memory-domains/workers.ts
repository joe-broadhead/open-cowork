import {
  clone,
  normalizeListLimit,
  normalizeNonNegativeInteger,
  normalizeNullableText,
  normalizeText,
  nowIso,
  stableJson,
} from './store-helpers.ts'
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type {
  CreateManagedWorkerPoolInput,
  IssueManagedWorkerCredentialInput,
  ManagedWorkerCredentialRecord,
  ManagedWorkerCredentialScope,
  ManagedWorkerHeartbeatRecord,
  ManagedWorkerPoolMode,
  ManagedWorkerPoolRecord,
  ManagedWorkerPoolStatus,
  ManagedWorkerRecord,
  ManagedWorkerStatus,
  RecordAuditEventInput,
  RecordManagedWorkerHeartbeatInput,
  RegisterManagedWorkerInput,
  ResolvedManagedWorkerCredentialRecord,
  RevokeManagedWorkerCredentialInput,
  UpdateManagedWorkerPoolInput,
  UpdateManagedWorkerStatusInput,
} from '../control-plane-store.ts'

const MANAGED_WORKER_TEXT_MAX_LENGTH = 256
const MANAGED_WORKER_METADATA_MAX_BYTES = 16_384
const MANAGED_WORKER_DEFAULT_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1000
const MANAGED_WORKER_SUPPORTED_POOL_MODES = new Set<ManagedWorkerPoolMode>(['saas_operated', 'self_hosted'])

type ManagedWorkersDomainHost = {
  orgTenantId(orgId: string): string | null
  recordAuditEvent(input: RecordAuditEventInput): unknown
}

export class InMemoryManagedWorkersDomain {
  private readonly pools = new Map<string, ManagedWorkerPoolRecord>()
  private readonly workers = new Map<string, ManagedWorkerRecord>()
  private readonly credentials = new Map<string, ManagedWorkerCredentialRecord>()
  private readonly heartbeats = new Map<string, ManagedWorkerHeartbeatRecord>()
  private readonly host: ManagedWorkersDomainHost

  constructor(host: ManagedWorkersDomainHost) {
    this.host = host
  }

  createPool(input: CreateManagedWorkerPoolInput): ManagedWorkerPoolRecord {
    const orgTenantId = this.host.orgTenantId(input.orgId)
    if (!orgTenantId) throw new Error(`Unknown org ${input.orgId}.`)
    const now = nowIso(input.createdAt)
    const record: ManagedWorkerPoolRecord = {
      poolId: input.poolId || stableId('mwp', input.orgId, input.name, now),
      orgId: input.orgId,
      tenantId: orgTenantId,
      name: normalizeText(input.name, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker pool name'),
      mode: normalizePoolMode(input.mode),
      status: normalizePoolStatus(input.status),
      region: normalizeNullableText(input.region, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker pool region'),
      capabilities: normalizeMetadata(input.capabilities, 'Managed worker pool capabilities'),
      maxWorkers: normalizeNullablePositiveInteger(input.maxWorkers, 'Managed worker max workers'),
      maxConcurrentWork: normalizeNullablePositiveInteger(input.maxConcurrentWork, 'Managed worker max concurrent work'),
      createdAt: now,
      updatedAt: now,
    }
    const existing = this.pools.get(record.poolId)
    if (existing) return clone(existing)
    this.pools.set(record.poolId, record)
    this.host.recordAuditEvent({
      orgId: record.orgId,
      accountId: input.actor?.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'managed_worker_pool.created',
      targetType: 'managed_worker_pool',
      targetId: record.poolId,
      metadata: { name: record.name, mode: record.mode, status: record.status, region: record.region },
      createdAt: input.createdAt,
    })
    return clone(record)
  }

  updatePool(input: UpdateManagedWorkerPoolInput): ManagedWorkerPoolRecord | null {
    const existing = this.pools.get(input.poolId)
    if (!existing || existing.orgId !== input.orgId) return null
    const updatedAt = nowIso(input.updatedAt)
    existing.name = input.name === undefined
      ? existing.name
      : normalizeText(input.name, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker pool name')
    existing.status = input.status === undefined
      ? existing.status
      : normalizePoolStatus(input.status)
    existing.region = input.region === undefined
      ? existing.region
      : normalizeNullableText(input.region, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker pool region')
    existing.capabilities = input.capabilities === undefined
      ? existing.capabilities
      : normalizeMetadata(input.capabilities, 'Managed worker pool capabilities')
    existing.maxWorkers = input.maxWorkers === undefined
      ? existing.maxWorkers
      : normalizeNullablePositiveInteger(input.maxWorkers, 'Managed worker max workers')
    existing.maxConcurrentWork = input.maxConcurrentWork === undefined
      ? existing.maxConcurrentWork
      : normalizeNullablePositiveInteger(input.maxConcurrentWork, 'Managed worker max concurrent work')
    existing.updatedAt = updatedAt
    this.host.recordAuditEvent({
      orgId: existing.orgId,
      accountId: input.actor?.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'managed_worker_pool.updated',
      targetType: 'managed_worker_pool',
      targetId: existing.poolId,
      metadata: { name: existing.name, status: existing.status },
      createdAt: input.updatedAt,
    })
    return clone(existing)
  }

  getPool(orgId: string, poolId: string): ManagedWorkerPoolRecord | null {
    const pool = this.pools.get(poolId)
    return pool && pool.orgId === orgId ? clone(pool) : null
  }

  listPools(orgId: string, input: { status?: ManagedWorkerPoolStatus | null, limit?: number | null } = {}): ManagedWorkerPoolRecord[] {
    return Array.from(this.pools.values())
      .filter((pool) => pool.orgId === orgId)
      .filter((pool) => !input.status || pool.status === input.status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, normalizeListLimit(input.limit, 100, 500))
      .map((pool) => clone(pool))
  }

  registerWorker(input: RegisterManagedWorkerInput): ManagedWorkerRecord {
    const pool = this.pools.get(input.poolId)
    if (!pool || pool.orgId !== input.orgId) throw new Error(`Unknown managed worker pool ${input.poolId}.`)
    const now = nowIso(input.createdAt)
    const record: ManagedWorkerRecord = {
      workerId: input.workerId || stableId('mworker', input.orgId, input.poolId, input.displayName, now),
      orgId: input.orgId,
      tenantId: pool.tenantId,
      poolId: input.poolId,
      displayName: normalizeText(input.displayName, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker display name'),
      status: normalizeWorkerStatus(input.status),
      version: normalizeNullableText(input.version, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker version'),
      capabilities: normalizeMetadata(input.capabilities, 'Managed worker capabilities'),
      lastHeartbeatAt: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      currentLoad: 0,
      createdAt: now,
      updatedAt: now,
      revokedAt: input.status === 'revoked' ? now : null,
    }
    const existing = this.workers.get(record.workerId)
    if (existing) return clone(existing)
    this.workers.set(record.workerId, record)
    this.host.recordAuditEvent({
      orgId: record.orgId,
      accountId: input.actor?.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'managed_worker.registered',
      targetType: 'managed_worker',
      targetId: record.workerId,
      metadata: { poolId: record.poolId, status: record.status, displayName: record.displayName },
      createdAt: input.createdAt,
    })
    return clone(record)
  }

  updateWorkerStatus(input: UpdateManagedWorkerStatusInput): ManagedWorkerRecord | null {
    const worker = this.workers.get(input.workerId)
    if (!worker || worker.orgId !== input.orgId) return null
    const status = normalizeWorkerStatus(input.status)
    assertWorkerStatusTransition(worker.status, status)
    const updatedAt = nowIso(input.updatedAt)
    worker.status = status
    worker.updatedAt = updatedAt
    if (status === 'revoked') worker.revokedAt = worker.revokedAt || updatedAt
    this.host.recordAuditEvent({
      orgId: worker.orgId,
      accountId: input.actor?.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: `managed_worker.${status}`,
      targetType: 'managed_worker',
      targetId: worker.workerId,
      metadata: { poolId: worker.poolId, status, reason: input.reason || null },
      createdAt: input.updatedAt,
    })
    return clone(worker)
  }

  getWorker(orgId: string, workerId: string): ManagedWorkerRecord | null {
    const worker = this.workers.get(workerId)
    return worker && worker.orgId === orgId ? clone(worker) : null
  }

  listWorkers(orgId: string, input: { poolId?: string | null, status?: ManagedWorkerStatus | null, limit?: number | null } = {}): ManagedWorkerRecord[] {
    return Array.from(this.workers.values())
      .filter((worker) => worker.orgId === orgId)
      .filter((worker) => !input.poolId || worker.poolId === input.poolId)
      .filter((worker) => !input.status || worker.status === input.status)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, normalizeListLimit(input.limit, 100, 500))
      .map((worker) => clone(worker))
  }

  issueCredential(input: IssueManagedWorkerCredentialInput): { credential: ManagedWorkerCredentialRecord, plaintext: string } {
    const worker = this.workers.get(input.workerId)
    if (!worker || worker.orgId !== input.orgId) throw new Error(`Unknown managed worker ${input.workerId}.`)
    if (worker.status === 'revoked' || worker.status === 'retired') throw new Error('Cannot issue credentials for a terminal managed worker.')
    const generated = generateManagedWorkerCredential(input)
    const createdAt = input.createdAt || new Date()
    const now = createdAt.toISOString()
    const expiresAt = input.expiresAt || new Date(createdAt.getTime() + MANAGED_WORKER_DEFAULT_CREDENTIAL_TTL_MS)
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= createdAt.getTime()) {
      throw new Error('Managed worker credential expiration must be in the future.')
    }
    const record: ManagedWorkerCredentialRecord = {
      credentialId: generated.credentialId,
      orgId: worker.orgId,
      workerId: worker.workerId,
      poolId: worker.poolId,
      tokenHash: hashManagedWorkerCredential(generated.plaintext),
      scopes: normalizeCredentialScopes(input.scopes),
      last4: generated.plaintext.slice(-4),
      expiresAt: expiresAt.toISOString(),
      revokedAt: null,
      lastUsedAt: null,
      rotatedFromCredentialId: input.rotatedFromCredentialId || null,
      createdAt: now,
      updatedAt: now,
    }
    this.credentials.set(record.credentialId, record)
    this.host.recordAuditEvent({
      orgId: record.orgId,
      accountId: input.actor?.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: input.rotatedFromCredentialId ? 'managed_worker_credential.rotated' : 'managed_worker_credential.issued',
      targetType: 'managed_worker_credential',
      targetId: record.credentialId,
      metadata: { workerId: record.workerId, scopes: record.scopes, last4: record.last4 },
      createdAt: input.createdAt,
    })
    return { credential: clone(record), plaintext: generated.plaintext }
  }

  listCredentials(orgId: string, workerId: string): ManagedWorkerCredentialRecord[] {
    return Array.from(this.credentials.values())
      .filter((credential) => credential.orgId === orgId && credential.workerId === workerId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((credential) => clone(credential))
  }

  findCredentialByPlaintext(plaintext: string, now = new Date()): ResolvedManagedWorkerCredentialRecord | null {
    const tokenHash = hashManagedWorkerCredential(plaintext)
    for (const credential of this.credentials.values()) {
      if (!constantTimeStringEquals(credential.tokenHash, tokenHash)) continue
      if (credential.revokedAt) {
        this.recordHeartbeatRejected(credential, 'credential_revoked', now)
        return null
      }
      if (new Date(credential.expiresAt).getTime() <= now.getTime()) {
        this.recordHeartbeatRejected(credential, 'credential_expired', now)
        return null
      }
      const worker = this.workers.get(credential.workerId)
      const pool = this.pools.get(credential.poolId)
      if (!worker || !pool || worker.orgId !== credential.orgId || worker.poolId !== pool.poolId) {
        this.recordHeartbeatRejected(credential, 'worker_missing', now)
        return null
      }
      if (worker.status === 'revoked' || worker.status === 'retired') {
        this.recordHeartbeatRejected(credential, `worker_${worker.status}`, now)
        return null
      }
      credential.lastUsedAt = now.toISOString()
      credential.updatedAt = credential.lastUsedAt
      return { credential: clone(credential), worker: clone(worker), pool: clone(pool) }
    }
    return null
  }

  revokeCredential(input: RevokeManagedWorkerCredentialInput): ManagedWorkerCredentialRecord | null {
    const credential = this.credentials.get(input.credentialId)
    if (!credential || credential.orgId !== input.orgId) return null
    if (input.workerId && credential.workerId !== input.workerId) return null
    const revokedAt = nowIso(input.revokedAt)
    credential.revokedAt = credential.revokedAt || revokedAt
    credential.updatedAt = revokedAt
    this.host.recordAuditEvent({
      orgId: credential.orgId,
      accountId: input.actor?.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'managed_worker_credential.revoked',
      targetType: 'managed_worker_credential',
      targetId: credential.credentialId,
      metadata: { workerId: credential.workerId, last4: credential.last4 },
      createdAt: input.revokedAt,
    })
    return clone(credential)
  }

  recordHeartbeat(input: RecordManagedWorkerHeartbeatInput): ManagedWorkerHeartbeatRecord {
    const worker = this.workers.get(input.workerId)
    const credential = this.credentials.get(input.credentialId)
    if (!worker || worker.orgId !== input.orgId || !credential || credential.workerId !== worker.workerId) {
      throw new Error(`Managed worker ${input.workerId} is not registered.`)
    }
    if (credential.revokedAt) throw new Error('Managed worker credential is revoked.')
    if (new Date(credential.expiresAt).getTime() <= (input.now || new Date()).getTime()) {
      throw new Error('Managed worker credential is expired.')
    }
    if (worker.status === 'revoked' || worker.status === 'retired') {
      throw new Error(`Managed worker ${worker.workerId} cannot heartbeat while ${worker.status}.`)
    }
    const now = nowIso(input.now)
    worker.version = input.version === undefined
      ? worker.version
      : normalizeNullableText(input.version, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker version')
    worker.capabilities = input.capabilities === undefined
      ? worker.capabilities
      : normalizeMetadata(input.capabilities, 'Managed worker capabilities')
    worker.currentLoad = normalizeNonNegativeInteger(input.currentLoad || 0, 'Managed worker current load')
    worker.lastErrorCode = input.lastErrorCode === undefined
      ? worker.lastErrorCode
      : normalizeNullableText(input.lastErrorCode, MANAGED_WORKER_TEXT_MAX_LENGTH, 'Managed worker error code')
    worker.lastErrorSummary = input.lastErrorSummary === undefined
      ? worker.lastErrorSummary
      : input.lastErrorSummary
        ? redactOperationalText(input.lastErrorSummary, 1024, 'Managed worker error summary')
        : null
    worker.lastHeartbeatAt = now
    worker.updatedAt = now
    credential.lastUsedAt = now
    credential.updatedAt = now
    const record: ManagedWorkerHeartbeatRecord = {
      workerId: worker.workerId,
      orgId: worker.orgId,
      tenantId: worker.tenantId,
      poolId: worker.poolId,
      version: worker.version,
      capabilities: clone(worker.capabilities),
      currentLoad: worker.currentLoad,
      activeWorkIds: normalizeIdList(input.activeWorkIds || [], 'Managed worker active work ids', 500),
      lastErrorCode: worker.lastErrorCode,
      lastErrorSummary: worker.lastErrorSummary,
      heartbeatSequence: input.heartbeatSequence === undefined || input.heartbeatSequence === null
        ? null
        : normalizeNonNegativeInteger(input.heartbeatSequence, 'Managed worker heartbeat sequence'),
      receivedAt: now,
    }
    this.heartbeats.set(worker.workerId, record)
    return clone(record)
  }

  listHeartbeats(orgId: string, input: { workerId?: string | null, limit?: number | null } = {}): ManagedWorkerHeartbeatRecord[] {
    return Array.from(this.heartbeats.values())
      .filter((heartbeat) => heartbeat.orgId === orgId)
      .filter((heartbeat) => !input.workerId || heartbeat.workerId === input.workerId)
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, normalizeListLimit(input.limit, 100, 500))
      .map((heartbeat) => clone(heartbeat))
  }

  private recordHeartbeatRejected(
    credential: ManagedWorkerCredentialRecord,
    reason: string,
    now: Date,
  ) {
    this.host.recordAuditEvent({
      orgId: credential.orgId,
      actorType: 'system',
      actorId: credential.workerId,
      eventType: 'managed_worker_heartbeat.rejected',
      targetType: 'managed_worker',
      targetId: credential.workerId,
      metadata: {
        credentialId: credential.credentialId,
        poolId: credential.poolId,
        reason,
        last4: credential.last4,
      },
      createdAt: now,
    })
  }
}

export function hashManagedWorkerCredential(plaintext: string) {
  return `scrypt:${scryptSync(plaintext, 'open-cowork-managed-worker-credential-v1', 32).toString('base64url')}`
}

export function generateManagedWorkerCredential(input: { credentialId?: string, secret?: string } = {}) {
  const credentialId = input.credentialId || `mwcred_${randomBytes(12).toString('base64url')}`
  const secret = input.secret || randomBytes(32).toString('base64url')
  return {
    credentialId,
    plaintext: `ocw_${credentialId}_${secret}`,
  }
}

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

function normalizeNullablePositiveInteger(value: number | null | undefined, label: string): number | null {
  if (value === undefined || value === null) return null
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`)
  return value
}

function normalizePoolMode(value: ManagedWorkerPoolMode): ManagedWorkerPoolMode {
  if (!MANAGED_WORKER_SUPPORTED_POOL_MODES.has(value)) {
    throw new Error(`Managed worker pool mode ${value} is not supported in v1.`)
  }
  return value
}

function normalizePoolStatus(value: ManagedWorkerPoolStatus | undefined): ManagedWorkerPoolStatus {
  if (!value) return 'active'
  if (value === 'active' || value === 'paused' || value === 'retired') return value
  throw new Error(`Unsupported managed worker pool status ${String(value)}.`)
}

function normalizeWorkerStatus(value: ManagedWorkerStatus | undefined): ManagedWorkerStatus {
  if (!value) return 'pending'
  if (
    value === 'pending'
    || value === 'active'
    || value === 'draining'
    || value === 'paused'
    || value === 'retired'
    || value === 'revoked'
    || value === 'unhealthy'
  ) return value
  throw new Error(`Unsupported managed worker status ${String(value)}.`)
}

function assertWorkerStatusTransition(from: ManagedWorkerStatus, to: ManagedWorkerStatus) {
  if (from === to) return
  const allowed: Record<ManagedWorkerStatus, ManagedWorkerStatus[]> = {
    pending: ['active', 'revoked'],
    active: ['draining', 'paused', 'unhealthy', 'retired', 'revoked'],
    draining: ['active', 'retired', 'revoked', 'unhealthy'],
    paused: ['active', 'retired', 'revoked'],
    unhealthy: ['active', 'draining', 'retired', 'revoked'],
    retired: [],
    revoked: [],
  }
  if (!allowed[from].includes(to)) throw new Error(`Invalid managed worker transition from ${from} to ${to}.`)
}

function normalizeCredentialScopes(scopes: ManagedWorkerCredentialScope[] | undefined): ManagedWorkerCredentialScope[] {
  const normalized = [...new Set(scopes?.length ? scopes : ['heartbeat'])]
  if (normalized.some((scope) => scope !== 'heartbeat')) throw new Error('Managed worker credential scope is unsupported.')
  return normalized as ManagedWorkerCredentialScope[]
}

function normalizeMetadata(value: Record<string, unknown> | undefined, label: string) {
  return normalizeRecord(value || {}, label, MANAGED_WORKER_METADATA_MAX_BYTES)
}

function normalizeIdList(values: readonly unknown[], label: string, maxLength: number) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`)
  if (values.length > maxLength) throw new Error(`${label} exceeds ${maxLength} entries.`)
  return [...new Set(values.map((value) => normalizeText(value, 256, label)))]
}

function normalizeRecord(value: unknown, label: string, maxBytes: number): Record<string, unknown> {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? clone(value as Record<string, unknown>)
    : {}
  const serialized = stableJson(record)
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  }
  return record
}

function redactOperationalText(value: unknown, maxLength: number, label: string) {
  return normalizeText(value, maxLength, label)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]')
    .replace(/\b(api[_-]?key|token|secret|password|authorization)=([^\s&]+)/gi, '$1=[redacted]')
    .replace(/\b(gcp-sm|aws-sm|azure-kv|env):[^\s,)]+/gi, '$1:[redacted]')
    .replace(/\b(sk-[A-Za-z0-9._-]{6,})\b/g, '[redacted]')
    .replace(/\b(occ_[A-Za-z0-9._-]{8,})\b/g, '[redacted]')
    .replace(/\b(ocw_[A-Za-z0-9._-]{8,})\b/g, '[redacted]')
    .replace(/\b([A-Za-z0-9_-]{32,})\b/g, '[redacted]')
}

function constantTimeStringEquals(left: string, right: string) {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}
