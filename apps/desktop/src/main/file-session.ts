import { createHash, randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type FileSessionPurpose =
  | 'semantic-ui'
  | 'support-diagnostics'
  | 'paired-readonly'
  | 'workflow-preview'

export interface FileSessionLimits {
  ttlMs: number
  idleTtlMs?: number
  maxFileCount: number
  maxFileBytes: number
  maxBatchBytes: number
  maxSessionBytes: number
}

export interface FileSessionPolicy {
  workspaceRoot: string
  allowedPaths?: string[]
  denySensitivePaths?: boolean
  limits: FileSessionLimits
}

export interface FileSession {
  id: string
  workspaceId: string
  actorId: string
  purpose: FileSessionPurpose
  createdAt: string
  lastAccessedAt: string
  expiresAt: string
  bytesRead: number
  bytesWritten: number
  policy: FileSessionPolicy
  redacted: true
}

export interface FileSessionCatalogEntry {
  path: string
  type: 'file' | 'directory' | 'denied'
  size: number
  mtimeMs: number | null
  revision: string | null
  redacted: boolean
  reasonCode?: string
}

export interface FileSessionReadResult {
  path: string
  ok: boolean
  content?: string
  size?: number
  revision?: string
  reasonCode?: string
}

export interface FileSessionWriteInput {
  path: string
  content: string
  expectedRevision: string | null
}

export interface FileSessionWriteResult {
  path: string
  ok: boolean
  size?: number
  revision?: string
  reasonCode?: string
}

export type FileSessionAuditEventType =
  | 'file-session.read'
  | 'file-session.read-denied'
  | 'file-session.write'
  | 'file-session.write-denied'
  | 'file-session.expired'

export interface FileSessionAuditEvent {
  id: string
  sessionId: string
  workspaceId: string
  actorId: string
  purpose: FileSessionPurpose
  eventType: FileSessionAuditEventType
  path: string
  bytes?: number
  revision?: string | null
  reasonCode?: string
  timestamp: string
  redacted: true
}

export interface FileSessionWriteBatchResult {
  results: FileSessionWriteResult[]
  auditEvents: FileSessionAuditEvent[]
}

export interface FileSessionReadBatchResult {
  results: FileSessionReadResult[]
  auditEvents: FileSessionAuditEvent[]
}

const DEFAULT_LIMITS: FileSessionLimits = {
  ttlMs: 5 * 60_000,
  idleTtlMs: 60_000,
  maxFileCount: 200,
  maxFileBytes: 256 * 1024,
  maxBatchBytes: 512 * 1024,
  maxSessionBytes: 2 * 1024 * 1024,
}

const SENSITIVE_PATH_PATTERNS = [
  /(^|[/\\])\.env(\.[^/\\]+)?$/i,
  /(^|[/\\])\.ssh([/\\]|$)/i,
  /(^|[/\\])\.aws([/\\]|$)/i,
  /(^|[/\\])\.config[/\\]gh([/\\]|$)/i,
  /(^|[/\\])\.docker[/\\]config\.json$/i,
  /(^|[/\\])credentials?(\.[^/\\]+)?$/i,
  /(^|[/\\])tokens?(\.[^/\\]+)?$/i,
  /(^|[/\\])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|[/\\])keychain([/\\]|$)/i,
]

function nowIso(now = new Date()) {
  return now.toISOString()
}

function normalizeLimits(limits?: Partial<FileSessionLimits>): FileSessionLimits {
  return {
    ...DEFAULT_LIMITS,
    ...(limits || {}),
  }
}

function assertRelativePath(path: string) {
  if (!path || path === '.') return '.'
  if (isAbsolute(path)) throw new Error('File-session paths must be workspace-relative')
  if (path.includes('\0')) throw new Error('File-session paths must not contain null bytes')
  const normalized = path.replace(/\\/g, '/').split('/').filter(Boolean).join('/')
  if (!normalized || normalized === '.') return '.'
  if (normalized.split('/').some((segment) => segment === '..')) {
    throw new Error('File-session paths must not traverse outside the workspace')
  }
  return normalized
}

