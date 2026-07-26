import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { readdir, lstat, mkdir, open, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PortableRuntimeEntryKind } from './runtime-snapshot-portability.ts'
import type { ObjectStoreAdapter } from './object-store.ts'
import { assertSafeObjectKey } from './object-store.ts'
import type { PathProvider } from './path-provider.ts'
import type { SecretAdapter } from './secret-adapter.ts'

export type WorkspaceCheckpointRootKind = PortableRuntimeEntryKind

export type WorkspaceCheckpointRoot = {
  rootId: string
  kind: WorkspaceCheckpointRootKind
  path: string
  required?: boolean
  secretBearing?: boolean
}

export type WorkspaceCheckpointEntry = {
  rootId: string
  kind: WorkspaceCheckpointRootKind
  relativePath: string
  objectKey: string
  size: number
  storedSize: number
  sha256: string
  mode: number | null
  secretBearing: boolean
  encrypted: boolean
  updatedAt: string | null
}

export type WorkspaceCheckpointManifest = {
  version: 1
  tenantId: string
  sessionId: string
  checkpointId: string
  checkpointVersion: number | null
  createdAt: string
  manifestKey: string
  latestKey: string
  roots: Array<{
    rootId: string
    kind: WorkspaceCheckpointRootKind
    required: boolean
    secretBearing: boolean
  }>
  entries: WorkspaceCheckpointEntry[]
}

export type WorkspaceCheckpointStore = {
  saveSessionCheckpoint(input: SaveSessionCheckpointInput): Promise<WorkspaceCheckpointManifest>
  readSessionCheckpoint(input: ReadSessionCheckpointInput): Promise<WorkspaceCheckpointManifest | null>
  restoreSessionCheckpoint(input: RestoreSessionCheckpointInput): Promise<WorkspaceCheckpointRestoreResult>
}

export type SaveSessionCheckpointInput = {
  tenantId: string
  sessionId: string
  checkpointId?: string
  checkpointVersion?: number | null
  roots: WorkspaceCheckpointRoot[]
  now?: Date
}

export type ReadSessionCheckpointInput = {
  tenantId: string
  sessionId: string
  checkpointId?: string | null
  manifestKey?: string | null
}

export type RestoreSessionCheckpointInput = ReadSessionCheckpointInput & {
  roots: WorkspaceCheckpointRoot[]
}

export type WorkspaceCheckpointRestoreResult = {
  manifest: WorkspaceCheckpointManifest
  restoredEntries: number
}

export type ObjectWorkspaceCheckpointStoreOptions = {
  objectStore: ObjectStoreAdapter
  secretAdapter?: SecretAdapter | null
  maxFiles?: number
  maxBytes?: number
}

type CollectedFile = {
  absolutePath: string
  rootRealPath: string
  relativePath: string
  size: number
  device: number
  inode: number
  ctimeMs: number
  mtimeMs: number
  mode: number | null
  updatedAt: string | null
}

const DEFAULT_MAX_FILES = 10_000
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024
const MAX_CHECKPOINT_ROOTS = 256
const SECRET_CONTENT_TYPE = 'application/vnd.open-cowork.cloud-secret+text'
const MANIFEST_CONTENT_TYPE = 'application/vnd.open-cowork.checkpoint-manifest+json'
const CHECKPOINT_ROOT_KINDS = new Set<WorkspaceCheckpointRootKind>([
  'opencode-config',
  'opencode-data',
  'opencode-state',
  'opencode-cache',
  'cowork-runtime-content',
  'workspace',
  'artifact',
  'metadata',
])

function sha256(buffer: Buffer | string) {
  return createHash('sha256').update(buffer).digest('hex')
}

function legacySafeSegment(value: string, fallback: string) {
  const collapsed = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-')
  // Linear-time trim of leading/trailing '-' (equivalent to .replace(/^-+|-+$/g, '')
  // without the super-linear backtracking that pattern incurs on long dash runs).
  let start = 0
  let end = collapsed.length
  while (start < end && collapsed.charCodeAt(start) === 45) start += 1
  while (end > start && collapsed.charCodeAt(end - 1) === 45) end -= 1
  const normalized = collapsed.slice(start, end)
  return normalized.slice(0, 96) || fallback
}

function safeSegment(value: string, fallback: string) {
  const readablePrefix = legacySafeSegment(value, fallback).slice(0, 48)
  return `${readablePrefix}-${sha256(value)}`
}

function assertCloudId(value: string, label: string) {
  if (!value.trim() || value.includes('\0') || value.length > 256) {
    throw new Error(`${label} is invalid.`)
  }
  return value
}

