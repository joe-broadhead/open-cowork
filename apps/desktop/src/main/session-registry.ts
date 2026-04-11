import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { log } from './logger'
import { getRuntimeHomeDir } from './runtime'

export interface SessionRecord {
  id: string
  title?: string
  directory: string | null
  opencodeDirectory: string
  createdAt: string
  updatedAt: string
}

let registryCache: Map<string, SessionRecord> | null = null

function getRegistryPath() {
  const dir = join(app.getPath('userData'), 'cowork')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'sessions.json')
}

function normalizeOpencodeDirectory(directory: string) {
  return resolve(directory)
}

function toDisplayDirectory(opencodeDirectory: string) {
  const normalized = normalizeOpencodeDirectory(opencodeDirectory)
  return normalized === resolve(getRuntimeHomeDir()) ? null : normalized
}

function loadRegistryMap() {
  if (registryCache) return registryCache

  const next = new Map<string, SessionRecord>()
  const path = getRegistryPath()
  if (!existsSync(path)) {
    registryCache = next
    return next
  }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as SessionRecord[]
    for (const item of raw || []) {
      if (!item?.id || !item?.opencodeDirectory || !item?.createdAt || !item?.updatedAt) continue
      next.set(item.id, {
        ...item,
        directory: item.directory ?? toDisplayDirectory(item.opencodeDirectory),
        opencodeDirectory: normalizeOpencodeDirectory(item.opencodeDirectory),
      })
    }
  } catch (err: any) {
    log('session', `Failed to load session registry: ${err?.message}`)
  }

  registryCache = next
  return next
}

function saveRegistryMap(map: Map<string, SessionRecord>) {
  const records = Array.from(map.values()).sort((a, b) => {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
  writeFileSync(getRegistryPath(), JSON.stringify(records, null, 2))
}

export function listSessionRecords() {
  return Array.from(loadRegistryMap().values()).sort((a, b) => {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
}

export function getSessionRecord(id: string) {
  return loadRegistryMap().get(id) || null
}

export function upsertSessionRecord(record: SessionRecord) {
  const map = loadRegistryMap()
  map.set(record.id, {
    ...record,
    directory: record.directory ?? toDisplayDirectory(record.opencodeDirectory),
    opencodeDirectory: normalizeOpencodeDirectory(record.opencodeDirectory),
  })
  saveRegistryMap(map)
  return map.get(record.id) || null
}

export function mergeSessionRecords(records: SessionRecord[]) {
  const map = loadRegistryMap()
  for (const record of records) {
    map.set(record.id, {
      ...record,
      directory: record.directory ?? toDisplayDirectory(record.opencodeDirectory),
      opencodeDirectory: normalizeOpencodeDirectory(record.opencodeDirectory),
    })
  }
  saveRegistryMap(map)
}

export function updateSessionRecord(id: string, patch: Partial<Omit<SessionRecord, 'id'>>) {
  const map = loadRegistryMap()
  const existing = map.get(id)
  if (!existing) return null
  const next: SessionRecord = {
    ...existing,
    ...patch,
    opencodeDirectory: normalizeOpencodeDirectory(patch.opencodeDirectory || existing.opencodeDirectory),
  }
  if (!('directory' in patch) || patch.directory === undefined) {
    next.directory = toDisplayDirectory(next.opencodeDirectory)
  }
  map.set(id, next)
  saveRegistryMap(map)
  return next
}

export function touchSessionRecord(id: string, updatedAt = new Date().toISOString()) {
  return updateSessionRecord(id, { updatedAt })
}

export function removeSessionRecord(id: string) {
  const map = loadRegistryMap()
  map.delete(id)
  saveRegistryMap(map)
}

export function toSessionRecord(input: {
  id: string
  title?: string
  createdAt: string
  updatedAt: string
  opencodeDirectory: string
}) {
  const opencodeDirectory = normalizeOpencodeDirectory(input.opencodeDirectory)
  return {
    id: input.id,
    title: input.title,
    directory: toDisplayDirectory(opencodeDirectory),
    opencodeDirectory,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  } satisfies SessionRecord
}

export function toRendererSession(record: SessionRecord) {
  return {
    id: record.id,
    title: record.title || 'New session',
    directory: record.directory,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}