function inside(root: string, candidate: string) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function revisionForMetadata(size: number, mtimeMs: number) {
  return `sha256:${createHash('sha256').update(`${size}\0${Math.trunc(mtimeMs)}`).digest('hex').slice(0, 32)}`
}

function revisionForContent(content: string | Buffer) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

async function revisionForFile(path: string) {
  return revisionForContent(await readFile(path))
}

function auditPathFor(path: string) {
  if (!path || path.includes('\0') || isAbsolute(path)) return '[invalid-path]'
  const normalized = path.replace(/\\/g, '/').split('/').filter(Boolean).join('/')
  if (!normalized || normalized === '.') return '.'
  if (normalized.split('/').some((segment) => segment === '..')) return '[invalid-path]'
  return normalized.slice(0, 240)
}

function fileSessionReasonCodeForError(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback
  const message = error.message.toLowerCase()
  if (message.includes('relative')) return 'absolute-path-denied'
  if (message.includes('null byte')) return 'invalid-path'
  if (message.includes('traverse') || message.includes('escaped')) return 'path-escape-denied'
  if (message.includes('allowlist')) return 'path-not-allowlisted'
  if (message.includes('symlink')) return 'symlink-denied'
  if (message.includes('parent is not a directory')) return 'parent-not-directory'
  if (message.includes('write path must be a file') || message.includes('not a file')) return 'not-a-file'
  if (message.includes('current file is too large')) return 'current-file-too-large'
  if (message.includes('expired')) return message.includes('idle') ? 'idle-timeout-expired' : 'ttl-expired'
  return fallback
}

function readReasonCodeForError(error: unknown) {
  return fileSessionReasonCodeForError(error, 'file-session-read-denied')
}

function writeReasonCodeForError(error: unknown) {
  return fileSessionReasonCodeForError(error, 'file-session-write-denied')
}

function auditEvent(
  session: FileSession,
  input: {
    eventType: FileSessionAuditEventType
    path: string
    bytes?: number
    revision?: string | null
    reasonCode?: string
    now?: Date
  },
): FileSessionAuditEvent {
  return {
    id: `file-session-audit-${randomUUID()}`,
    sessionId: session.id,
    workspaceId: session.workspaceId,
    actorId: session.actorId,
    purpose: session.purpose,
    eventType: input.eventType,
    path: input.path,
    ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
    ...(input.revision !== undefined ? { revision: input.revision } : {}),
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    timestamp: nowIso(input.now),
    redacted: true,
  }
}

