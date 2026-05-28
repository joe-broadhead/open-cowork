import { createHash, randomUUID } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import type {
  CloudProjectSnapshotFile,
  CloudProjectSnapshotUploadInput,
  CloudProjectSnapshotUploadResult,
  CloudProjectSource,
  CloudProjectSourceInput,
  CloudProjectSourcePolicyVerdict,
} from '@open-cowork/shared'
import {
  evaluateCloudProjectSourcePolicy,
  type CloudRuntimePolicy,
} from './cloud-config.ts'
import type { ObjectStoreAdapter } from './object-store.ts'
import type { PathProvider } from './path-provider.ts'
import type { CloudPrincipal } from './session-service.ts'

const execFile = promisify(execFileCallback)
const SNAPSHOT_FORMAT_VERSION = 1
const PROJECT_SOURCE_MARKER = '.open-cowork-project-source.json'

export const SECRET_PROJECT_PATH_REASON = 'secret-bearing file'
export const GENERATED_PROJECT_PATH_REASON = 'dependency or build output'

type StoredSnapshot = {
  version: 1
  snapshotId: string
  createdAt: string
  title: string | null
  fileCount: number
  byteCount: number
  files: CloudProjectSnapshotFile[]
  excluded?: unknown[]
  warnings?: string[]
}

type ProjectRestoreInput = {
  tenantId: string
  sessionId: string
  source: CloudProjectSource
  paths: PathProvider
}

type GitCredential = {
  username: string
  password: string
}

