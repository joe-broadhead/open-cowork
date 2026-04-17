import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import type { SessionChangeSummary, SessionUsageSummary } from '@open-cowork/shared'
import { getAppDataDir, getBrandName } from './config-loader.ts'
import { log } from './logger.ts'
import { getRuntimeHomeDir } from './runtime.ts'
import { isSandboxWorkspaceDir } from './runtime-paths.ts'
import { extractManagedSessionIdsFromLogContents, normalizeStoredSessionRecord, type StoredSessionRecord } from './session-registry-utils.ts'

export interface SessionRecord {
  id: string
  title?: string
  directory: string | null
  opencodeDirectory: string
  createdAt: string
  updatedAt: string
  providerId: string | null
  modelId: string | null
  summary: SessionUsageSummary | null
  parentSessionId: string | null
  changeSummary: SessionChangeSummary | null
  revertedMessageId: string | null
  managedByCowork: true
}

let registryCache: Map<string, SessionRecord> | null = null
let saveTimer: NodeJS.Timeout | null = null
const SAVE_DEBOUNCE_MS = 2000

function getRegistryDir() {
  const dir = getAppDataDir()
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
  return normalized === resolve(getRuntimeHomeDir()) || isSandboxWorkspaceDir(normalized) ? null : normalized
}

function getManagedSessionIdsFromLogs() {
  const logDir = getLogDir()
  if (!existsSync(logDir)) return new Set<string>()

  const files = readdirSync(logDir)
    .filter((name) => /^open-cowork-\d{4}-\d{2}-\d{2}\.log$/.test(name) || /^cowork-\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .sort()

  const contents: string[] = []

  for (const file of files) {
    try {
      contents.push(readFileSync(join(logDir, file), 'utf-8'))
    } catch (err: any) {
      log('session', `Failed to read log file ${file} during registry migration: ${err?.message}`)
    }
  }

  return extractManagedSessionIdsFromLogContents(contents)
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
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as StoredSessionRecord[]
    const needsMigration = (raw || []).some((item) => item?.managedByCowork !== true)
    const managedSessionIds = needsMigration ? getManagedSessionIdsFromLogs() : undefined
    let droppedExternal = 0
    let adoptedLegacy = 0

    for (const item of raw || []) {
      const record = normalizeStoredSessionRecord(
        item,
        normalizeOpencodeDirectory,
        toDisplayDirectory,
        managedSessionIds,
      )
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
        `Migrated session registry: kept ${next.size} ${getBrandName()} sessions (${adoptedLegacy} inferred from logs), dropped ${droppedExternal} external sessions`,
      )
      writeRegistryMap(next)
    }
  } catch (err: any) {
    log('session', `Failed to load session registry: ${err?.message}`)
  }

  registryCache = next
  return next
}

function writeRegistryMap(map: Map<string, SessionRecord>) {
  const records = Array.from(map.values()).sort((a, b) => {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
  // Atomic write: if the process crashes mid-write, the registry on disk
  // stays consistent — the tmp file is either absent or complete, and the
  // rename is atomic on the same filesystem.
  const target = getRegistryPath()
  const tmp = `${target}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(records, null, 2))
  renameSync(tmp, target)
}

function scheduleRegistrySave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (registryCache) {
      writeRegistryMap(registryCache)
    }
  }, SAVE_DEBOUNCE_MS)
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
  const next = normalizeStoredSessionRecord(record, normalizeOpencodeDirectory, toDisplayDirectory)
  if (!next) return null
  map.set(record.id, next)
  scheduleRegistrySave()
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
  scheduleRegistrySave()
  return next
}

export function touchSessionRecord(id: string, updatedAt = new Date().toISOString()) {
  return updateSessionRecord(id, { updatedAt })
}

export function removeSessionRecord(id: string) {
  const map = loadRegistryMap()
  map.delete(id)
  scheduleRegistrySave()
}

export function toSessionRecord(input: {
  id: string
  title?: string
  createdAt: string
  updatedAt: string
  opencodeDirectory: string
  providerId?: string | null
  modelId?: string | null
  summary?: SessionUsageSummary | null
  parentSessionId?: string | null
  changeSummary?: SessionChangeSummary | null
  revertedMessageId?: string | null
}) {
  const opencodeDirectory = normalizeOpencodeDirectory(input.opencodeDirectory)
  return {
    id: input.id,
    title: input.title,
    directory: toDisplayDirectory(opencodeDirectory),
    opencodeDirectory,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    providerId: input.providerId || null,
    modelId: input.modelId || null,
    summary: input.summary || null,
    parentSessionId: input.parentSessionId || null,
    changeSummary: input.changeSummary || null,
    revertedMessageId: input.revertedMessageId || null,
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
    parentSessionId: record.parentSessionId,
    changeSummary: record.changeSummary,
    revertedMessageId: record.revertedMessageId,
  }
}

export function flushSessionRegistryWrites() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (registryCache) {
    writeRegistryMap(registryCache)
  }
}