export function isSensitiveFileSessionPath(path: string) {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

export function createFileSession(input: {
  workspaceId: string
  actorId: string
  purpose: FileSessionPurpose
  policy: Omit<FileSessionPolicy, 'limits'> & { limits?: Partial<FileSessionLimits> }
  now?: Date
}): FileSession {
  const created = input.now || new Date()
  const limits = normalizeLimits(input.policy.limits)
  const createdAt = nowIso(created)
  const expiresAt = nowIso(new Date(created.getTime() + limits.ttlMs))
  return {
    id: `file-session-${randomUUID()}`,
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    purpose: input.purpose,
    createdAt,
    lastAccessedAt: createdAt,
    expiresAt,
    bytesRead: 0,
    bytesWritten: 0,
    policy: {
      workspaceRoot: resolve(input.policy.workspaceRoot),
      allowedPaths: (input.policy.allowedPaths || ['.']).map(assertRelativePath),
      denySensitivePaths: input.policy.denySensitivePaths !== false,
      limits,
    },
    redacted: true,
  }
}

function inactiveReason(session: FileSession, now = new Date()) {
  if (new Date(session.expiresAt).getTime() <= now.getTime()) {
    return 'ttl-expired'
  }
  const idleTtlMs = session.policy.limits.idleTtlMs
  if (idleTtlMs && idleTtlMs > 0) {
    const lastAccessedAt = new Date(session.lastAccessedAt || session.createdAt).getTime()
    if (lastAccessedAt + idleTtlMs <= now.getTime()) return 'idle-timeout-expired'
  }
  return null
}

function touchSession(session: FileSession, now = new Date()) {
  session.lastAccessedAt = nowIso(now)
}

function assertActive(session: FileSession, now = new Date()) {
  const reasonCode = inactiveReason(session, now)
  if (reasonCode === 'idle-timeout-expired') throw new Error('File session idle timeout expired')
  if (reasonCode) throw new Error('File session expired')
  touchSession(session, now)
}

function sessionBytes(session: FileSession) {
  return (session.bytesRead || 0) + (session.bytesWritten || 0)
}

async function resolveSessionPath(session: FileSession, relativePath: string) {
  const requested = assertRelativePath(relativePath)
  const workspaceRoot = await realpath(session.policy.workspaceRoot)
  const absolute = resolve(workspaceRoot, requested)
  if (!inside(workspaceRoot, absolute)) throw new Error('File-session path escaped workspace root')

  const allowed = (session.policy.allowedPaths || ['.']).some((allowedPath) => {
    const allowedAbsolute = resolve(workspaceRoot, allowedPath)
    return inside(allowedAbsolute, absolute)
  })
  if (!allowed) throw new Error('File-session path is outside the allowlist')

  const linkStat = await lstat(absolute)
  if (linkStat.isSymbolicLink()) throw new Error('File-session path is a symlink')
  const real = await realpath(absolute)
  if (!inside(workspaceRoot, real)) throw new Error('File-session real path escaped workspace root')
  const safeRelative = relative(workspaceRoot, real).split(sep).join('/') || '.'
  return {
    requested,
    workspaceRoot,
    absolute: real,
    relativePath: safeRelative,
    linkStat,
  }
}

async function resolveWritableSessionPath(session: FileSession, relativePath: string) {
  const requested = assertRelativePath(relativePath)
  if (requested === '.') throw new Error('File-session write path must be a file')

  const workspaceRoot = await realpath(session.policy.workspaceRoot)
  const absolute = resolve(workspaceRoot, requested)
  if (!inside(workspaceRoot, absolute)) throw new Error('File-session path escaped workspace root')

  const allowed = (session.policy.allowedPaths || ['.']).some((allowedPath) => {
    const allowedAbsolute = resolve(workspaceRoot, allowedPath)
    return inside(allowedAbsolute, absolute)
  })
  if (!allowed) throw new Error('File-session path is outside the allowlist')

  const parent = dirname(absolute)
  const parentStat = await lstat(parent)
  if (parentStat.isSymbolicLink()) throw new Error('File-session write parent is a symlink')
  if (!parentStat.isDirectory()) throw new Error('File-session write parent is not a directory')
  const parentReal = await realpath(parent)
  if (!inside(workspaceRoot, parentReal)) throw new Error('File-session write parent escaped workspace root')

  let currentRevision: string | null = null
  try {
    const linkStat = await lstat(absolute)
    if (linkStat.isSymbolicLink()) throw new Error('File-session write path is a symlink')
    if (!linkStat.isFile()) throw new Error('File-session write path is not a file')
    if (linkStat.size > session.policy.limits.maxFileBytes) {
      throw new Error('File-session current file is too large')
    }
    const real = await realpath(absolute)
    if (!inside(workspaceRoot, real)) throw new Error('File-session write real path escaped workspace root')
    currentRevision = await revisionForFile(real)
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT')) {
      throw error
    }
  }

  return {
    requested,
    workspaceRoot,
    absolute,
    relativePath: relative(workspaceRoot, absolute).split(sep).join('/'),
    currentRevision,
  }
}

function denied(path: string, reasonCode: string): FileSessionCatalogEntry {
  return {
    path,
    type: 'denied',
    size: 0,
    mtimeMs: null,
    revision: null,
    redacted: true,
    reasonCode,
  }
}

