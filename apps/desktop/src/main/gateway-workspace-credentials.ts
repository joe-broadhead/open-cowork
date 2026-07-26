import {
  readSafeStorageBackendForPolicy,
  resolveSecretStorageMode,
  type SecretStorageMode,
} from '@open-cowork/runtime-host/secure-storage-policy'
import { getAppPathHost, getSafeStorageHost, writeFileAtomic } from '@open-cowork/shared/node'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getAppDataDir } from '@open-cowork/runtime-host/config'

type SecretStorageAdapter = {
  mode: SecretStorageMode
  encryptString: (plaintext: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export type GatewayWorkspaceCredentialRecord = {
  workspaceId: string
  token: string
  updatedAt: string
}

export type GatewayWorkspaceCredentialInput = {
  workspaceId: string
  token: string
}

export type GatewayWorkspaceCredentialMetadata = {
  workspaceId: string
  hasToken: boolean
  updatedAt: string
}

export type GatewayWorkspaceCredentialUnavailableReason =
  | 'secure-storage-unavailable'
  | 'read-failed'
  | 'decrypt-failed'
  | 'recovery-failed'

export type GatewayWorkspaceCredentialCorruptReason =
  | 'invalid-payload'
  | 'invalid-record'

export type GatewayWorkspaceCredentialReadFailure =
  | {
      status: 'unavailable'
      reason: GatewayWorkspaceCredentialUnavailableReason
    }
  | {
      status: 'corrupt'
      reason: GatewayWorkspaceCredentialCorruptReason
    }

export type GatewayWorkspaceCredentialReadResult =
  | {
      status: 'available'
      credential: GatewayWorkspaceCredentialRecord
    }
  | {
      status: 'missing'
    }
  | GatewayWorkspaceCredentialReadFailure

export type GatewayWorkspaceCredentialTokenResult =
  | {
      status: 'available'
      token: string
      updatedAt: string
    }
  | {
      status: 'missing'
    }
  | GatewayWorkspaceCredentialReadFailure

export type GatewayWorkspaceCredentialMetadataResult =
  | {
      status: 'available'
      credentials: GatewayWorkspaceCredentialMetadata[]
    }
  | GatewayWorkspaceCredentialReadFailure

export type GatewayWorkspaceCredentialClearResult =
  | {
      status: 'cleared'
    }
  | {
      status: 'missing'
    }
  | GatewayWorkspaceCredentialReadFailure

export type GatewayWorkspaceCredentialUnreadableResetResult =
  | {
      status: 'reset'
    }
  | {
      status: 'readable'
    }
  | {
      status: 'unavailable'
      reason: GatewayWorkspaceCredentialUnavailableReason
    }

export type GatewayWorkspaceCredentialStore = {
  get(workspaceId: string): GatewayWorkspaceCredentialReadResult
  getToken(workspaceId: string): GatewayWorkspaceCredentialTokenResult
  listMetadata(): GatewayWorkspaceCredentialMetadataResult
  save(input: GatewayWorkspaceCredentialInput, now?: Date): GatewayWorkspaceCredentialRecord
  clear(workspaceId: string): GatewayWorkspaceCredentialClearResult
  resetUnreadable(): GatewayWorkspaceCredentialUnreadableResetResult
}

type GatewayWorkspaceCredentialSnapshot =
  | {
      status: 'available'
      records: GatewayWorkspaceCredentialRecord[]
    }
  | GatewayWorkspaceCredentialReadFailure

export class GatewayWorkspaceCredentialStoreError extends Error {
  readonly status: GatewayWorkspaceCredentialReadFailure['status']
  readonly reason: GatewayWorkspaceCredentialReadFailure['reason']

  constructor(failure: GatewayWorkspaceCredentialReadFailure) {
    super(
      failure.status === 'unavailable'
        ? 'Gateway credential storage is temporarily unavailable. Retry after OS credential access recovers.'
        : 'Gateway credential storage is corrupt. The stored bytes were preserved for an explicit recovery action.',
    )
    this.name = 'GatewayWorkspaceCredentialStoreError'
    this.status = failure.status
    this.reason = failure.reason
  }
}

function defaultCredentialPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'gateway-workspace-credentials.json')
}