export type CloudProjectSourceService = {
  validateProjectSource(source: CloudProjectSourceInput | null | undefined): CloudProjectSourcePolicyVerdict
  uploadSnapshot(principal: CloudPrincipal, input: CloudProjectSnapshotUploadInput): Promise<CloudProjectSnapshotUploadResult>
  restoreProjectSource(input: ProjectRestoreInput): Promise<{ restored: boolean; workspaceDir: string; reason: string }>
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function safeObjectSegment(value: string, fallback: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '')
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 72) || fallback}-${hash}`
}

function snapshotObjectKey(tenantId: string, snapshotId: string) {
  return [
    'project-snapshots',
    safeObjectSegment(tenantId, 'tenant'),
    safeObjectSegment(snapshotId, 'snapshot'),
    'snapshot.json',
  ].join('/')
}

export function isCloudProjectSnapshotObjectKeyForTenant(tenantId: string, objectKey: string) {
  return objectKey.startsWith(`project-snapshots/${safeObjectSegment(tenantId, 'tenant')}/`)
}

function isSafeRelativePath(path: string) {
  if (!path || path.includes('\0') || path.includes('\\') || isAbsolute(path)) return false
  const parts = path.split('/')
  return !parts.some((part) => !part || part === '.' || part === '..')
}

export function cloudProjectSnapshotPathReason(path: string): string | null {
  if (!isSafeRelativePath(path)) return 'unsafe path'
  const parts = path.toLowerCase().split('/')
  const basename = parts[parts.length - 1] || ''
  if (
    basename === '.env'
    || basename.startsWith('.env.')
    || basename === '.git-credentials'
    || basename === '.npmrc'
    || basename === '.pypirc'
    || basename === '.netrc'
    || basename === 'credentials'
    || basename === 'credentials.json'
    || basename === 'application_default_credentials.json'
    || /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(basename)
    || /\.(pem|key|p12|pfx)$/i.test(basename)
    || parts.includes('.ssh')
    || parts.includes('.aws')
    || parts.includes('.azure')
    || parts.includes('gcloud')
  ) {
    return SECRET_PROJECT_PATH_REASON
  }
  if (
    parts.includes('.git')
    || parts.includes('node_modules')
    || parts.includes('dist')
    || parts.includes('build')
    || parts.includes('.next')
    || parts.includes('.nuxt')
    || parts.includes('coverage')
    || parts.includes('.turbo')
    || parts.includes('.cache')
    || parts.includes('target')
    || parts.includes('vendor')
  ) {
    return GENERATED_PROJECT_PATH_REASON
  }
  return null
}

function sourceFingerprint(source: CloudProjectSource) {
  return createHash('sha256').update(JSON.stringify(source)).digest('hex')
}

async function readMarker(workspaceDir: string) {
  try {
    return asRecord(JSON.parse(await readFile(resolve(workspaceDir, PROJECT_SOURCE_MARKER), 'utf8')))
  } catch {
    return null
  }
}

async function writeMarker(workspaceDir: string, source: CloudProjectSource) {
  await writeFile(resolve(workspaceDir, PROJECT_SOURCE_MARKER), `${JSON.stringify({
    source,
    fingerprint: sourceFingerprint(source),
    restoredAt: new Date().toISOString(),
  }, null, 2)}\n`)
}

function ensureInside(root: string, path: string) {
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, ...path.split('/'))
  const rel = relative(resolvedRoot, target)
  if (rel && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error('Snapshot file path escapes the project workspace.')
  }
  return target
}

function countSnapshot(input: CloudProjectSnapshotUploadInput) {
  let byteCount = 0
  for (const file of input.files) {
    byteCount += Buffer.from(file.dataBase64, 'base64').byteLength
  }
  return {
    fileCount: input.files.length,
    byteCount,
  }
}

function assertSafeSnapshotUpload(input: CloudProjectSnapshotUploadInput, policy: CloudRuntimePolicy) {
  const counts = countSnapshot(input)
  const fileCount = input.fileCount ?? counts.fileCount
  const byteCount = input.byteCount ?? counts.byteCount
  if (fileCount !== counts.fileCount) throw new Error('Snapshot file count does not match uploaded files.')
  if (byteCount !== counts.byteCount) throw new Error('Snapshot byte count does not match uploaded files.')
  if (fileCount > policy.projectSources.uploadedSnapshots.maxFiles) throw new Error('Uploaded snapshot has too many files.')
  if (byteCount > policy.projectSources.uploadedSnapshots.maxBytes) throw new Error('Uploaded snapshot is too large.')
  for (const file of input.files) {
    const reason = cloudProjectSnapshotPathReason(file.path)
    if (reason) throw new Error(`Snapshot includes blocked file "${file.path}" (${reason}).`)
  }
  return counts
}

async function restoreSnapshotFiles(workspaceDir: string, snapshot: StoredSnapshot) {
  for (const file of snapshot.files) {
    const reason = cloudProjectSnapshotPathReason(file.path)
    if (reason) throw new Error(`Stored snapshot includes blocked file "${file.path}" (${reason}).`)
    const target = ensureInside(workspaceDir, file.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, Buffer.from(file.dataBase64, 'base64'))
    if (typeof file.mode === 'number' && Number.isFinite(file.mode)) {
      await chmod(target, file.mode & 0o777).catch(() => undefined)
    }
  }
}

function parseGitCredential(secret: string): GitCredential {
  const trimmed = secret.trim()
  if (!trimmed) throw new Error('Git credential secret is empty.')
  try {
    const parsed = asRecord(JSON.parse(trimmed))
    const username = typeof parsed.username === 'string' && parsed.username.trim()
      ? parsed.username.trim()
      : 'x-access-token'
    const password = typeof parsed.password === 'string' && parsed.password
      ? parsed.password
      : typeof parsed.token === 'string'
        ? parsed.token
        : ''
    if (!password) throw new Error('Git credential JSON must include password or token.')
    return { username, password }
  } catch (error) {
    if (error instanceof SyntaxError) return { username: 'x-access-token', password: trimmed }
    throw error
  }
}

async function createGitCredentialEnv(
  source: CloudProjectSource & { kind: 'git' },
  credentialResolver: ((credentialRef: string) => Promise<string>) | null,
) {
  if (!source.credentialRef?.trim()) return { env: {}, cleanup: async () => undefined }
  if (!credentialResolver) throw new Error('Git credential refs are not configured for this cloud worker.')
  const credential = parseGitCredential(await credentialResolver(source.credentialRef))
  const tempDir = await mkdtemp(join(tmpdir(), 'open-cowork-git-'))
  const usernameFile = join(tempDir, 'username')
  const passwordFile = join(tempDir, 'password')
  const askpassFile = join(tempDir, 'askpass.sh')
  await writeFile(usernameFile, credential.username, { mode: 0o600 })
  await writeFile(passwordFile, credential.password, { mode: 0o600 })
  await writeFile(askpassFile, [
    '#!/bin/sh',
    'case "$1" in',
    '  *Username*) cat "$OPEN_COWORK_GIT_USERNAME_FILE" ;;',
    '  *) cat "$OPEN_COWORK_GIT_PASSWORD_FILE" ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o700 })
  return {
    env: {
      GIT_ASKPASS: askpassFile,
      GIT_TERMINAL_PROMPT: '0',
      OPEN_COWORK_GIT_USERNAME_FILE: usernameFile,
      OPEN_COWORK_GIT_PASSWORD_FILE: passwordFile,
    },
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true })
    },
  }
}

async function restoreGitSource(
  workspaceDir: string,
  source: CloudProjectSource & { kind: 'git' },
  credentialResolver: ((credentialRef: string) => Promise<string>) | null,
) {
  const credentialEnv = await createGitCredentialEnv(source, credentialResolver)
  const env = { ...process.env, ...credentialEnv.env }
  const checkoutDir = source.subdirectory?.trim() ? resolve(workspaceDir, '.open-cowork-git-checkout') : workspaceDir
  try {
    await execFile('git', ['clone', '--no-checkout', '--', source.repositoryUrl, checkoutDir], { env })
    const ref = source.ref?.trim() || 'HEAD'
    await execFile('git', ['-C', checkoutDir, 'checkout', '--force', ref], { env })
    if (source.subdirectory?.trim()) {
      const subdirectory = ensureInside(checkoutDir, source.subdirectory.trim())
      if (!existsSync(subdirectory)) {
        throw new Error(`Git source subdirectory "${source.subdirectory}" was not found after checkout.`)
      }
      await cp(subdirectory, workspaceDir, { recursive: true, force: true })
      await rm(checkoutDir, { recursive: true, force: true })
    }
  } finally {
    await credentialEnv.cleanup()
  }
}

export function createCloudProjectSourceService(input: {
  policy: CloudRuntimePolicy
  objectStore: ObjectStoreAdapter
  credentialResolver?: (credentialRef: string) => Promise<string>
}): CloudProjectSourceService {
  const { policy, objectStore, credentialResolver = null } = input
  return {
    validateProjectSource(source) {
      return evaluateCloudProjectSourcePolicy(source, policy)
    },

    async uploadSnapshot(principal, upload) {
      if (!policy.projectSources.uploadedSnapshots.enabled) {
        throw new Error('Uploaded snapshots are disabled for this cloud profile.')
      }
      const counts = assertSafeSnapshotUpload(upload, policy)
      const snapshotId = randomUUID()
      const createdAt = new Date().toISOString()
      const objectKey = snapshotObjectKey(principal.tenantId, snapshotId)
      const stored: StoredSnapshot = {
        version: SNAPSHOT_FORMAT_VERSION,
        snapshotId,
        createdAt,
        title: upload.title?.trim() || null,
        fileCount: counts.fileCount,
        byteCount: counts.byteCount,
        files: upload.files,
        excluded: upload.excluded || [],
        warnings: upload.warnings || [],
      }
      await objectStore.putObject({
        key: objectKey,
        body: `${JSON.stringify(stored)}\n`,
        contentType: 'application/vnd.open-cowork.project-snapshot+json',
        metadata: {
          tenant: safeObjectSegment(principal.tenantId, 'tenant'),
          snapshot: snapshotId,
        },
      })
      const projectSource = {
        kind: 'snapshot' as const,
        snapshotId,
        objectKey,
        fileCount: counts.fileCount,
        byteCount: counts.byteCount,
        title: stored.title,
      }
      return {
        snapshotId,
        objectKey,
        fileCount: counts.fileCount,
        byteCount: counts.byteCount,
        createdAt,
        projectSource,
      }
    },

    async restoreProjectSource({ tenantId, sessionId, source, paths }) {
      const verdict = evaluateCloudProjectSourcePolicy(source, policy)
      if (!verdict.allowed) {
        throw new Error(verdict.reason || 'Project source is blocked by cloud policy.')
      }
      const workspaceDir = paths.resolveWorkspacePath(tenantId, sessionId)
      const marker = await readMarker(workspaceDir)
      if (marker?.fingerprint === sourceFingerprint(source)) {
        return { restored: false, workspaceDir, reason: 'already-restored' }
      }
      await rm(workspaceDir, { recursive: true, force: true })
      await mkdir(workspaceDir, { recursive: true })
      if (source.kind === 'git') {
        await restoreGitSource(workspaceDir, source, credentialResolver)
      } else {
        if (!isCloudProjectSnapshotObjectKeyForTenant(tenantId, source.objectKey)) {
          throw new Error('Project snapshot does not belong to this tenant.')
        }
        const object = await objectStore.getObject(source.objectKey)
        if (!object) throw new Error('Project snapshot object was not found.')
        const snapshot = JSON.parse(object.body.toString('utf8')) as StoredSnapshot
        if (snapshot.version !== SNAPSHOT_FORMAT_VERSION || snapshot.snapshotId !== source.snapshotId) {
          throw new Error('Project snapshot metadata is invalid.')
        }
        await restoreSnapshotFiles(workspaceDir, snapshot)
      }
      await writeMarker(workspaceDir, source)
      return { restored: true, workspaceDir, reason: source.kind }
    },
  }
}