async function catalogOne(session: FileSession, relativePath: string): Promise<FileSessionCatalogEntry[]> {
  try {
    const resolved = await resolveSessionPath(session, relativePath)
    if (session.policy.denySensitivePaths && isSensitiveFileSessionPath(resolved.relativePath)) {
      return [denied(relativePath, 'sensitive-path-denied')]
    }
    if (resolved.linkStat.isDirectory()) {
      const entries: FileSessionCatalogEntry[] = [{
        path: resolved.relativePath,
        type: 'directory',
        size: 0,
        mtimeMs: resolved.linkStat.mtimeMs,
        revision: revisionForMetadata(0, resolved.linkStat.mtimeMs),
        redacted: false,
      }]
      for (const child of await readdir(resolved.absolute)) {
        if (entries.length >= session.policy.limits.maxFileCount) break
        const childRelative = resolved.relativePath === '.' ? child : `${resolved.relativePath}/${child}`
        entries.push(...await catalogOne(session, childRelative))
      }
      return entries.slice(0, session.policy.limits.maxFileCount)
    }
    if (!resolved.linkStat.isFile()) return [denied(relativePath, 'unsupported-file-type')]
    return [{
      path: resolved.relativePath,
      type: 'file',
      size: resolved.linkStat.size,
      mtimeMs: resolved.linkStat.mtimeMs,
      revision: resolved.linkStat.size <= session.policy.limits.maxFileBytes
        ? await revisionForFile(resolved.absolute)
        : null,
      redacted: false,
      ...(resolved.linkStat.size > session.policy.limits.maxFileBytes ? { reasonCode: 'file-too-large' } : {}),
    }]
  } catch (error) {
    return [denied(relativePath, fileSessionReasonCodeForError(error, 'file-session-path-denied'))]
  }
}

export async function catalogFileSession(session: FileSession, options: { now?: Date } = {}) {
  assertActive(session, options.now)
  const roots = session.policy.allowedPaths || ['.']
  const entries: FileSessionCatalogEntry[] = []
  for (const root of roots) {
    if (entries.length >= session.policy.limits.maxFileCount) break
    entries.push(...await catalogOne(session, root))
  }
  return entries.slice(0, session.policy.limits.maxFileCount)
}

export async function readFileSessionBatch(
  session: FileSession,
  paths: string[],
  options: { now?: Date } = {},
): Promise<FileSessionReadBatchResult> {
  const now = options.now || new Date()
  const inactive = inactiveReason(session, now)
  if (inactive) {
    return {
      results: paths.map((path) => ({ path: auditPathFor(path), ok: false, reasonCode: inactive })),
      auditEvents: paths.map((path) => auditEvent(session, {
        eventType: 'file-session.expired',
        path: auditPathFor(path),
        reasonCode: inactive,
        now,
      })),
    }
  }
  touchSession(session, now)
  if (paths.length > session.policy.limits.maxFileCount) {
    throw new Error('File-session read batch exceeds max file count')
  }

  const results: FileSessionReadResult[] = []
  const auditEvents: FileSessionAuditEvent[] = []
  let batchBytes = 0
  for (const path of paths) {
    let auditPath = auditPathFor(path)
    const deny = (reasonCode: string) => {
      results.push({ path: auditPath, ok: false, reasonCode })
      auditEvents.push(auditEvent(session, {
        eventType: 'file-session.read-denied',
        path: auditPath,
        reasonCode,
        now,
      }))
    }

    try {
      const resolved = await resolveSessionPath(session, path)
      auditPath = resolved.relativePath
      if (session.policy.denySensitivePaths && isSensitiveFileSessionPath(resolved.relativePath)) {
        deny('sensitive-path-denied')
        continue
      }
      const info = await stat(resolved.absolute)
      if (!info.isFile()) {
        deny('not-a-file')
        continue
      }
      if (info.size > session.policy.limits.maxFileBytes) {
        deny('file-too-large')
        continue
      }
      if (batchBytes + info.size > session.policy.limits.maxBatchBytes) {
        deny('batch-too-large')
        continue
      }
      if (sessionBytes(session) + info.size > session.policy.limits.maxSessionBytes) {
        deny('session-byte-limit-exceeded')
        continue
      }
      const content = await readFile(resolved.absolute, 'utf8')
      const bytes = Buffer.byteLength(content)
      batchBytes += bytes
      session.bytesRead = (session.bytesRead || 0) + bytes
      const revision = revisionForContent(content)
      results.push({
        path: resolved.relativePath,
        ok: true,
        content,
        size: info.size,
        revision,
      })
      auditEvents.push(auditEvent(session, {
        eventType: 'file-session.read',
        path: resolved.relativePath,
        bytes,
        revision,
        now,
      }))
    } catch (error) {
      deny(readReasonCodeForError(error))
    }
  }
  return { results, auditEvents }
}

