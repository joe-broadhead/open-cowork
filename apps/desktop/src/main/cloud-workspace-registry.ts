import { quarantineCorruptFile, writeFileAtomic } from '@open-cowork/shared/node'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getAppDataDir } from '@open-cowork/runtime-host/config'
export type CloudWorkspaceConnectionRecord = {
  id: string
  baseUrl: string
  label: string
  tenantId?: string
  userId?: string
  profileName?: string
  lastSyncedAt: string | null
  createdAt: string
  updatedAt: string
}

export type CloudWorkspaceConnectionInput = {
  baseUrl: string
  label?: string
  tenantId?: string | null
  userId?: string | null
  profileName?: string | null
  lastSyncedAt?: string | null
}

export type CloudWorkspaceRegistry = {
  list(): CloudWorkspaceConnectionRecord[]
  upsert(input: CloudWorkspaceConnectionInput, now?: Date): CloudWorkspaceConnectionRecord
  remove(workspaceId: string): boolean
  touchSync(workspaceId: string, syncedAt: string, now?: Date): CloudWorkspaceConnectionRecord | null
}

type StoredCloudWorkspaceConnection = Partial<CloudWorkspaceConnectionRecord> & {
  token?: unknown
  accessToken?: unknown
  refreshToken?: unknown
  apiKey?: unknown
  secret?: unknown
}

function defaultRegistryPath() {
  return join(getAppDataDir(), 'cloud-workspaces.json')
}

function isLoopbackHost(hostname: string) {
  const host = hostname.trim().toLowerCase()
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

export function normalizeCloudWorkspaceBaseUrl(input: string) {
  const parsed = new URL(input)
  if (parsed.protocol !== 'https:') {
    if (parsed.protocol !== 'http:' || !isLoopbackHost(parsed.hostname)) {
      throw new Error('Cloud workspace URL must use https, except for localhost development.')
    }
  }
  parsed.hash = ''
  parsed.search = ''
  return parsed.toString().replace(/\/+$/, '')
}

export function cloudWorkspaceIdForBaseUrl(baseUrl: string) {
  return `cloud:${createHash('sha256').update(normalizeCloudWorkspaceBaseUrl(baseUrl)).digest('hex').slice(0, 16)}`
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function nullableIsoText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeRecord(value: unknown): CloudWorkspaceConnectionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as StoredCloudWorkspaceConnection
  if (typeof raw.baseUrl !== 'string' || !raw.baseUrl.trim()) return null
  let baseUrl: string
  try {
    baseUrl = normalizeCloudWorkspaceBaseUrl(raw.baseUrl)
  } catch {
    return null
  }
  const id = typeof raw.id === 'string' && raw.id.startsWith('cloud:')
    ? raw.id
    : cloudWorkspaceIdForBaseUrl(baseUrl)
  const createdAt = typeof raw.createdAt === 'string' && raw.createdAt
    ? raw.createdAt
    : new Date(0).toISOString()
  const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt
    ? raw.updatedAt
    : createdAt
  return {
    id,
    baseUrl,
    label: optionalText(raw.label) || new URL(baseUrl).host,
    tenantId: optionalText(raw.tenantId),
    userId: optionalText(raw.userId),
    profileName: optionalText(raw.profileName),
    lastSyncedAt: nullableIsoText(raw.lastSyncedAt),
    createdAt,
    updatedAt,
  }
}

function sortRecords(records: CloudWorkspaceConnectionRecord[]) {
  return records.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

export class FileCloudWorkspaceRegistry implements CloudWorkspaceRegistry {
  private readonly path: string

  constructor(path = defaultRegistryPath()) {
    this.path = path
  }

  list(): CloudWorkspaceConnectionRecord[] {
    return sortRecords(this.readRecords())
  }

  upsert(input: CloudWorkspaceConnectionInput, now = new Date()): CloudWorkspaceConnectionRecord {
    const baseUrl = normalizeCloudWorkspaceBaseUrl(input.baseUrl)
    const id = cloudWorkspaceIdForBaseUrl(baseUrl)
    const records = this.readRecords()
    const existing = records.find((record) => record.id === id) || null
    const timestamp = now.toISOString()
    const next: CloudWorkspaceConnectionRecord = {
      id,
      baseUrl,
      label: input.label?.trim() || existing?.label || new URL(baseUrl).host,
      tenantId: optionalText(input.tenantId) || existing?.tenantId,
      userId: optionalText(input.userId) || existing?.userId,
      profileName: optionalText(input.profileName) || existing?.profileName,
      lastSyncedAt: input.lastSyncedAt === undefined ? existing?.lastSyncedAt || null : nullableIsoText(input.lastSyncedAt),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    }
    const merged = existing
      ? records.map((record) => record.id === id ? next : record)
      : [...records, next]
    this.writeRecords(merged)
    return next
  }

  remove(workspaceId: string): boolean {
    const records = this.readRecords()
    const next = records.filter((record) => record.id !== workspaceId)
    if (next.length === records.length) return false
    this.writeRecords(next)
    return true
  }

  touchSync(workspaceId: string, syncedAt: string, now = new Date()): CloudWorkspaceConnectionRecord | null {
    const records = this.readRecords()
    let updated: CloudWorkspaceConnectionRecord | null = null
    const next = records.map((record) => {
      if (record.id !== workspaceId) return record
      updated = {
        ...record,
        lastSyncedAt: syncedAt,
        updatedAt: now.toISOString(),
      }
      return updated
    })
    if (!updated) return null
    this.writeRecords(next)
    return updated
  }

  private readRecords(): CloudWorkspaceConnectionRecord[] {
    if (!existsSync(this.path)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed
        .map(normalizeRecord)
        .filter((record): record is CloudWorkspaceConnectionRecord => Boolean(record))
    } catch {
      // A corrupt/half-written file is NOT "no workspaces" (audit P2-13): quarantine it so the good
      // data is preserved for recovery and the next writeRecords can't clobber it.
      quarantineCorruptFile(this.path)
      return []
    }
  }

  private writeRecords(records: CloudWorkspaceConnectionRecord[]) {
    const safeRecords = sortRecords(records)
      .map((record) => normalizeRecord(record))
      .filter((record): record is CloudWorkspaceConnectionRecord => Boolean(record))
    writeFileAtomic(this.path, JSON.stringify(safeRecords, null, 2), { mode: 0o600 })
  }
}

export function createFileCloudWorkspaceRegistry(path?: string) {
  return new FileCloudWorkspaceRegistry(path)
}
