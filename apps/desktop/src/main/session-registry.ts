import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
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
  managedByCowork: true
}

let registryCache: Map<string, SessionRecord> | null = null

function getRegistryDir() {
  const dir = join(app.getPath('userData'), 'cowork')
  mkdirSync(dir, { recursive: true })
  return dir
}

function getRegistryPath() {
  return join(getRegistryDir(), 'sessions.json')
}

function getLogDir() {
  return join(getRegistryDir(), 'logs')
}

function normalizeOpencodeDirectory(directory: string) {
  return resolve(directory)
}

function toDisplayDirectory(opencodeDirectory: string) {
  const normalized = normalizeOpencodeDirectory(opencodeDirectory)
  return normalized === resolve(getRuntimeHomeDir()) ? null : normalized
}

function getManagedSessionIdsFromLogs() {
  const managed = new Set<string>()
  const logDir = getLogDir()
  if (!existsSync(logDir)) return managed

  const files = readdirSync(logDir)
    .filter((name) => /^cowork-\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .sort()

  const patterns = [
    /\bCreated session (ses_[A-Za-z0-9]+)\b/g,
    /\bForked [^\n]* -> (ses_[A-Za-z0-9]+)\b/g,
  ]

  for (const file of files) {
    try {
      const content = readFileSync(join(logDir, file), 'utf-8')
      for (const pattern of patterns) {
        pattern.lastIndex = 0
        for (const match of content.matchAll(pattern)) {
          if (match[1]) managed.add(match[1])
        }
      }
    } catch (err: any) {
      log('session', `Failed to read log file ${file} during registry migration: ${err?.message}`)
    }
  }

  return managed
}

function normalizeRecord(
  item: Partial<SessionRecord>,
  managedSessionIds?: Set<string>,
): SessionRecord | null {
  if (!item?.id || !item?.opencodeDirectory || !item?.createdAt || !item?.updatedAt) {
    return null
  }

  const opencodeDirectory = normalizeOpencodeDirectory(item.opencodeDirectory)
  const managedByCowork = item.managedByCowork ?? (managedSessionIds?.has(item.id) ? true : undefined)
  if (managedByCowork !== true) return null

  return {
    id: item.id,
    title: item.title,
    directory: item.directory ?? toDisplayDirectory(opencodeDirectory),
    opencodeDirectory,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    managedByCowork: true,
  }
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
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SessionRecord>[]
    const needsMigration = (raw || []).some((item) => item?.managedByCowork !== true)
    const managedSessionIds = needsMigration ? getManagedSessionIdsFromLogs() : undefined
    let droppedExternal = 0
    let adoptedLegacy = 0

    for (const item of raw || []) {
      const record = normalizeRecord(item, managedSessionIds)
      if (!record) {
        if (item?.id) droppedExternal += 1
        continue
      }
      if (item.managedByCowork !== true) adoptedLegacy += 1
      next.set(record.id, record)
    }

    if (needsMigration) {
      log(
        'session',
        `Migrated session registry: kept ${next.size} Cowork sessions (${adoptedLegacy} inferred from logs), dropped ${droppedExternal} external sessions`,
      )
      saveRegistryMap(next)
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
  const next = normalizeRecord(record)
  if (!next) return null
  map.set(record.id, next)
  saveRegistryMap(map)
  return map.get(record.id) || null
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
    managedByCowork: true,
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