export async function writeFileSessionBatch(
  session: FileSession,
  writes: FileSessionWriteInput[],
  options: { now?: Date } = {},
): Promise<FileSessionWriteBatchResult> {
  const now = options.now || new Date()
  const inactive = inactiveReason(session, now)
  if (inactive) {
    return {
      results: writes.map((write) => ({ path: auditPathFor(write.path), ok: false, reasonCode: inactive })),
      auditEvents: writes.map((write) => auditEvent(session, {
        eventType: 'file-session.expired',
        path: auditPathFor(write.path),
        reasonCode: inactive,
        now,
      })),
    }
  }
  touchSession(session, now)
  if (writes.length > session.policy.limits.maxFileCount) {
    throw new Error('File-session write batch exceeds max file count')
  }

  const results: FileSessionWriteResult[] = []
  const auditEvents: FileSessionAuditEvent[] = []
  let batchBytes = 0

  for (const write of writes) {
    let auditPath = auditPathFor(write.path)
    const deny = (reasonCode: string) => {
      results.push({ path: auditPath, ok: false, reasonCode })
      auditEvents.push(auditEvent(session, {
        eventType: 'file-session.write-denied',
        path: auditPath,
        reasonCode,
        now,
      }))
    }

    try {
      const requested = assertRelativePath(write.path)
      auditPath = auditPathFor(requested)
      if (session.policy.denySensitivePaths && isSensitiveFileSessionPath(requested)) {
        deny('sensitive-path-denied')
        continue
      }

      const resolved = await resolveWritableSessionPath(session, write.path)
      auditPath = resolved.relativePath
      if (session.policy.denySensitivePaths && isSensitiveFileSessionPath(resolved.relativePath)) {
        deny('sensitive-path-denied')
        continue
      }

      const bytes = Buffer.byteLength(write.content, 'utf8')
      if (bytes > session.policy.limits.maxFileBytes) {
        deny('file-too-large')
        continue
      }
      if (batchBytes + bytes > session.policy.limits.maxBatchBytes) {
        deny('batch-too-large')
        continue
      }
      if (sessionBytes(session) + bytes > session.policy.limits.maxSessionBytes) {
        deny('session-byte-limit-exceeded')
        continue
      }
      if (write.expectedRevision !== resolved.currentRevision) {
        deny('stale-revision')
        continue
      }

      const tempPath = join(dirname(resolved.absolute), `.open-cowork-write-${randomUUID()}.tmp`)
      try {
        await writeFile(tempPath, write.content, { mode: 0o600, flag: 'wx' })
        await rename(tempPath, resolved.absolute)
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => {})
        throw error
      }
      const nextInfo = await stat(resolved.absolute)
      const revision = revisionForContent(write.content)
      batchBytes += bytes
      session.bytesWritten = (session.bytesWritten || 0) + bytes
      results.push({
        path: resolved.relativePath,
        ok: true,
        size: nextInfo.size,
        revision,
      })
      auditEvents.push(auditEvent(session, {
        eventType: 'file-session.write',
        path: resolved.relativePath,
        bytes,
        revision,
        now,
      }))
    } catch (error) {
      deny(writeReasonCodeForError(error))
    }
  }

  return { results, auditEvents }
}
