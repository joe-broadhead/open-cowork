import { readSafeStorageBackendForPolicy, resolveSecretStorageMode, type SecretStorageMode } from '@open-cowork/runtime-host/secure-storage-policy'
import { writeFileAtomic } from '@open-cowork/shared/node'
import electron from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DesktopPairingCredentialMetadata } from '@open-cowork/shared'
import { getAppDataDir } from '../config-loader.ts'
const electronSafeStorage = (electron as { safeStorage?: typeof import('electron').safeStorage }).safeStorage
const electronSafeStorageBackend = electronSafeStorage as (typeof import('electron').safeStorage & {
  getSelectedStorageBackend?: () => string
}) | undefined

type SecretStorageAdapter = {
  mode: SecretStorageMode
  encryptString: (plaintext: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export type DesktopPairingCredentialRecord = {
  pairingId: string
  deviceId: string
  token: string
  updatedAt: string
}

export type DesktopPairingCredentialInput = {
  pairingId: string
  deviceId: string
  token: string
}

export type DesktopPairingCredentialStore = {
  get(pairingId: string): DesktopPairingCredentialRecord | null
  listMetadata(): DesktopPairingCredentialMetadata[]
  save(input: DesktopPairingCredentialInput, now?: Date): DesktopPairingCredentialRecord
  remove(pairingId: string): boolean
}

function defaultCredentialPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'desktop-pairing-credentials.json')
}

function defaultSecretStorageMode() {
  return resolveSecretStorageMode({
    isPackaged: Boolean(electron.app?.isPackaged),
    encryptionAvailable: Boolean(electronSafeStorage?.isEncryptionAvailable?.()),
    selectedStorageBackend: readSafeStorageBackendForPolicy(
      electronSafeStorageBackend?.getSelectedStorageBackend?.bind(electronSafeStorageBackend),
    ),
  })
}

function requireSafeStorage() {
  if (!electronSafeStorage) throw new Error('Electron safeStorage is unavailable')
  return electronSafeStorage
}

function boundedToken(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const trimmed = value.trim()
  if (Buffer.byteLength(trimmed, 'utf8') > 32 * 1024) throw new Error(`${label} is too large.`)
  return trimmed
}

function normalizeId(value: unknown, label: string) {
  const id = boundedToken(value, label)
  if (Buffer.byteLength(id, 'utf8') > 512) throw new Error(`${label} is too large.`)
  return id
}

function normalizeIso(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const time = Date.parse(value)
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO timestamp.`)
  return new Date(time).toISOString()
}

function normalizeRecord(value: unknown): DesktopPairingCredentialRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Partial<DesktopPairingCredentialRecord>
  try {
    return {
      pairingId: normalizeId(raw.pairingId, 'Desktop pairing credential id'),
      deviceId: normalizeId(raw.deviceId, 'Desktop pairing device id'),
      token: boundedToken(raw.token, 'Desktop pairing token'),
      updatedAt: normalizeIso(raw.updatedAt, 'Desktop pairing credential update time'),
    }
  } catch {
    return null
  }
}

function metadata(record: DesktopPairingCredentialRecord): DesktopPairingCredentialMetadata {
  return {
    pairingId: record.pairingId,
    deviceId: record.deviceId,
    hasToken: Boolean(record.token),
    updatedAt: record.updatedAt,
  }
}

export class FileDesktopPairingCredentialStore implements DesktopPairingCredentialStore {
  private readonly path: string
  private readonly secretStorage: SecretStorageAdapter | null
  // Cache of the decrypted+normalized records, keyed on the file's mtime.
  // get() runs per online pairing on every runtime event (observeRuntimeEvent),
  // and each miss cost a disk read plus an Electron safeStorage decryptString
  // round-trip. This store is the sole writer, so we refresh on write and fall
  // back to mtime to catch any out-of-band edit.
  private cache: { mtimeMs: number; records: DesktopPairingCredentialRecord[] } | null = null

  constructor(options: { path?: string; secretStorage?: SecretStorageAdapter | null } = {}) {
    this.path = options.path || defaultCredentialPath()
    this.secretStorage = options.secretStorage === undefined ? null : options.secretStorage
  }

  get(pairingId: string): DesktopPairingCredentialRecord | null {
    const id = normalizeId(pairingId, 'Desktop pairing credential id')
    return this.readRecords().find((record) => record.pairingId === id) || null
  }

  listMetadata(): DesktopPairingCredentialMetadata[] {
    return this.readRecords().map(metadata)
  }

  save(input: DesktopPairingCredentialInput, now = new Date()): DesktopPairingCredentialRecord {
    const record: DesktopPairingCredentialRecord = {
      pairingId: normalizeId(input.pairingId, 'Desktop pairing credential id'),
      deviceId: normalizeId(input.deviceId, 'Desktop pairing device id'),
      token: boundedToken(input.token, 'Desktop pairing token'),
      updatedAt: now.toISOString(),
    }
    const records = this.readRecords()
    const next = records.some((entry) => entry.pairingId === record.pairingId)
      ? records.map((entry) => entry.pairingId === record.pairingId ? record : entry)
      : [...records, record]
    this.writeRecords(next)
    return record
  }

  remove(pairingId: string): boolean {
    const id = normalizeId(pairingId, 'Desktop pairing credential id')
    const records = this.readRecords()
    const next = records.filter((record) => record.pairingId !== id)
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

  private readRecords(): DesktopPairingCredentialRecord[] {
    if (!existsSync(this.path)) {
      this.cache = null
      return []
    }
    const mode = this.storageMode()
    if (mode === 'unavailable') return []
    const mtimeMs = this.currentMtimeMs()
    if (this.cache && mtimeMs !== null && this.cache.mtimeMs === mtimeMs) return this.cache.records
    try {
      const raw = readFileSync(this.path)
      const json = mode === 'encrypted'
        ? this.storage().decryptString(raw)
        : raw.toString('utf-8')
      const parsed = JSON.parse(json) as unknown
      if (!Array.isArray(parsed)) return []
      const records = parsed.map(normalizeRecord).filter((record): record is DesktopPairingCredentialRecord => Boolean(record))
      if (mtimeMs !== null) this.cache = { mtimeMs, records }
      return records
    } catch {
      this.cache = null
      if (mode === 'encrypted') {
        try { rmSync(this.path, { force: true }) } catch { /* corrupted credential cleanup is best effort */ }
      }
      return []
    }
  }

  private writeRecords(records: DesktopPairingCredentialRecord[]) {
    const json = JSON.stringify(records, null, 2)
    const mode = this.storageMode()
    if (mode === 'encrypted') {
      writeFileAtomic(this.path, this.storage().encryptString(json), { mode: 0o600 })
    } else if (mode === 'plaintext') {
      writeFileAtomic(this.path, json, { mode: 0o600 })
    } else {
      throw new Error('Secure storage unavailable on this system. Open Cowork cannot persist desktop pairing tokens without OS-backed secret storage.')
    }
    const mtimeMs = this.currentMtimeMs()
    this.cache = mtimeMs !== null ? { mtimeMs, records } : null
  }

  private currentMtimeMs(): number | null {
    try {
      return statSync(this.path).mtimeMs
    } catch {
      return null
    }
  }
}

export function createFileDesktopPairingCredentialStore() {
  return new FileDesktopPairingCredentialStore()
}
