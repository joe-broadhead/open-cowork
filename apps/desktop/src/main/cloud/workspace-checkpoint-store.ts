import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, lstat, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { PortableRuntimeEntryKind } from './runtime-portability.ts'
import { isRuntimeSnapshotSecretBearingPath } from './runtime-portability.ts'
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
  requireSecretAdapterForSecrets?: boolean
  maxFiles?: number
  maxBytes?: number
}

type CollectedFile = {
  absolutePath: string
  relativePath: string
  size: number
  mode: number | null
  updatedAt: string | null
}

const DEFAULT_MAX_FILES = 10_000
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024
const SECRET_CONTENT_TYPE = 'application/vnd.open-cowork.cloud-secret+text'
const MANIFEST_CONTENT_TYPE = 'application/vnd.open-cowork.checkpoint-manifest+json'

function sha256(buffer: Buffer | string) {
  return createHash('sha256').update(buffer).digest('hex')
}

function safeSegment(value: string, fallback: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized.slice(0, 96) || fallback
}

function assertCloudId(value: string, label: string) {
  if (!value.trim() || value.includes('\0') || value.length > 256) {
    throw new Error(`${label} is invalid.`)
  }
  return value
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
  if (rel && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`Checkpoint restore path escapes root ${resolvedRoot}.`)
  }
  return target
}

function rootKey(root: WorkspaceCheckpointRoot) {
  return safeSegment(root.rootId, 'root')
}

function checkpointPrefix(tenantId: string, sessionId: string) {
  return assertSafeObjectKey([
    'tenants',
    safeSegment(tenantId, 'tenant'),
    'sessions',
    safeSegment(sessionId, 'session'),
    'checkpoints',
  ].join('/'))
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

function checkpointFileObjectKey(input: {
  tenantId: string
  sessionId: string
  checkpointId: string
  root: WorkspaceCheckpointRoot
  relativePath: string
}) {
  const digest = sha256(`${input.root.rootId}\0${input.relativePath}`).slice(0, 24)
  const name = safeSegment(basename(input.relativePath), 'file')
  return assertSafeObjectKey([
    checkpointPrefix(input.tenantId, input.sessionId),
    safeSegment(input.checkpointId, 'checkpoint'),
    'files',
    rootKey(input.root),
    `${digest}-${name}`,
  ].join('/'))
}

async function collectRootFiles(
  root: WorkspaceCheckpointRoot,
  limits: { maxFiles: number, maxBytes: number },
  totals?: { files: number, bytes: number },
): Promise<CollectedFile[]> {
  const rootPath = resolve(root.path)
  try {
    const stats = await lstat(rootPath)
    if (!stats.isDirectory()) {
      throw new Error(`Checkpoint root ${rootPath} must be a directory.`)
    }
  } catch (error) {
    if (root.required) throw error
    return []
  }

  const files: CollectedFile[] = []
  let totalBytes = 0

  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name)
      const stats = await lstat(absolutePath)
      if (stats.isSymbolicLink()) {
        throw new Error(`Checkpoint root ${rootPath} contains unsupported symlink ${absolutePath}.`)
      }
      if (stats.isDirectory()) {
        await visit(absolutePath)
        continue
      }
      if (!stats.isFile()) continue
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
        relativePath,
        size: stats.size,
        mode: stats.mode & 0o777,
        updatedAt: stats.mtime.toISOString(),
      })
    }
  }

  await visit(rootPath)
  return files
}

