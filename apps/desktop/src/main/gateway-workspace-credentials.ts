import { readSafeStorageBackendForPolicy, resolveSecretStorageMode, type SecretStorageMode } from '@open-cowork/runtime-host/secure-storage-policy'
import { getAppPathHost, getSafeStorageHost, writeFileAtomic } from '@open-cowork/shared/node'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { getAppDataDir } from './config-loader.ts'
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

export type GatewayWorkspaceCredentialStore = {
  get(workspaceId: string): GatewayWorkspaceCredentialRecord | null
  getToken(workspaceId: string): string | null
  listMetadata(): GatewayWorkspaceCredentialMetadata[]
  save(input: GatewayWorkspaceCredentialInput, now?: Date): GatewayWorkspaceCredentialRecord
  remove(workspaceId: string): boolean
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
  if (typeof value !== 'string' || !value.trim()) throw new Error('Gateway workspace credential workspace id is required.')
  const trimmed = value.trim()
  if (Buffer.byteLength(trimmed, 'utf8') > 512) throw new Error('Gateway workspace credential workspace id is too large.')
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
    hasToken: Boolean(record.token),
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

  get(workspaceId: string): GatewayWorkspaceCredentialRecord | null {
    const id = normalizeWorkspaceId(workspaceId)
    return this.readRecords().find((record) => record.workspaceId === id) || null
  }

  getToken(workspaceId: string): string | null {
    return this.get(workspaceId)?.token || null
  }

  listMetadata(): GatewayWorkspaceCredentialMetadata[] {
    return this.readRecords().map(metadata)
  }

  save(input: GatewayWorkspaceCredentialInput, now = new Date()): GatewayWorkspaceCredentialRecord {
    const record: GatewayWorkspaceCredentialRecord = {
      workspaceId: normalizeWorkspaceId(input.workspaceId),
      token: boundedToken(input.token),
      updatedAt: now.toISOString(),
    }
    const records = this.readRecords()
    const next = records.some((entry) => entry.workspaceId === record.workspaceId)
      ? records.map((entry) => entry.workspaceId === record.workspaceId ? record : entry)
      : [...records, record]
    this.writeRecords(next)
    return record
  }

  remove(workspaceId: string): boolean {
    const id = normalizeWorkspaceId(workspaceId)
    const records = this.readRecords()
    const next = records.filter((record) => record.workspaceId !== id)
    if (next.length === records.length) return false
    this.writeRecords(next)
    return true
  }

  private storageMode() {
    return this.secretStorage?.mode || defaultSecretStorageMode()
  }

  private storage() {
    return this.secretStorage || requireSafeStorage()
  }

  private readRecords(): GatewayWorkspaceCredentialRecord[] {
    if (!existsSync(this.path)) return []
    const mode = this.storageMode()
    if (mode === 'unavailable') return []
    try {
      const raw = readFileSync(this.path)
      const json = mode === 'encrypted'
        ? this.storage().decryptString(raw)
        : raw.toString('utf-8')
      const parsed = JSON.parse(json) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed
        .map(normalizeRecord)
        .filter((record): record is GatewayWorkspaceCredentialRecord => Boolean(record))
    } catch {
      if (mode === 'encrypted') {
        try { rmSync(this.path, { force: true }) } catch { /* ignore corrupted credential cleanup */ }
      }
      return []
    }
  }

  private writeRecords(records: GatewayWorkspaceCredentialRecord[]) {
    const json = JSON.stringify(records, null, 2)
    const mode = this.storageMode()
    if (mode === 'encrypted') {
      writeFileAtomic(this.path, this.storage().encryptString(json), { mode: 0o600 })
      return
    }
    if (mode === 'plaintext') {
      writeFileAtomic(this.path, json, { mode: 0o600 })
      return
    }
    throw new Error('Secure storage unavailable on this system. Open Cowork cannot persist gateway workspace tokens in production without OS-backed secret storage.')
  }
}

export function createFileGatewayWorkspaceCredentialStore() {
  return new FileGatewayWorkspaceCredentialStore()
}
