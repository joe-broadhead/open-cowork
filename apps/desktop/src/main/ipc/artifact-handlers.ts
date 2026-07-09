import { sessionEngine } from '@open-cowork/runtime-host/session-engine'
import { listLocalArtifactIndex, listLocalSessionArtifacts, updateLocalArtifactStatus } from '@open-cowork/runtime-host/artifact-index'
import electron from 'electron'
import { resolve } from 'path'
import { basename, join } from 'path'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { isSafeArtifactOpenTarget, shortSessionId } from '@open-cowork/shared'
import type {
  ArtifactIndexPayload,
  ArtifactIndexRequest,
  ArtifactStatusUpdateRequest,
  SessionArtifact,
  SessionArtifactAttachment,
  SessionArtifactExportRequest,
  SessionArtifactListRequest,
  SessionArtifactRequest,
  SessionArtifactUploadRequest,
} from '@open-cowork/shared'
import type { IpcHandlerContext } from './context.ts'
import { noIpcArgs, objectArg, registerIpcInvoke, stringArg } from './schema.ts'
import {
  validateArtifactIndexRequest,
  validateArtifactStatusUpdateRequest,
  validateSessionArtifactExportRequest,
  validateSessionArtifactListRequest,
  validateSessionArtifactRequest,
  validateSessionArtifactUploadRequest,
} from './object-validators.ts'
import { buildArtifactAttachmentPayload, inferArtifactMime } from '../artifact-attachments.ts'
import { getChartArtifactsRoot } from '../chart-artifacts.ts'
import { cleanupSandboxStorage, getSandboxStorageStats } from '../sandbox-storage.ts'
import { log } from '@open-cowork/shared/node'
import { isReadableSessionArtifact } from '../session-artifact-access.ts'
import { readWorkspaceIdOption } from '../workspace-gateway.ts'

const MAX_CLOUD_ARTIFACT_EXPORT_BYTES = 50 * 1024 * 1024
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/
const CLOUD_ARTIFACT_OPEN_TEMP_PREFIX = 'open-cowork-artifact-'
const CLOUD_ARTIFACT_OPEN_TEMP_RETENTION_MS = 24 * 60 * 60 * 1000
const CLOUD_ARTIFACT_OPEN_TEMP_GRACE_MS = 60 * 60 * 1000

export function copyArtifactForExport(source: string, destination: string) {
  copyFileSync(source, destination)
  chmodSync(destination, 0o600)
}

export function safeArtifactExportFilename(input: string | null | undefined) {
  const candidate = basename(input || '').trim()
  if (!candidate || candidate === '.' || candidate === '..') return 'artifact'
  return candidate
}

function safeRealPath(path: string) {
  try {
    return existsSync(path) ? realpathSync.native(path) : null
  } catch {
    return null
  }
}

export function decodeCloudArtifactDataUrl(url: string) {
  const match = /^data:([^,]*);base64,(.*)$/s.exec(url)
  if (!match) throw new Error('Cloud artifact attachment is not a base64 data URL.')
  const dataBase64 = (match[2] || '').replace(/\s+/g, '')
  if (!BASE64_RE.test(dataBase64) || dataBase64.length % 4 === 1) {
    throw new Error('Cloud artifact attachment is not valid base64.')
  }
  const estimatedBytes = Math.floor((dataBase64.length * 3) / 4)
  if (estimatedBytes > MAX_CLOUD_ARTIFACT_EXPORT_BYTES) {
    throw new Error('Cloud artifact exceeds the export size limit.')
  }
  const bytes = Buffer.from(dataBase64, 'base64')
  if (bytes.length > MAX_CLOUD_ARTIFACT_EXPORT_BYTES) {
    throw new Error('Cloud artifact exceeds the export size limit.')
  }
  return bytes
}

export function writeCloudArtifactForExport(destination: string, attachment: Pick<SessionArtifactAttachment, 'url'>) {
  const bytes = decodeCloudArtifactDataUrl(attachment.url)
  // Explicit user artifact export/open. The bytes are validated as a bounded
  // base64 data URL above before being written to a user-selected or temp path.
  // codeql[js/network-data-written-to-file]
  writeFileSync(destination, bytes)
  chmodSync(destination, 0o600)
}

async function openArtifactPath(shell: typeof electron.shell, filePath: string) {
  const error = await shell.openPath(filePath)
  if (error) throw new Error(`Could not open artifact: ${error}`)
  return filePath
}

function assertSafeArtifactOpenTarget(filename: string, mime: string | null | undefined) {
  if (isSafeArtifactOpenTarget({ filename, mime })) return
  throw new Error('This artifact type cannot be opened directly. Export the artifact and inspect it manually.')
}