function isMissingError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function normalizeRelativePath(value: string) {
  const normalized = value.replace(/\\/g, '/')
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/') || normalized.split('/').some((part) => (
    !part || part === '.' || part === '..'
  ))) {
    throw new Error(`Checkpoint relative path is invalid: ${value}`)
  }
  return normalized
}

function resolveInside(root: string, relativePath: string) {
  const parts = normalizeRelativePath(relativePath).split('/')
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, ...parts)
  const rel = relative(resolvedRoot, target)
  if (rel && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new Error(`Checkpoint restore path escapes root ${resolvedRoot}.`)
  }
  return target
}

function assertRealPathInside(root: string, target: string) {
  const rel = relative(root, target)
  if (rel && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new Error(`Checkpoint source path escapes root ${root}.`)
  }
}

function rootKey(root: WorkspaceCheckpointRoot) {
  return safeSegment(root.rootId, 'root')
}

function legacyRootKey(root: Pick<WorkspaceCheckpointRoot, 'rootId'>) {
  return legacySafeSegment(root.rootId, 'root')
}

function checkpointPrefixWith(
  segment: (value: string, fallback: string) => string,
  tenantId: string,
  sessionId: string,
) {
  return assertSafeObjectKey([
    'tenants',
    segment(tenantId, 'tenant'),
    'sessions',
    segment(sessionId, 'session'),
    'checkpoints',
  ].join('/'))
}

function checkpointPrefix(tenantId: string, sessionId: string) {
  return checkpointPrefixWith(safeSegment, tenantId, sessionId)
}

function legacyCheckpointPrefix(tenantId: string, sessionId: string) {
  return checkpointPrefixWith(legacySafeSegment, tenantId, sessionId)
}

export function sessionCheckpointManifestKey(input: {
  tenantId: string
  sessionId: string
  checkpointId: string
}) {
  return assertSafeObjectKey(`${checkpointPrefix(input.tenantId, input.sessionId)}/${safeSegment(input.checkpointId, 'checkpoint')}/manifest.json`)
}

export function sessionCheckpointLatestKey(input: {
  tenantId: string
  sessionId: string
}) {
  return assertSafeObjectKey(`${checkpointPrefix(input.tenantId, input.sessionId)}/latest.json`)
}

function legacySessionCheckpointManifestKey(input: {
  tenantId: string
  sessionId: string
  checkpointId: string
}) {
  return assertSafeObjectKey(`${legacyCheckpointPrefix(input.tenantId, input.sessionId)}/${legacySafeSegment(input.checkpointId, 'checkpoint')}/manifest.json`)
}

function legacySessionCheckpointLatestKey(input: {
  tenantId: string
  sessionId: string
}) {
  return assertSafeObjectKey(`${legacyCheckpointPrefix(input.tenantId, input.sessionId)}/latest.json`)
}

function checkpointFileObjectKey(input: {
  tenantId: string
  sessionId: string
  checkpointId: string
  root: WorkspaceCheckpointRoot
  relativePath: string
}) {
  const digest = sha256(`${input.root.rootId}\0${input.relativePath}`)
  const name = safeSegment(basename(input.relativePath), 'file')
  return assertSafeObjectKey([
    checkpointPrefix(input.tenantId, input.sessionId),
    safeSegment(input.checkpointId, 'checkpoint'),
    'files',
    rootKey(input.root),
    `${digest}-${name}`,
  ].join('/'))
}

function legacyCheckpointFileObjectKey(input: {
  tenantId: string
  sessionId: string
  checkpointId: string
  root: Pick<WorkspaceCheckpointRoot, 'rootId'>
  relativePath: string
}) {
  const digest = sha256(`${input.root.rootId}\0${input.relativePath}`).slice(0, 24)
  const name = legacySafeSegment(basename(input.relativePath), 'file')
  return assertSafeObjectKey([
    legacyCheckpointPrefix(input.tenantId, input.sessionId),
    legacySafeSegment(input.checkpointId, 'checkpoint'),
    'files',
    legacyRootKey(input.root),
    `${digest}-${name}`,
  ].join('/'))
}