function normalizeRoot(root: WorkspaceCheckpointRoot): WorkspaceCheckpointRoot {
  return {
    rootId: assertCloudId(root.rootId, 'checkpoint rootId'),
    kind: root.kind,
    path: resolve(root.path),
    required: root.required === true,
    secretBearing: root.secretBearing === true,
  }
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

function parseManifest(value: Buffer): WorkspaceCheckpointManifest {
  const manifest = JSON.parse(value.toString('utf8')) as WorkspaceCheckpointManifest
  if (manifest.version !== 1) throw new Error('Unsupported checkpoint manifest version.')
  if (!manifest.tenantId || !manifest.sessionId || !manifest.checkpointId) {
    throw new Error('Checkpoint manifest is missing ownership metadata.')
  }
  if (!Array.isArray(manifest.entries)) throw new Error('Checkpoint manifest entries are invalid.')
  return manifest
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
  const requireSecretAdapterForSecrets = options.requireSecretAdapterForSecrets !== false
  const secretAdapter = options.secretAdapter || null

  return {
    async saveSessionCheckpoint(input) {
      const tenantId = assertCloudId(input.tenantId, 'tenantId')
      const sessionId = assertCloudId(input.sessionId, 'sessionId')
      const checkpointId = assertCloudId(input.checkpointId || randomUUID(), 'checkpointId')
      const createdAt = (input.now || new Date()).toISOString()
      const manifestKey = sessionCheckpointManifestKey({ tenantId, sessionId, checkpointId })
      const latestKey = sessionCheckpointLatestKey({ tenantId, sessionId })
      const roots = input.roots.map(normalizeRoot)
      const entries: WorkspaceCheckpointEntry[] = []
      const totals = { files: 0, bytes: 0 }

      for (const root of roots) {
        const files = await collectRootFiles(root, { maxFiles, maxBytes }, totals)
        for (const file of files) {
          const body = await readFile(file.absolutePath)
          const fileSecretBearing = root.secretBearing || isRuntimeSnapshotSecretBearingPath(file.absolutePath)
          const context = secretContext({
            tenantId,
            sessionId,
            checkpointId,
            rootId: root.rootId,
            relativePath: file.relativePath,
          })
          if (fileSecretBearing && requireSecretAdapterForSecrets && !secretAdapter) {
            throw new Error('Secret-bearing checkpoint paths require a SecretAdapter.')
          }
          const encrypted = Boolean(fileSecretBearing && secretAdapter)
          const storedBody = encrypted
            ? Buffer.from(secretAdapter!.protect(body.toString('base64'), context), 'utf8')
            : body
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
            contentType: encrypted ? SECRET_CONTENT_TYPE : 'application/octet-stream',
            metadata: {
              tenant: tenantId,
              session: sessionId,
              checkpoint: checkpointId,
              root: root.rootId,
              kind: root.kind,
              sha256: sha256(body),
              secret: String(fileSecretBearing),
              encrypted: String(encrypted),
            },
          })
          entries.push({
            rootId: root.rootId,
            kind: root.kind,
            relativePath: file.relativePath,
            objectKey,
            size: file.size,
            storedSize: stored.size,
            sha256: sha256(body),
            mode: file.mode,
            secretBearing: fileSecretBearing,
            encrypted,
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
          secretBearing: root.secretBearing === true,
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
      const key = input.manifestKey
        ? assertSafeObjectKey(input.manifestKey)
        : input.checkpointId
          ? sessionCheckpointManifestKey({ tenantId, sessionId, checkpointId: input.checkpointId })
          : sessionCheckpointLatestKey({ tenantId, sessionId })
      const object = await options.objectStore.getObject(key)
      if (!object) return null
      const manifest = parseManifest(object.body)
      if (manifest.tenantId !== tenantId || manifest.sessionId !== sessionId) {
        throw new Error('Checkpoint manifest ownership does not match the restore request.')
      }
      return manifest
    },

    async restoreSessionCheckpoint(input) {
      const tenantId = assertCloudId(input.tenantId, 'tenantId')
      const sessionId = assertCloudId(input.sessionId, 'sessionId')
      const manifest = await this.readSessionCheckpoint(input)
      if (!manifest) throw new Error('Checkpoint manifest was not found.')
      const roots = new Map(input.roots.map((root) => [root.rootId, normalizeRoot(root)]))
      let restoredEntries = 0
      for (const entry of manifest.entries) {
        const root = roots.get(entry.rootId)
        if (!root) throw new Error(`No restore root was provided for checkpoint root ${entry.rootId}.`)
        const object = await options.objectStore.getObject(entry.objectKey)
        if (!object) throw new Error(`Checkpoint object is missing: ${entry.objectKey}`)
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
        const digest = sha256(body)
        if (digest !== entry.sha256) {
          throw new Error(`Checkpoint object hash mismatch for ${entry.rootId}/${entry.relativePath}.`)
        }
        const target = resolveInside(root.path, entry.relativePath)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, body, { mode: entry.mode ?? 0o600 })
        restoredEntries += 1
      }
      return {
        manifest,
        restoredEntries,
      }
    },
  }
}
