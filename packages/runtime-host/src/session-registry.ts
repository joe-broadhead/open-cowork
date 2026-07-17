import { quarantineCorruptFile, writeFileAtomic } from '@open-cowork/shared/node'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { SessionChangeSummary, SessionUsageSummary } from '@open-cowork/shared'
import { getAppDataDir } from './config-loader-core.js'
import { log } from '@open-cowork/shared/node'
import { getRuntimeHomeDir } from './runtime.js'
import { isSandboxWorkspaceDir } from './runtime-paths.js'
import { normalizeStoredSessionRecord, type StoredSessionRecord } from './session-registry-utils.js'

export const SESSION_REGISTRY_SCHEMA_VERSION = 1

export type SessionDirectoryTrustSource = 'session-record'

export interface SessionRecord {
  id: string
  title?: string
  directory: string | null
  opencodeDirectory: string
  createdAt: string
  updatedAt: string
  kind: 'interactive' | 'workflow_draft' | 'workflow_run'
  workflowId: string | null
  runId: string | null
  providerId: string | null
  modelId: string | null
  composerAgentName: string | null
  composerModelId: string | null
  composerReasoningVariant: string | null
  summary: SessionUsageSummary | null
  parentSessionId: string | null
  changeSummary: SessionChangeSummary | null
  revertedMessageId: string | null
  managedByCowork: true
}

export type ListSessionRecordsOptions = {
  // UI list paths need newest-first ordering. Hot paths (grant trust, id probes,
  // bulk scans that re-sort themselves) must pass sort:false so they never pay
  // the O(n log n) clone+sort over the full registry.
  sort?: boolean
}

let registryCache: Map<string, SessionRecord> | null = null
// Inverted index: resolve(directory) → session ids that claim it via
// `directory` or `opencodeDirectory`. Grant-trust and other directory probes
// use this instead of cloning/sorting the full registry (JOE-843 / JOE-896).
let directoryTrustIndex: Map<string, Set<string>> | null = null
let saveTimer: NodeJS.Timeout | null = null
let registryWriteInProgress = false
let registryWriteRequestedDuringWrite = false
const SAVE_DEBOUNCE_MS = 2000

type SessionRegistryFile = {
  schemaVersion: typeof SESSION_REGISTRY_SCHEMA_VERSION
  sessions: StoredSessionRecord[]
}

function getRegistryDir() {
  const dir = getAppDataDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

function getRegistryPath() {
  return join(getRegistryDir(), 'sessions.json')
}

function normalizeOpencodeDirectory(directory: string) {
  return resolve(directory)
}

export function toDisplayDirectory(opencodeDirectory: string) {
  const normalized = normalizeOpencodeDirectory(opencodeDirectory)
  return normalized === resolve(getRuntimeHomeDir()) || isSandboxWorkspaceDir(normalized) ? null : normalized
}

function cloneSessionRecord(record: SessionRecord): SessionRecord {
  try {
    return structuredClone(record)
  } catch {
    return {
      ...record,
      summary: record.summary
        ? {
            ...record.summary,
            tokens: { ...record.summary.tokens },
            agentBreakdown: record.summary.agentBreakdown?.map((entry) => ({
              ...entry,
              tokens: { ...entry.tokens },
            })),
          }
        : null,
      changeSummary: record.changeSummary ? { ...record.changeSummary } : null,
    }
  }
}

function directoryIndexKeysForRecord(record: SessionRecord): string[] {
  const keys: string[] = []
  if (record.directory) keys.push(resolve(record.directory))
  if (record.opencodeDirectory) {
    const opencodeKey = resolve(record.opencodeDirectory)
    if (!keys.includes(opencodeKey)) keys.push(opencodeKey)
  }
  return keys
}

function ensureDirectoryTrustIndex(map: Map<string, SessionRecord>): Map<string, Set<string>> {
  if (directoryTrustIndex) return directoryTrustIndex
  const next = new Map<string, Set<string>>()
  for (const record of map.values()) {
    for (const key of directoryIndexKeysForRecord(record)) {
      let holders = next.get(key)
      if (!holders) {
        holders = new Set()
        next.set(key, holders)
      }
      holders.add(record.id)
    }
  }
  directoryTrustIndex = next
  return next
}

function unindexSessionDirectories(record: SessionRecord) {
  if (!directoryTrustIndex) return
  for (const key of directoryIndexKeysForRecord(record)) {
    const holders = directoryTrustIndex.get(key)
    if (!holders) continue
    holders.delete(record.id)
    if (holders.size === 0) directoryTrustIndex.delete(key)
  }
}

function indexSessionDirectories(record: SessionRecord) {
  const index = ensureDirectoryTrustIndex(loadRegistryMap())
  for (const key of directoryIndexKeysForRecord(record)) {
    let holders = index.get(key)
    if (!holders) {
      holders = new Set()
      index.set(key, holders)
    }
    holders.add(record.id)
  }
}

function replaceSessionInIndexes(previous: SessionRecord | null | undefined, next: SessionRecord) {
  if (previous) unindexSessionDirectories(previous)
  indexSessionDirectories(next)
}

function loadRegistryMap() {
  if (registryCache) return registryCache

  const next = new Map<string, SessionRecord>()
  const path = getRegistryPath()
  if (!existsSync(path)) {
    registryCache = next
    directoryTrustIndex = new Map()
    return next
  }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Session registry must be an object.')
    }
    const file = raw as Partial<SessionRegistryFile>
    if (
      Object.keys(file).length !== 2
      || file.schemaVersion !== SESSION_REGISTRY_SCHEMA_VERSION
      || !Array.isArray(file.sessions)
    ) {
      throw new Error('Session registry schema is not current.')
    }

    for (const item of file.sessions) {
      const record = normalizeStoredSessionRecord(
        item,
        normalizeOpencodeDirectory,
        toDisplayDirectory,
      )
      if (!record) throw new Error('Session registry contains a non-current record.')
      next.set(record.id, record)
    }
  } catch (err: unknown) {
    quarantineCorruptFile(path)
    log('session', `Failed to load session registry: ${err instanceof Error ? err.message : String(err)}`)
  }

  registryCache = next
  directoryTrustIndex = null
  ensureDirectoryTrustIndex(next)
  return next
}