function defaultSecretStorageMode() {
  return resolveSecretStorageMode({
    isPackaged: Boolean(getAppPathHost()?.isPackaged),
    encryptionAvailable: Boolean(getSafeStorageHost()?.isEncryptionAvailable()),
    selectedStorageBackend: readSafeStorageBackendForPolicy(
      getSafeStorageHost()?.getSelectedStorageBackend,
    ),
  })
}

function requireSafeStorage() {
  const safeStorage = getSafeStorageHost()
  if (!safeStorage) throw new Error('Electron safeStorage is unavailable')
  return safeStorage
}

function boundedToken(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Gateway token is required.')
  const trimmed = value.trim()
  if (Buffer.byteLength(trimmed, 'utf8') > 32 * 1024) throw new Error('Gateway token is too large.')
  return trimmed
}

function normalizeWorkspaceId(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Gateway workspace credential workspace id is required.')
  }
  const trimmed = value.trim()
  if (Buffer.byteLength(trimmed, 'utf8') > 512) {
    throw new Error('Gateway workspace credential workspace id is too large.')
  }
  return trimmed
}

function normalizeIso(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const trimmed = value.trim()
  const time = Date.parse(trimmed)
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO timestamp.`)
  return new Date(time).toISOString()
}

function normalizeRecord(value: unknown): GatewayWorkspaceCredentialRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<GatewayWorkspaceCredentialRecord>
  try {
    return {
      workspaceId: normalizeWorkspaceId(raw.workspaceId),
      token: boundedToken(raw.token),
      updatedAt: normalizeIso(raw.updatedAt, 'Gateway token update time'),
    }
  } catch {
    return null
  }
}

function metadata(record: GatewayWorkspaceCredentialRecord): GatewayWorkspaceCredentialMetadata {
  return {
    workspaceId: record.workspaceId,
    hasToken: true,
    updatedAt: record.updatedAt,
  }
}

export class FileGatewayWorkspaceCredentialStore implements GatewayWorkspaceCredentialStore {
  private readonly path: string
  private readonly secretStorage: SecretStorageAdapter | null

  constructor(options: { path?: string; secretStorage?: SecretStorageAdapter | null } = {}) {
    this.path = options.path || defaultCredentialPath()
    this.secretStorage = options.secretStorage === undefined ? null : options.secretStorage
  }

  get(workspaceId: string): GatewayWorkspaceCredentialReadResult {
    const id = normalizeWorkspaceId(workspaceId)
    const snapshot = this.readSnapshot()
    if (snapshot.status !== 'available') return snapshot
    const credential = snapshot.records.find((record) => record.workspaceId === id)
    return credential ? { status: 'available', credential } : { status: 'missing' }
  }

  getToken(workspaceId: string): GatewayWorkspaceCredentialTokenResult {
    const result = this.get(workspaceId)
    if (result.status !== 'available') return result
    return {
      status: 'available',
      token: result.credential.token,
      updatedAt: result.credential.updatedAt,
    }
  }

  listMetadata(): GatewayWorkspaceCredentialMetadataResult {
    const snapshot = this.readSnapshot()
    if (snapshot.status !== 'available') return snapshot
    return {
      status: 'available',
      credentials: snapshot.records.map(metadata),
    }
  }

  save(input: GatewayWorkspaceCredentialInput, now = new Date()): GatewayWorkspaceCredentialRecord {
    const record: GatewayWorkspaceCredentialRecord = {
      workspaceId: normalizeWorkspaceId(input.workspaceId),
      token: boundedToken(input.token),
      updatedAt: now.toISOString(),
    }
    const snapshot = this.readSnapshot()
    if (snapshot.status !== 'available') {
      // Refuse a replacement when the current ciphertext cannot be read. An
      // encrypt/write failure therefore leaves the previous atomic file intact.
      throw new GatewayWorkspaceCredentialStoreError(snapshot)
    }
    const next = snapshot.records.some((entry) => entry.workspaceId === record.workspaceId)
      ? snapshot.records.map((entry) => entry.workspaceId === record.workspaceId ? record : entry)
      : [...snapshot.records, record]
    this.writeRecords(next)
    return record
  }

  clear(workspaceId: string): GatewayWorkspaceCredentialClearResult {
    const id = normalizeWorkspaceId(workspaceId)
    const snapshot = this.readSnapshot()
    if (snapshot.status !== 'available') return snapshot
    const next = snapshot.records.filter((record) => record.workspaceId !== id)
    if (next.length === snapshot.records.length) return { status: 'missing' }
    this.writeRecords(next)
    return { status: 'cleared' }
  }

  resetUnreadable(): GatewayWorkspaceCredentialUnreadableResetResult {
    const snapshot = this.readSnapshot()
    if (snapshot.status === 'available') return { status: 'readable' }

    // This is the only destructive recovery path for a document that cannot
    // currently be read, including permanent key loss. The caller must gate it
    // behind explicit native confirmation; ordinary reads always preserve and
    // retry the original bytes.
    // Rename preserves the original bytes as a sibling quarantine artifact;
    // there is deliberately no delete fallback if quarantine cannot complete.
    const quarantinePath = `${this.path}.corrupt-${Date.now()}-${randomUUID()}`
    try {
      renameSync(this.path, quarantinePath)
      return { status: 'reset' }
    } catch {
      return { status: 'unavailable', reason: 'recovery-failed' }
    }
  }

  private storageMode() {
    return this.secretStorage?.mode || defaultSecretStorageMode()
  }

  private storage() {
    return this.secretStorage || requireSafeStorage()
  }

  private readSnapshot(): GatewayWorkspaceCredentialSnapshot {
    if (!existsSync(this.path)) return { status: 'available', records: [] }

    let mode: SecretStorageMode
    try {
      mode = this.storageMode()
    } catch {
      return { status: 'unavailable', reason: 'secure-storage-unavailable' }
    }
    if (mode === 'unavailable') {
      return { status: 'unavailable', reason: 'secure-storage-unavailable' }
    }

    let raw: Buffer
    try {
      raw = readFileSync(this.path)
    } catch {
      return { status: 'unavailable', reason: 'read-failed' }
    }

    let json: string
    try {
      json = mode === 'encrypted'
        ? this.storage().decryptString(raw)
        : raw.toString('utf-8')
    } catch {
      // Keychain denial and decrypt-provider failures can be transient. Never
      // move, truncate, or delete the ciphertext; the next read retries it.
      return { status: 'unavailable', reason: 'decrypt-failed' }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(json) as unknown
    } catch {
      return { status: 'corrupt', reason: 'invalid-payload' }
    }
    if (!Array.isArray(parsed)) return { status: 'corrupt', reason: 'invalid-payload' }

    const records = parsed.map(normalizeRecord)
    if (records.some((record) => !record)) {
      return { status: 'corrupt', reason: 'invalid-record' }
    }
    const normalizedRecords = records as GatewayWorkspaceCredentialRecord[]
    if (new Set(normalizedRecords.map(({ workspaceId }) => workspaceId)).size !== normalizedRecords.length) {
      return { status: 'corrupt', reason: 'invalid-record' }
    }
    return {
      status: 'available',
      records: normalizedRecords,
    }
  }

  private writeRecords(records: GatewayWorkspaceCredentialRecord[]) {
    const json = JSON.stringify(records, null, 2)
    const mode = this.storageMode()
    if (mode === 'encrypted') {
      const encrypted = this.storage().encryptString(json)
      writeFileAtomic(this.path, encrypted, { mode: 0o600 })
      return
    }
    if (mode === 'plaintext') {
      writeFileAtomic(this.path, json, { mode: 0o600 })
      return
    }
    throw new Error(
      'Secure storage unavailable on this system. '
      + 'Open Cowork cannot persist gateway workspace tokens in production without OS-backed secret storage.',
    )
  }
}

export function createFileGatewayWorkspaceCredentialStore() {
  return new FileGatewayWorkspaceCredentialStore()
}