async function collectRootFiles(
  root: WorkspaceCheckpointRoot,
  limits: { maxFiles: number, maxBytes: number },
  totals?: { files: number, bytes: number },
): Promise<CollectedFile[]> {
  const rootPath = resolve(root.path)
  let rootStats: Awaited<ReturnType<typeof lstat>>
  try {
    rootStats = await lstat(rootPath)
  } catch (error) {
    if (!root.required && isMissingError(error)) return []
    throw error
  }
  if (rootStats.isSymbolicLink()) {
    throw new Error(`Checkpoint root ${rootPath} must not be a symlink.`)
  }
  if (!rootStats.isDirectory()) {
    throw new Error(`Checkpoint root ${rootPath} must be a directory.`)
  }
  const rootRealPath = await realpath(rootPath)

  const files: CollectedFile[] = []
  let totalBytes = 0

  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      const stats = await lstat(absolutePath)
      if (stats.isSymbolicLink()) {
        continue
      }
      if (stats.isDirectory()) {
        await visit(absolutePath)
        continue
      }
      if (!stats.isFile()) continue
      if (stats.nlink !== 1) {
        throw new Error(`Checkpoint source file must not be hard-linked: ${absolutePath}`)
      }
      assertRealPathInside(rootRealPath, await realpath(absolutePath))
      const rel = relative(rootPath, absolutePath).replace(/\\/g, '/')
      const relativePath = normalizeRelativePath(rel)
      totalBytes += stats.size
      if (files.length + 1 > limits.maxFiles) throw new Error('Checkpoint file count exceeds the configured limit.')
      if (totalBytes > limits.maxBytes) throw new Error('Checkpoint byte size exceeds the configured limit.')
      if (totals) {
        totals.files += 1
        totals.bytes += stats.size
        if (totals.files > limits.maxFiles) throw new Error('Checkpoint file count exceeds the configured limit.')
        if (totals.bytes > limits.maxBytes) throw new Error('Checkpoint byte size exceeds the configured limit.')
      }
      files.push({
        absolutePath,
        rootRealPath,
        relativePath,
        size: stats.size,
        device: stats.dev,
        inode: stats.ino,
        ctimeMs: stats.ctimeMs,
        mtimeMs: stats.mtimeMs,
        mode: stats.mode & 0o777,
        updatedAt: stats.mtime.toISOString(),
      })
    }
  }

  await visit(rootPath)
  return files
}

async function readCollectedFile(file: CollectedFile) {
  assertRealPathInside(file.rootRealPath, await realpath(file.absolutePath))
  const handle = await open(file.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.dev !== file.device
      || before.ino !== file.inode
      || before.size !== file.size
      || before.ctimeMs !== file.ctimeMs
      || before.mtimeMs !== file.mtimeMs
    ) {
      throw new Error(`Checkpoint source changed before capture: ${file.relativePath}`)
    }
    const body = await handle.readFile()
    const after = await handle.stat()
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.ctimeMs !== before.ctimeMs
      || after.mtimeMs !== before.mtimeMs
      || body.byteLength !== before.size
    ) {
      throw new Error(`Checkpoint source changed during capture: ${file.relativePath}`)
    }
    assertRealPathInside(file.rootRealPath, await realpath(file.absolutePath))
    const current = await lstat(file.absolutePath)
    if (current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) {
      throw new Error(`Checkpoint source changed after capture: ${file.relativePath}`)
    }
    return body
  } finally {
    await handle.close()
  }
}

function normalizeRoot(root: WorkspaceCheckpointRoot): WorkspaceCheckpointRoot {
  if (!CHECKPOINT_ROOT_KINDS.has(root.kind)) {
    throw new Error(`Checkpoint root kind is invalid: ${String(root.kind)}`)
  }
  return {
    rootId: assertCloudId(root.rootId, 'checkpoint rootId'),
    kind: root.kind,
    path: resolve(root.path),
    required: root.required === true,
    secretBearing: root.secretBearing === true,
  }
}

function normalizeRoots(roots: WorkspaceCheckpointRoot[]) {
  if (roots.length > MAX_CHECKPOINT_ROOTS) {
    throw new Error('Checkpoint has too many roots.')
  }
  const normalized = roots.map(normalizeRoot)
  const rootIds = new Set<string>()
  const paths = new Set<string>()
  for (const root of normalized) {
    if (rootIds.has(root.rootId)) {
      throw new Error(`Checkpoint rootId is duplicated: ${root.rootId}`)
    }
    if (paths.has(root.path)) {
      throw new Error(`Checkpoint root path is duplicated: ${root.path}`)
    }
    if (dirname(root.path) === root.path) {
      throw new Error('Checkpoint roots must not target a filesystem root.')
    }
    rootIds.add(root.rootId)
    paths.add(root.path)
  }
  for (let index = 0; index < normalized.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < normalized.length; otherIndex += 1) {
      const left = normalized[index]!
      const right = normalized[otherIndex]!
      const leftToRight = relative(left.path, right.path)
      const rightToLeft = relative(right.path, left.path)
      const nested = (
        leftToRight
        && leftToRight !== '..'
        && !leftToRight.startsWith(`..${sep}`)
        && !isAbsolute(leftToRight)
      ) || (
        rightToLeft
        && rightToLeft !== '..'
        && !rightToLeft.startsWith(`..${sep}`)
        && !isAbsolute(rightToLeft)
      )
      if (nested) {
        throw new Error(`Checkpoint root paths must not overlap: ${left.path} and ${right.path}`)
      }
    }
  }
  return normalized
}