export function safeArtifactOpenFilename(filename: string | null | undefined, mime: string | null | undefined, fallback: string) {
  const candidate = safeArtifactExportFilename(filename || fallback)
  assertSafeArtifactOpenTarget(candidate, mime)
  return candidate
}

export function cleanupCloudArtifactOpenTempDirs(
  tempRoot: string,
  options: {
    nowMs?: number
    maxAgeMs?: number
  } = {},
) {
  const nowMs = options.nowMs ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? CLOUD_ARTIFACT_OPEN_TEMP_RETENTION_MS
  let removed = 0
  try {
    for (const entry of readdirSync(tempRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(CLOUD_ARTIFACT_OPEN_TEMP_PREFIX)) continue
      const directory = join(tempRoot, entry.name)
      const stats = statSync(directory)
      if (nowMs - stats.mtimeMs < maxAgeMs) continue
      rmSync(directory, { recursive: true, force: true })
      removed += 1
    }
  } catch {
    return removed
  }
  return removed
}

function scheduleCloudArtifactOpenTempCleanup(tempRoot: string) {
  const timer = setTimeout(() => {
    try {
      rmSync(tempRoot, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup; the next startup pass prunes any leftover temp artifacts.
    }
  }, CLOUD_ARTIFACT_OPEN_TEMP_GRACE_MS)
  timer.unref?.()
}

function electronTempPath(app: typeof electron.app | null | undefined) {
  try {
    return app?.getPath('temp') || null
  } catch {
    return null
  }
}

function isAuthorizedLocalArtifact(root: string, source: string, sessionId: string) {
  const chartRoot = resolve(getChartArtifactsRoot(sessionId))
  if (root === safeRealPath(chartRoot)) return true
  return isReadableSessionArtifact(sessionEngine.getSessionView(sessionId), source)
}

export function registerArtifactHandlers(context: IpcHandlerContext) {
  const { app, shell } = electron
  const appTempPath = electronTempPath(app)
  if (appTempPath) {
    const removedOpenTempDirs = cleanupCloudArtifactOpenTempDirs(appTempPath)
    if (removedOpenTempDirs > 0) {
      log('artifact', `Cleaned up ${removedOpenTempDirs} stale cloud artifact open temp director${removedOpenTempDirs === 1 ? 'y' : 'ies'}`)
    }
  }

  registerIpcInvoke(context, 'artifact:list', objectArg<SessionArtifactListRequest>('artifact list request', validateSessionArtifactListRequest), async (event, request): Promise<SessionArtifact[]> => {
    const workspaceId = readWorkspaceIdOption(request)
    if (context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return listLocalSessionArtifacts(request.sessionId, workspaceId)
    }
    return context.workspaceGateway.listCloudArtifacts(event, request.sessionId, workspaceId)
  })

  registerIpcInvoke(context, 'artifact:index', objectArg<ArtifactIndexRequest>('artifact index request', validateArtifactIndexRequest), async (event, request): Promise<ArtifactIndexPayload> => {
    const workspaceId = readWorkspaceIdOption(request)
    if (context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return listLocalArtifactIndex(request)
    }
    return context.workspaceGateway.indexCloudArtifacts(event, request, workspaceId)
  })

  registerIpcInvoke(context, 'artifact:update-status', objectArg<ArtifactStatusUpdateRequest>('artifact status update request', validateArtifactStatusUpdateRequest), async (event, request): Promise<SessionArtifact> => {
    const workspaceId = readWorkspaceIdOption(request)
    if (context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return updateLocalArtifactStatus(request)
    }
    return context.workspaceGateway.updateCloudArtifactStatus(event, request, workspaceId)
  })

  registerIpcInvoke(context, 'artifact:upload', objectArg<SessionArtifactUploadRequest>('artifact upload request', validateSessionArtifactUploadRequest), async (event, request): Promise<SessionArtifact> => {
    const workspaceId = readWorkspaceIdOption(request)
    if (context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      throw new Error('Artifact upload is only available for Cloud workspaces.')
    }
    return context.workspaceGateway.uploadCloudArtifact(event, request, workspaceId)
  })

  registerIpcInvoke(context, 'artifact:open', objectArg<SessionArtifactExportRequest>('artifact open request', validateSessionArtifactExportRequest), async (event, request) => {
    const workspaceId = readWorkspaceIdOption(request)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      const attachment = await context.workspaceGateway.readCloudArtifactAttachment(event, request.sessionId, request.filePath, workspaceId)
      const filename = safeArtifactOpenFilename(attachment.filename, attachment.mime, basename(request.filePath))
      const tempPath = electronTempPath(app)
      if (!tempPath) throw new Error('Artifact open is unavailable because the app temp directory is not ready.')
      const tempRoot = mkdtempSync(join(tempPath, CLOUD_ARTIFACT_OPEN_TEMP_PREFIX))
      const destination = join(tempRoot, filename)
      writeCloudArtifactForExport(destination, attachment)
      scheduleCloudArtifactOpenTempCleanup(tempRoot)
      log('artifact', `Opened cloud artifact ${attachment.filename} from ${shortSessionId(request.sessionId)}`)
      return openArtifactPath(shell, destination)
    }

    const { root, source } = context.resolvePrivateArtifactPath(request)
    safeArtifactOpenFilename(basename(source), inferArtifactMime(source), basename(source))
    if (!isAuthorizedLocalArtifact(root, source, request.sessionId)) {
      throw new Error('Only surfaced session artifacts can be opened directly.')
    }
    log('artifact', `Opened artifact ${basename(source)} from ${shortSessionId(request.sessionId)}`)
    return openArtifactPath(shell, source)
  })

  registerIpcInvoke(context, 'artifact:export', objectArg<SessionArtifactExportRequest>('artifact export request', validateSessionArtifactExportRequest), async (_event, request) => {
    const { dialog } = await import('electron')
    const workspaceId = readWorkspaceIdOption(request)
    if (!context.workspaceGateway.isLocalWorkspace(_event, workspaceId)) {
      const defaultName = safeArtifactExportFilename(request.suggestedName || basename(request.filePath))
      const result = await dialog.showSaveDialog({
        title: 'Save Artifact As',
        defaultPath: join(app.getPath('downloads'), defaultName),
      })
      if (result.canceled || !result.filePath) return null
      const attachment = await context.workspaceGateway.readCloudArtifactAttachment(_event, request.sessionId, request.filePath, workspaceId)
      writeCloudArtifactForExport(result.filePath, attachment)
      log('artifact', `Exported cloud artifact ${attachment.filename} from ${shortSessionId(request.sessionId)}`)
      return result.filePath
    }

    const { root, source } = context.resolvePrivateArtifactPath(request)
    if (!isAuthorizedLocalArtifact(root, source, request.sessionId)) {
      throw new Error('Only surfaced session artifacts can be exported.')
    }

    const result = await dialog.showSaveDialog({
      title: 'Save Artifact As',
      defaultPath: join(app.getPath('downloads'), safeArtifactExportFilename(request.suggestedName || basename(source))),
    })
    if (result.canceled || !result.filePath) return null

    copyArtifactForExport(source, result.filePath)
    log('artifact', `Exported artifact ${basename(source)} from ${shortSessionId(request.sessionId)}`)
    return result.filePath
  })

  registerIpcInvoke(context, 'artifact:reveal', objectArg<SessionArtifactRequest>('artifact request', validateSessionArtifactRequest), async (event, request) => {
    const workspaceId = readWorkspaceIdOption(request)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      throw new Error('Cloud artifacts cannot be revealed in the local filesystem. Export the artifact instead.')
    }
    const { root, source } = context.resolvePrivateArtifactPath(request)
    if (!isAuthorizedLocalArtifact(root, source, request.sessionId)) {
      throw new Error('Only surfaced session artifacts can be revealed.')
    }
    shell.showItemInFolder(source)
    log('artifact', `Revealed artifact ${basename(source)} from ${shortSessionId(request.sessionId)}`)
    return true
  })

  registerIpcInvoke(context, 'artifact:read-attachment', objectArg<SessionArtifactRequest>('artifact request', validateSessionArtifactRequest), async (event, request) => {
    const workspaceId = readWorkspaceIdOption(request)
    if (!context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return context.workspaceGateway.readCloudArtifactAttachment(event, request.sessionId, request.filePath, workspaceId)
    }
    const { root, source } = context.resolvePrivateArtifactPath(request)
    if (!isAuthorizedLocalArtifact(root, source, request.sessionId)) {
      throw new Error('Only surfaced session artifacts can be attached to the thread.')
    }
    return buildArtifactAttachmentPayload(source)
  })

  registerIpcInvoke(context, 'artifact:storage-stats', noIpcArgs, async () => {
    return getSandboxStorageStats()
  })

  registerIpcInvoke(context, 'artifact:cleanup', stringArg('cleanup mode'), async (_event, mode) => {
    if (mode !== 'old-unreferenced' && mode !== 'all-unreferenced') {
      throw new Error('Invalid artifact cleanup mode.')
    }
    const result = cleanupSandboxStorage(mode)
    log('artifact', `Cleanup ${mode}: removed ${result.removedWorkspaces} workspace(s), freed ${result.removedBytes} bytes`)
    return result
  })
}