function writeRegistryMapSnapshot(map: Map<string, SessionRecord>) {
  const records = Array.from(map.values()).sort((a, b) => {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
  // Atomic write with fsync so a crash mid-write can't truncate the
  // session index on disk. writeFileAtomic handles tmp-suffix + fsync
  // + rename uniformly with the rest of the app's credential-bearing
  // writes.
  const payload: SessionRegistryFile = {
    schemaVersion: SESSION_REGISTRY_SCHEMA_VERSION,
    sessions: records,
  }
  writeFileAtomic(getRegistryPath(), JSON.stringify(payload, null, 2), { mode: 0o600 })
}

function writeRegistryMap(map: Map<string, SessionRecord>) {
  if (registryWriteInProgress) {
    registryWriteRequestedDuringWrite = true
    return
  }

  registryWriteInProgress = true
  try {
    do {
      registryWriteRequestedDuringWrite = false
      // Always serialize the current in-memory map rather than a captured
      // array so nested writes drain to the latest cache state.
      writeRegistryMapSnapshot(map)
    } while (registryWriteRequestedDuringWrite)
  } finally {
    registryWriteInProgress = false
  }
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

export function listSessionRecords(options: ListSessionRecordsOptions = {}) {
  const records = Array.from(loadRegistryMap().values()).map(cloneSessionRecord)
  if (options.sort === false) return records
  return records.sort((a, b) => {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
}

export function getSessionRecordCount() {
  return loadRegistryMap().size
}

/**
 * O(1) directory trust probe for project-directory grants.
 * `directory` must already be the realpath-normalized form used by the grant
 * registry; keys are resolve()'d the same way as stored session directories.
 */
export function lookupSessionDirectoryTrust(directory: string): SessionDirectoryTrustSource | null {
  if (!directory) return null
  const map = loadRegistryMap()
  const index = ensureDirectoryTrustIndex(map)
  const holders = index.get(resolve(directory))
  if (!holders || holders.size === 0) return null
  // Drop stale ids if a concurrent mutation left dangling index entries.
  for (const sessionId of holders) {
    if (map.has(sessionId)) return 'session-record'
    holders.delete(sessionId)
  }
  if (holders.size === 0) index.delete(resolve(directory))
  return null
}

/** Test/diagnostic helper: number of unique resolve()'d directory keys indexed. */
export function getSessionDirectoryTrustIndexSize() {
  return ensureDirectoryTrustIndex(loadRegistryMap()).size
}

export function getSessionRecord(id: string) {
  const record = loadRegistryMap().get(id)
  return record ? cloneSessionRecord(record) : null
}

export function upsertSessionRecord(record: SessionRecord) {
  const map = loadRegistryMap()
  const previous = map.get(record.id) || null
  const isNewRecord = !previous
  const next = normalizeStoredSessionRecord(record, normalizeOpencodeDirectory, toDisplayDirectory)
  if (!next) return null
  map.set(record.id, next)
  replaceSessionInIndexes(previous, next)
  if (isNewRecord) {
    writeRegistryMap(map)
  } else {
    scheduleRegistrySave()
  }
  return cloneSessionRecord(next)
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
  const normalized = normalizeStoredSessionRecord(next, normalizeOpencodeDirectory, toDisplayDirectory)
  if (!normalized) return null
  map.set(id, normalized)
  replaceSessionInIndexes(existing, normalized)
  scheduleRegistrySave()
  return cloneSessionRecord(normalized)
}

export function touchSessionRecord(id: string, updatedAt = new Date().toISOString()) {
  return updateSessionRecord(id, { updatedAt })
}

export function removeSessionRecord(id: string) {
  const map = loadRegistryMap()
  const existing = map.get(id)
  if (!existing) return
  unindexSessionDirectories(existing)
  map.delete(id)
  writeRegistryMap(map)
}

export function toSessionRecord(input: {
  id: string
  title?: string
  createdAt: string
  updatedAt: string
  opencodeDirectory: string
  providerId?: string | null
  modelId?: string | null
  composerAgentName?: string | null
  composerModelId?: string | null
  composerReasoningVariant?: string | null
  kind?: 'interactive' | 'workflow_draft' | 'workflow_run'
  workflowId?: string | null
  runId?: string | null
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
    kind: input.kind === 'workflow_draft' || input.kind === 'workflow_run'
      ? input.kind
      : 'interactive',
    workflowId: input.workflowId || null,
    runId: input.runId || null,
    providerId: input.providerId || null,
    modelId: input.modelId || null,
    composerAgentName: input.composerAgentName || null,
    composerModelId: input.composerModelId || null,
    composerReasoningVariant: input.composerReasoningVariant || null,
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
    kind: record.kind,
    workflowId: record.workflowId,
    runId: record.runId,
    parentSessionId: record.parentSessionId,
    changeSummary: record.changeSummary,
    revertedMessageId: record.revertedMessageId,
    composerAgentName: record.composerAgentName,
    composerModelId: record.composerModelId,
    composerReasoningVariant: record.composerReasoningVariant,
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

export function clearSessionRegistryCache() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  registryWriteRequestedDuringWrite = false
  registryWriteInProgress = false
  registryCache = null
  directoryTrustIndex = null
}