function secretContext(input: {
  tenantId: string
  sessionId: string
  checkpointId: string
  rootId: string
  relativePath: string
}) {
  return [
    'open-cowork-cloud-checkpoint',
    input.tenantId,
    input.sessionId,
    input.checkpointId,
    input.rootId,
    input.relativePath,
  ].join('\0')
}

function manifestRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`)
  }
  return value as Record<string, unknown>
}

function manifestString(value: unknown, label: string) {
  if (typeof value !== 'string') throw new Error(`${label} is invalid.`)
  return value
}

function manifestBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw new Error(`${label} is invalid.`)
  return value
}

function manifestInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new Error(`${label} is invalid.`)
  }
  return Number(value)
}

function manifestNullableDate(value: unknown, label: string) {
  if (value === null) return null
  const text = manifestString(value, label)
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} is invalid.`)
  return text
}

function manifestKind(value: unknown, label: string): WorkspaceCheckpointRootKind {
  if (typeof value !== 'string' || !CHECKPOINT_ROOT_KINDS.has(value as WorkspaceCheckpointRootKind)) {
    throw new Error(`${label} is invalid.`)
  }
  return value as WorkspaceCheckpointRootKind
}

function parseManifest(body: Buffer, maxFiles: number): WorkspaceCheckpointManifest {
  if (body.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error('Checkpoint manifest exceeds the configured size limit.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('Checkpoint manifest is not valid JSON.')
  }
  const raw = manifestRecord(parsed, 'Checkpoint manifest')
  if (raw.version !== 1) throw new Error('Unsupported checkpoint manifest version.')
  if (!Array.isArray(raw.roots)) throw new Error('Checkpoint manifest roots are invalid.')
  if (!Array.isArray(raw.entries)) throw new Error('Checkpoint manifest entries are invalid.')
  if (raw.roots.length > MAX_CHECKPOINT_ROOTS) throw new Error('Checkpoint manifest has too many roots.')
  if (raw.entries.length > maxFiles) throw new Error('Checkpoint file count exceeds the configured limit.')
  const tenantId = assertCloudId(manifestString(raw.tenantId, 'Checkpoint manifest tenantId'), 'checkpoint tenantId')
  const sessionId = assertCloudId(manifestString(raw.sessionId, 'Checkpoint manifest sessionId'), 'checkpoint sessionId')
  const checkpointId = assertCloudId(manifestString(raw.checkpointId, 'Checkpoint manifest checkpointId'), 'checkpoint checkpointId')
  const checkpointVersion = raw.checkpointVersion === null
    ? null
    : manifestInteger(raw.checkpointVersion, 'Checkpoint manifest checkpointVersion')
  const createdAt = manifestNullableDate(raw.createdAt, 'Checkpoint manifest createdAt')
  if (createdAt === null) throw new Error('Checkpoint manifest createdAt is invalid.')
  const manifestKey = assertSafeObjectKey(manifestString(raw.manifestKey, 'Checkpoint manifest manifestKey'))
  const latestKey = assertSafeObjectKey(manifestString(raw.latestKey, 'Checkpoint manifest latestKey'))
  const rootIds = new Set<string>()
  const roots = raw.roots.map((rootValue, index) => {
    const root = manifestRecord(rootValue, `Checkpoint manifest root ${index}`)
    const rootId = assertCloudId(
      manifestString(root.rootId, `Checkpoint manifest root ${index} rootId`),
      'checkpoint rootId',
    )
    if (rootIds.has(rootId)) throw new Error(`Checkpoint manifest rootId is duplicated: ${rootId}`)
    rootIds.add(rootId)
    return {
      rootId,
      kind: manifestKind(root.kind, `Checkpoint manifest root ${index} kind`),
      required: manifestBoolean(root.required, `Checkpoint manifest root ${index} required`),
      secretBearing: manifestBoolean(root.secretBearing, `Checkpoint manifest root ${index} secretBearing`),
    }
  })
  const rootsById = new Map(roots.map((root) => [root.rootId, root]))
  const entryPaths = new Set<string>()
  const objectKeys = new Set<string>()
  const entries = raw.entries.map((entryValue, index): WorkspaceCheckpointEntry => {
    const entry = manifestRecord(entryValue, `Checkpoint manifest entry ${index}`)
    const rootId = assertCloudId(
      manifestString(entry.rootId, `Checkpoint manifest entry ${index} rootId`),
      'checkpoint entry rootId',
    )
    const root = rootsById.get(rootId)
    if (!root) throw new Error(`Checkpoint manifest entry references unknown root ${rootId}.`)
    const kind = manifestKind(entry.kind, `Checkpoint manifest entry ${index} kind`)
    if (kind !== root.kind) {
      throw new Error(`Checkpoint manifest entry kind does not match root ${rootId}.`)
    }
    const relativePathValue = manifestString(entry.relativePath, `Checkpoint manifest entry ${index} relativePath`)
    const relativePath = normalizeRelativePath(relativePathValue)
    if (relativePath !== relativePathValue) {
      throw new Error(`Checkpoint manifest entry path is not canonical: ${relativePathValue}`)
    }
    const pathIdentity = `${rootId}\0${relativePath}`
    if (entryPaths.has(pathIdentity)) {
      throw new Error(`Checkpoint manifest entry path is duplicated: ${rootId}/${relativePath}`)
    }
    entryPaths.add(pathIdentity)
    const objectKey = assertSafeObjectKey(manifestString(entry.objectKey, `Checkpoint manifest entry ${index} objectKey`))
    if (objectKeys.has(objectKey)) {
      throw new Error(`Checkpoint manifest object key is duplicated: ${objectKey}`)
    }
    objectKeys.add(objectKey)
    const digest = manifestString(entry.sha256, `Checkpoint manifest entry ${index} sha256`)
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error(`Checkpoint manifest entry ${index} sha256 is invalid.`)
    }
    const mode = entry.mode === null
      ? null
      : manifestInteger(entry.mode, `Checkpoint manifest entry ${index} mode`, 0o777)
    return {
      rootId,
      kind,
      relativePath,
      objectKey,
      size: manifestInteger(entry.size, `Checkpoint manifest entry ${index} size`),
      storedSize: manifestInteger(entry.storedSize, `Checkpoint manifest entry ${index} storedSize`),
      sha256: digest,
      mode,
      secretBearing: manifestBoolean(entry.secretBearing, `Checkpoint manifest entry ${index} secretBearing`),
      encrypted: manifestBoolean(entry.encrypted, `Checkpoint manifest entry ${index} encrypted`),
      updatedAt: manifestNullableDate(entry.updatedAt, `Checkpoint manifest entry ${index} updatedAt`),
    }
  })
  return {
    version: 1,
    tenantId,
    sessionId,
    checkpointId,
    checkpointVersion,
    createdAt,
    manifestKey,
    latestKey,
    roots,
    entries,
  }
}

