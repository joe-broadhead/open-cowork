import { readSafeStorageBackendForPolicy, resolveSecretStorageMode, type SecretStorageMode } from '@open-cowork/runtime-host/secure-storage-policy'
import { getAppPathHost, getSafeStorageHost, quarantineCorruptFile, writeFileAtomic } from '@open-cowork/shared/node'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { getAppDataDir } from '@open-cowork/runtime-host/config'
type SecretStorageAdapter = {
  mode: SecretStorageMode
  encryptString: (plaintext: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export type CloudWorkspaceCredentialRecord = {
  workspaceId: string
  accessToken: string
  refreshToken: string | null
  expiresAt: string
  tokenType: 'Bearer'
  updatedAt: string
}

export type CloudWorkspaceCredentialInput = {
  workspaceId: string
  accessToken: string
  refreshToken?: string | null
  expiresAt: string
}

export type CloudWorkspaceCredentialMetadata = {
  workspaceId: string
  hasAccessToken: boolean
  hasRefreshToken: boolean
  expiresAt: string
  updatedAt: string
}

export type CloudWorkspaceCredentialStore = {
  get(workspaceId: string): CloudWorkspaceCredentialRecord | null
  getUsableAccessToken(workspaceId: string, now?: Date): string | null
  listMetadata(): CloudWorkspaceCredentialMetadata[]
  save(input: CloudWorkspaceCredentialInput, now?: Date): CloudWorkspaceCredentialRecord
  remove(workspaceId: string): boolean
}

function defaultCredentialPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'cloud-workspace-credentials.json')
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

function boundedToken(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const trimmed = value.trim()
  if (Buffer.byteLength(trimmed, 'utf8') > 32 * 1024) throw new Error(`${label} is too large.`)
  return trimmed
}

function boundedOptionalToken(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return null
  return boundedToken(value, label)
}

function normalizeWorkspaceId(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Cloud workspace credential workspace id is required.')
  const trimmed = value.trim()
  if (Buffer.byteLength(trimmed, 'utf8') > 512) throw new Error('Cloud workspace credential workspace id is too large.')
  return trimmed
}

function normalizeIso(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const trimmed = value.trim()
  const time = Date.parse(trimmed)
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO timestamp.`)
  return new Date(time).toISOString()
}

function normalizeRecord(value: unknown): CloudWorkspaceCredentialRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<CloudWorkspaceCredentialRecord>
  try {
    return {
      workspaceId: normalizeWorkspaceId(raw.workspaceId),
      accessToken: boundedToken(raw.accessToken, 'Cloud access token'),
      refreshToken: boundedOptionalToken(raw.refreshToken, 'Cloud refresh token'),
      expiresAt: normalizeIso(raw.expiresAt, 'Cloud token expiry'),
      tokenType: 'Bearer',
      updatedAt: normalizeIso(raw.updatedAt, 'Cloud token update time'),
    }
  } catch {
    return null
  }
}

function metadata(record: CloudWorkspaceCredentialRecord): CloudWorkspaceCredentialMetadata {
  return {
    workspaceId: record.workspaceId,
    hasAccessToken: Boolean(record.accessToken),
    hasRefreshToken: Boolean(record.refreshToken),
    expiresAt: record.expiresAt,
    updatedAt: record.updatedAt,
  }
}

export class FileCloudWorkspaceCredentialStore implements CloudWorkspaceCredentialStore {
  private readonly path: string
  private readonly secretStorage: SecretStorageAdapter | null

  constructor(options: { path?: string; secretStorage?: SecretStorageAdapter | null } = {}) {
    this.path = options.path || defaultCredentialPath()
    this.secretStorage = options.secretStorage === undefined ? null : options.secretStorage
  }

  get(workspaceId: string): CloudWorkspaceCredentialRecord | null {
    const id = normalizeWorkspaceId(workspaceId)
    return this.readRecords().find((record) => record.workspaceId === id) || null
  }

  getUsableAccessToken(workspaceId: string, now = new Date()): string | null {
    const record = this.get(workspaceId)
    if (!record) return null
    if (Date.parse(record.expiresAt) <= now.getTime() + 30_000) return null
    return record.accessToken
  }

  listMetadata(): CloudWorkspaceCredentialMetadata[] {
    return this.readRecords().map(metadata)
  }

  save(input: CloudWorkspaceCredentialInput, now = new Date()): CloudWorkspaceCredentialRecord {
    const record: CloudWorkspaceCredentialRecord = {
      workspaceId: normalizeWorkspaceId(input.workspaceId),
      accessToken: boundedToken(input.accessToken, 'Cloud access token'),
      refreshToken: boundedOptionalToken(input.refreshToken, 'Cloud refresh token'),
      expiresAt: normalizeIso(input.expiresAt, 'Cloud token expiry'),
      tokenType: 'Bearer',
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

  private readRecords(): CloudWorkspaceCredentialRecord[] {
    if (!existsSync(this.path)) return []
    const mode = this.storageMode()
    if (mode === 'unavailable') return []
    let raw: Buffer
    try {
      raw = readFileSync(this.path)
    } catch {
      return []
    }
    let json: string
    try {
      json = mode === 'encrypted' ? this.storage().decryptString(raw) : raw.toString('utf-8')
    } catch {
      // Transient decrypt failure (keychain locked / safeStorage unavailable): the ciphertext is
      // intact (audit P2-12) — do NOT delete, or the user is forced to re-login. Retry on next read.
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(json) as unknown
    } catch {
      // Decrypted but not valid JSON → genuinely corrupt. Quarantine for diagnosis, never destroy.
      if (mode === 'encrypted') quarantineCorruptFile(this.path)
      return []
    }
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizeRecord)
      .filter((record): record is CloudWorkspaceCredentialRecord => Boolean(record))
  }

  private writeRecords(records: CloudWorkspaceCredentialRecord[]) {
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
    throw new Error('Secure storage unavailable on this system. Open Cowork cannot persist cloud workspace tokens in production without OS-backed secret storage.')
  }
}

export function createFileCloudWorkspaceCredentialStore() {
  return new FileCloudWorkspaceCredentialStore()
}
