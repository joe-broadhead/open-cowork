import { quarantineCorruptFile, writeFileAtomic } from '@open-cowork/shared/node'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { getAppDataDir } from './config-loader.ts'
export type GatewayWorkspaceConnectionRecord = {
  id: string
  baseUrl: string
  label: string
  lastSyncedAt: string | null
  createdAt: string
  updatedAt: string
}

export type GatewayWorkspaceConnectionInput = {
  baseUrl: string
  label?: string
  lastSyncedAt?: string | null
}

export type GatewayWorkspaceRegistry = {
  list(): GatewayWorkspaceConnectionRecord[]
  upsert(input: GatewayWorkspaceConnectionInput, now?: Date): GatewayWorkspaceConnectionRecord
  remove(workspaceId: string): boolean
  touchSync(workspaceId: string, syncedAt: string, now?: Date): GatewayWorkspaceConnectionRecord | null
}

type StoredGatewayWorkspaceConnection = Partial<GatewayWorkspaceConnectionRecord> & {
  token?: unknown
  accessToken?: unknown
  apiKey?: unknown
  secret?: unknown
}

function defaultRegistryPath() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'gateway-workspaces.json')
}

function isLoopbackHost(hostname: string) {
  const host = hostname.trim().toLowerCase()
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

export function normalizeGatewayWorkspaceBaseUrl(input: string) {
  const parsed = new URL(input)
  if (parsed.protocol !== 'https:') {
    if (parsed.protocol !== 'http:' || !isLoopbackHost(parsed.hostname)) {
      throw new Error('Gateway workspace URL must use https, except for localhost development.')
    }
  }
  parsed.hash = ''
  parsed.search = ''
  return parsed.toString().replace(/\/+$/, '')
}

export function gatewayWorkspaceIdForBaseUrl(baseUrl: string) {
  return `gateway:${createHash('sha256').update(normalizeGatewayWorkspaceBaseUrl(baseUrl)).digest('hex').slice(0, 16)}`
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function nullableIsoText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeRecord(value: unknown): GatewayWorkspaceConnectionRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as StoredGatewayWorkspaceConnection
  if (typeof raw.baseUrl !== 'string' || !raw.baseUrl.trim()) return null
  let baseUrl: string
  try {
    baseUrl = normalizeGatewayWorkspaceBaseUrl(raw.baseUrl)
  } catch {
    return null
  }
  const id = typeof raw.id === 'string' && raw.id.startsWith('gateway:')
    ? raw.id
    : gatewayWorkspaceIdForBaseUrl(baseUrl)
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
    lastSyncedAt: nullableIsoText(raw.lastSyncedAt),
    createdAt,
    updatedAt,
  }
}

function sortRecords(records: GatewayWorkspaceConnectionRecord[]) {
  return records.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

export class FileGatewayWorkspaceRegistry implements GatewayWorkspaceRegistry {
  private readonly path: string

  constructor(path = defaultRegistryPath()) {
    this.path = path
  }

  list(): GatewayWorkspaceConnectionRecord[] {
    return sortRecords(this.readRecords())
  }

  upsert(input: GatewayWorkspaceConnectionInput, now = new Date()): GatewayWorkspaceConnectionRecord {
    const baseUrl = normalizeGatewayWorkspaceBaseUrl(input.baseUrl)
    const id = gatewayWorkspaceIdForBaseUrl(baseUrl)
    const records = this.readRecords()
    const existing = records.find((record) => record.id === id) || null
    const timestamp = now.toISOString()
    const next: GatewayWorkspaceConnectionRecord = {
      id,
      baseUrl,
      label: input.label?.trim() || existing?.label || new URL(baseUrl).host,
      lastSyncedAt: input.lastSyncedAt === undefined ? existing?.lastSyncedAt || null : nullableIsoText(input.lastSyncedAt),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
    }
    this.writeRecords(existing
      ? records.map((record) => record.id === id ? next : record)
      : [...records, next])
    return next
  }

  remove(workspaceId: string): boolean {
    const records = this.readRecords()
    const next = records.filter((record) => record.id !== workspaceId)
    if (next.length === records.length) return false
    this.writeRecords(next)
    return true
  }

  touchSync(workspaceId: string, syncedAt: string, now = new Date()): GatewayWorkspaceConnectionRecord | null {
    const records = this.readRecords()
    let updated: GatewayWorkspaceConnectionRecord | null = null
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

  private readRecords(): GatewayWorkspaceConnectionRecord[] {
    if (!existsSync(this.path)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as unknown
      if (!Array.isArray(parsed)) return []
      return parsed
        .map(normalizeRecord)
        .filter((record): record is GatewayWorkspaceConnectionRecord => Boolean(record))
    } catch {
      // A corrupt/half-written file is NOT "no workspaces" (audit P2-13): quarantine it so the good
      // data is preserved for recovery and the next writeRecords can't clobber it.
      quarantineCorruptFile(this.path)
      return []
    }
  }

  private writeRecords(records: GatewayWorkspaceConnectionRecord[]) {
    const safeRecords = sortRecords(records)
      .map((record) => normalizeRecord(record))
      .filter((record): record is GatewayWorkspaceConnectionRecord => Boolean(record))
    writeFileAtomic(this.path, JSON.stringify(safeRecords, null, 2), { mode: 0o600 })
  }
}

export function createFileGatewayWorkspaceRegistry(path?: string) {
  return new FileGatewayWorkspaceRegistry(path)
}