function validateManifestForRequest(
  manifest: WorkspaceCheckpointManifest,
  input: { tenantId: string, sessionId: string },
  limits: { maxFiles: number, maxBytes: number },
) {
  if (manifest.tenantId !== input.tenantId || manifest.sessionId !== input.sessionId) {
    throw new Error('Checkpoint manifest ownership does not match the restore request.')
  }
  const expectedManifestKeys = new Set([
    sessionCheckpointManifestKey({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      checkpointId: manifest.checkpointId,
    }),
    legacySessionCheckpointManifestKey({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      checkpointId: manifest.checkpointId,
    }),
  ])
  if (!expectedManifestKeys.has(manifest.manifestKey)) {
    throw new Error('Checkpoint manifest key does not match its ownership metadata.')
  }
  const expectedLatestKeys = new Set([
    sessionCheckpointLatestKey(input),
    legacySessionCheckpointLatestKey(input),
  ])
  if (!expectedLatestKeys.has(manifest.latestKey)) {
    throw new Error('Checkpoint latest key does not match its ownership metadata.')
  }
  if (manifest.entries.length > limits.maxFiles) {
    throw new Error('Checkpoint file count exceeds the configured limit.')
  }
  let totalBytes = 0
  for (const entry of manifest.entries) {
    totalBytes += entry.size
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxBytes) {
      throw new Error('Checkpoint byte size exceeds the configured limit.')
    }
    const keyInput = {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      checkpointId: manifest.checkpointId,
      root: { rootId: entry.rootId },
      relativePath: entry.relativePath,
    }
    const expectedCurrentKey = checkpointFileObjectKey({
      ...keyInput,
      root: {
        ...keyInput.root,
        kind: entry.kind,
        path: '',
      },
    })
    if (
      entry.objectKey !== expectedCurrentKey
      && entry.objectKey !== legacyCheckpointFileObjectKey(keyInput)
    ) {
      throw new Error(`Checkpoint object key does not match its manifest entry: ${entry.objectKey}`)
    }
  }
}

function validateRestoreRoots(
  inputRoots: WorkspaceCheckpointRoot[],
  manifest: WorkspaceCheckpointManifest,
) {
  const normalized = normalizeRoots(inputRoots)
  const roots = new Map(normalized.map((root) => [root.rootId, root]))
  if (roots.size !== manifest.roots.length) {
    throw new Error('Restore roots do not exactly match the checkpoint manifest.')
  }
  for (const manifestRoot of manifest.roots) {
    const root = roots.get(manifestRoot.rootId)
    if (!root) {
      throw new Error(`No restore root was provided for checkpoint root ${manifestRoot.rootId}.`)
    }
    if (root.kind !== manifestRoot.kind) {
      throw new Error(`Restore root kind does not match checkpoint root ${manifestRoot.rootId}.`)
    }
  }
  return roots
}

type RestoreStage = {
  root: WorkspaceCheckpointRoot
  stagePath: string
  backupPath: string
  hadOriginal: boolean
  installed: boolean
}

async function checkpointPathStats(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (isMissingError(error)) return null
    throw error
  })
}

async function recoverInterruptedRestore(stage: RestoreStage) {
  const [live, staged, backup] = await Promise.all([
    checkpointPathStats(stage.root.path),
    checkpointPathStats(stage.stagePath),
    checkpointPathStats(stage.backupPath),
  ])
  for (const [label, stats] of [
    ['stage', staged],
    ['backup', backup],
  ] as const) {
    if (stats?.isSymbolicLink() || (stats && !stats.isDirectory())) {
      throw new Error(`Checkpoint restore ${label} path is invalid for ${stage.root.rootId}.`)
    }
  }
  if (backup) {
    if (live) {
      await rm(stage.root.path, { recursive: true, force: true })
    }
    await rename(stage.backupPath, stage.root.path)
    stage.hadOriginal = false
    if (staged) await rm(stage.stagePath, { recursive: true, force: true })
    return
  }
  if (staged) await rm(stage.stagePath, { recursive: true, force: true })
}

async function removeRestorePaths(stages: RestoreStage[]) {
  const errors: unknown[] = []
  for (const stage of stages) {
    for (const path of [stage.stagePath, stage.backupPath]) {
      try {
        await rm(path, { recursive: true, force: true })
      } catch (error) {
        errors.push(error)
      }
    }
  }
  return errors
}

async function rollbackRestore(stages: RestoreStage[]) {
  const errors: unknown[] = []
  for (const stage of [...stages].reverse()) {
    try {
      if (stage.installed) {
        await rm(stage.root.path, { recursive: true, force: true })
        stage.installed = false
      }
      if (stage.hadOriginal) {
        await rename(stage.backupPath, stage.root.path)
        stage.hadOriginal = false
      }
    } catch (error) {
      errors.push(error)
    }
  }
  for (const stage of stages) {
    try {
      await rm(stage.stagePath, { recursive: true, force: true })
      if (!stage.hadOriginal) {
        await rm(stage.backupPath, { recursive: true, force: true })
      }
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
}

function throwWithCleanupErrors(message: string, error: unknown, cleanupErrors: unknown[]): never {
  if (cleanupErrors.length === 0) throw error
  throw new AggregateError([error, ...cleanupErrors], message)
}

export function defaultCloudSessionCheckpointRoots(
  paths: PathProvider,
  tenantId: string,
  sessionId: string,
): WorkspaceCheckpointRoot[] {
  const runtimePaths = paths.getRuntimeXdgRoots()
  return [
    {
      rootId: 'opencode-config',
      kind: 'opencode-config',
      path: join(runtimePaths.configHome, 'opencode'),
      secretBearing: true,
    },
    {
      rootId: 'opencode-data',
      kind: 'opencode-data',
      path: join(runtimePaths.dataHome, 'opencode'),
      secretBearing: true,
    },
    {
      rootId: 'opencode-state',
      kind: 'opencode-state',
      path: join(runtimePaths.stateHome, 'opencode'),
      secretBearing: true,
    },
    {
      rootId: 'opencode-cache',
      kind: 'opencode-cache',
      path: join(runtimePaths.cacheHome, 'opencode'),
    },
    {
      rootId: 'runtime-skill-catalog',
      kind: 'cowork-runtime-content',
      path: join(runtimePaths.home, 'runtime-skill-catalog'),
    },
    {
      rootId: 'managed-skills',
      kind: 'cowork-runtime-content',
      path: join(runtimePaths.home, 'managed-skills'),
    },
    {
      rootId: 'workspace',
      kind: 'workspace',
      path: paths.resolveWorkspacePath(tenantId, sessionId),
      secretBearing: false,
    },
    {
      rootId: 'artifacts',
      kind: 'artifact',
      path: paths.resolveArtifactPath(tenantId, sessionId),
      secretBearing: false,
    },
  ]
}

export function createObjectWorkspaceCheckpointStore(
  options: ObjectWorkspaceCheckpointStoreOptions,
): WorkspaceCheckpointStore {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error('Checkpoint maxFiles must be a positive safe integer.')
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Checkpoint maxBytes must be a positive safe integer.')
  }
  const secretAdapter = options.secretAdapter || null

  return {
    async saveSessionCheckpoint(input) {
      const tenantId = assertCloudId(input.tenantId, 'tenantId')
      const sessionId = assertCloudId(input.sessionId, 'sessionId')
      const checkpointId = assertCloudId(input.checkpointId || randomUUID(), 'checkpointId')
      if (secretAdapter?.mode !== 'envelope-v1') {
        throw new Error('Checkpoint saves require an envelope-encrypted SecretAdapter.')
      }
      const createdAt = (input.now || new Date()).toISOString()
      const manifestKey = sessionCheckpointManifestKey({ tenantId, sessionId, checkpointId })
      const latestKey = sessionCheckpointLatestKey({ tenantId, sessionId })
      const roots = normalizeRoots(input.roots)
      const entries: WorkspaceCheckpointEntry[] = []
      const totals = { files: 0, bytes: 0 }

      for (const root of roots) {
        const files = await collectRootFiles(root, { maxFiles, maxBytes }, totals)
        for (const file of files) {
          const body = await readCollectedFile(file)
          const contentSha256 = sha256(body)
          const context = secretContext({
            tenantId,
            sessionId,
            checkpointId,
            rootId: root.rootId,
            relativePath: file.relativePath,
          })
          const storedBody = Buffer.from(
            secretAdapter.protect(body.toString('base64'), context),
            'utf8',
          )
          const objectKey = checkpointFileObjectKey({
            tenantId,
            sessionId,
            checkpointId,
            root,
            relativePath: file.relativePath,
          })
          const stored = await options.objectStore.putObject({
            key: objectKey,
            body: storedBody,
            contentType: SECRET_CONTENT_TYPE,
            metadata: {
              tenant: tenantId,
              session: sessionId,
              checkpoint: checkpointId,
              root: root.rootId,
              kind: root.kind,
              sha256: contentSha256,
              encrypted: 'true',
            },
          })
          entries.push({
            rootId: root.rootId,
            kind: root.kind,
            relativePath: file.relativePath,
            objectKey,
            size: file.size,
            storedSize: stored.size,
            sha256: contentSha256,
            mode: file.mode,
            // Kept for v1 manifest compatibility. New checkpoints treat every
            // payload as confidential rather than encoding a filename-based
            // classification into durable metadata.
            secretBearing: true,
            encrypted: true,
            updatedAt: file.updatedAt,
          })
        }
      }

      const manifest: WorkspaceCheckpointManifest = {
        version: 1,
        tenantId,
        sessionId,
        checkpointId,
        checkpointVersion: input.checkpointVersion ?? null,
        createdAt,
        manifestKey,
        latestKey,
        roots: roots.map((root) => ({
          rootId: root.rootId,
          kind: root.kind,
          required: root.required === true,
          secretBearing: true,
        })),
        entries,
      }
      const body = JSON.stringify(manifest, null, 2)
      await options.objectStore.putObject({
        key: manifestKey,
        body,
        contentType: MANIFEST_CONTENT_TYPE,
        metadata: {
          tenant: tenantId,
          session: sessionId,
          checkpoint: checkpointId,
          latest: 'false',
        },
      })
      await options.objectStore.putObject({
        key: latestKey,
        body,
        contentType: MANIFEST_CONTENT_TYPE,
        metadata: {
          tenant: tenantId,
          session: sessionId,
          checkpoint: checkpointId,
          latest: 'true',
        },
      })
      return manifest
    },

    async readSessionCheckpoint(input) {
      const tenantId = assertCloudId(input.tenantId, 'tenantId')
      const sessionId = assertCloudId(input.sessionId, 'sessionId')
      const checkpointId = input.checkpointId
        ? assertCloudId(input.checkpointId, 'checkpointId')
        : null
      const keys = input.manifestKey
        ? [assertSafeObjectKey(input.manifestKey)]
        : checkpointId
          ? [
              sessionCheckpointManifestKey({ tenantId, sessionId, checkpointId }),
              legacySessionCheckpointManifestKey({ tenantId, sessionId, checkpointId }),
            ]
          : [
              sessionCheckpointLatestKey({ tenantId, sessionId }),
              legacySessionCheckpointLatestKey({ tenantId, sessionId }),
            ]
      let object = null
      let objectKey: string | null = null
      for (const key of keys) {
        object = await options.objectStore.getObject(key)
        if (object) {
          objectKey = key
          break
        }
      }
      if (!object || !objectKey) return null
      const manifest = parseManifest(object.body, maxFiles)
      validateManifestForRequest(manifest, { tenantId, sessionId }, { maxFiles, maxBytes })
      if (checkpointId && manifest.checkpointId !== checkpointId) {
        throw new Error('Checkpoint manifest ID does not match the requested checkpoint.')
      }
      if (input.manifestKey && objectKey !== manifest.manifestKey && objectKey !== manifest.latestKey) {
        throw new Error('Checkpoint manifest was read from an unexpected object key.')
      }
      return manifest
    },

    async restoreSessionCheckpoint(input) {
      const tenantId = assertCloudId(input.tenantId, 'tenantId')
      const sessionId = assertCloudId(input.sessionId, 'sessionId')
      const manifest = await this.readSessionCheckpoint(input)
      if (!manifest) throw new Error('Checkpoint manifest was not found.')
      const roots = validateRestoreRoots(input.roots, manifest)
      const stages: RestoreStage[] = []

      try {
        for (const manifestRoot of manifest.roots) {
          const root = roots.get(manifestRoot.rootId)!
          const existing = await checkpointPathStats(root.path)
          if (existing?.isSymbolicLink()) {
            throw new Error(`Checkpoint restore root must not be a symlink: ${root.path}`)
          }
          if (existing && !existing.isDirectory()) {
            throw new Error(`Checkpoint restore root must be a directory: ${root.path}`)
          }
          const parent = dirname(root.path)
          const suffix = `.open-cowork-checkpoint-${rootKey(root)}`
          const stagePath = join(parent, `${suffix}.stage`)
          const backupPath = join(parent, `${suffix}.backup`)
          await mkdir(parent, { recursive: true, mode: 0o700 })
          const stage = {
            root,
            stagePath,
            backupPath,
            hadOriginal: false,
            installed: false,
          }
          await recoverInterruptedRestore(stage)
          await mkdir(stagePath, { mode: 0o700 })
          stages.push(stage)
        }

        const stagesByRoot = new Map(stages.map((stage) => [stage.root.rootId, stage]))
        for (const entry of manifest.entries) {
          const stage = stagesByRoot.get(entry.rootId)!
          const object = await options.objectStore.getObject(entry.objectKey)
          if (!object) throw new Error(`Checkpoint object is missing: ${entry.objectKey}`)
          if (object.body.byteLength !== entry.storedSize) {
            throw new Error(`Checkpoint stored size mismatch for ${entry.rootId}/${entry.relativePath}.`)
          }
          const context = secretContext({
            tenantId,
            sessionId,
            checkpointId: manifest.checkpointId,
            rootId: entry.rootId,
            relativePath: entry.relativePath,
          })
          let body = object.body
          if (entry.encrypted) {
            if (!secretAdapter) throw new Error('Encrypted checkpoint entries require a SecretAdapter.')
            body = Buffer.from(secretAdapter.reveal(object.body.toString('utf8'), context), 'base64')
          }
          if (body.byteLength !== entry.size) {
            throw new Error(`Checkpoint object size mismatch for ${entry.rootId}/${entry.relativePath}.`)
          }
          if (sha256(body) !== entry.sha256) {
            throw new Error(`Checkpoint object hash mismatch for ${entry.rootId}/${entry.relativePath}.`)
          }
          const target = resolveInside(stage.stagePath, entry.relativePath)
          await mkdir(dirname(target), { recursive: true, mode: 0o700 })
          await writeFile(target, body, {
            flag: 'wx',
            mode: entry.mode ?? 0o600,
          })
          if (entry.updatedAt) {
            const timestamp = new Date(entry.updatedAt)
            await utimes(target, timestamp, timestamp)
          }
        }
      } catch (error) {
        const cleanupErrors = await removeRestorePaths(stages)
        throwWithCleanupErrors('Checkpoint staging failed and cleanup was incomplete.', error, cleanupErrors)
      }

      const swapped: RestoreStage[] = []
      try {
        for (const stage of stages) {
          swapped.push(stage)
          const existing = await checkpointPathStats(stage.root.path)
          if (existing?.isSymbolicLink()) {
            throw new Error(`Checkpoint restore root became a symlink: ${stage.root.path}`)
          }
          if (existing && !existing.isDirectory()) {
            throw new Error(`Checkpoint restore root became a non-directory: ${stage.root.path}`)
          }
          if (existing) {
            await rename(stage.root.path, stage.backupPath)
            stage.hadOriginal = true
          }
          await rename(stage.stagePath, stage.root.path)
          stage.installed = true
        }
      } catch (error) {
        const rollbackErrors = await rollbackRestore(swapped)
        const untouchedCleanupErrors = await removeRestorePaths(
          stages.filter((stage) => !swapped.includes(stage)),
        )
        throwWithCleanupErrors(
          'Checkpoint restore failed and rollback was incomplete.',
          error,
          [...rollbackErrors, ...untouchedCleanupErrors],
        )
      }

      const cleanupErrors = await removeRestorePaths(stages)
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Checkpoint restore succeeded but backup cleanup was incomplete.')
      }
      return {
        manifest,
        restoredEntries: manifest.entries.length,
      }
    },
  }
}
