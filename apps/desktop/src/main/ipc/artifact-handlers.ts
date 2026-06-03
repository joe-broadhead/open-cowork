import electron from 'electron'
import { resolve } from 'path'
import { basename, join } from 'path'
import { chmodSync, copyFileSync, existsSync, realpathSync, writeFileSync } from 'fs'
import type {
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
  validateSessionArtifactExportRequest,
  validateSessionArtifactListRequest,
  validateSessionArtifactRequest,
  validateSessionArtifactUploadRequest,
} from './object-validators.ts'
import { buildArtifactAttachmentPayload } from '../artifact-attachments.ts'
import { getChartArtifactsRoot } from '../chart-artifacts.ts'
import { cleanupSandboxStorage, getSandboxStorageStats } from '../sandbox-storage.ts'
import { shortSessionId } from '../log-sanitizer.ts'
import { log } from '../logger.ts'
import { sessionEngine } from '../session-engine.ts'
import { isReadableSessionArtifact } from '../session-artifact-access.ts'
import { readWorkspaceIdOption } from '../workspace-gateway.ts'

const MAX_CLOUD_ARTIFACT_EXPORT_BYTES = 50 * 1024 * 1024
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

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
  // User-selected cloud artifact export. The bytes are validated as a bounded
  // base64 data URL above and only written after an explicit save dialog.
  // codeql[js/network-data-written-to-file]
  writeFileSync(destination, bytes)
  chmodSync(destination, 0o600)
}

export function registerArtifactHandlers(context: IpcHandlerContext) {
  const { app, shell } = electron

  registerIpcInvoke(context, 'artifact:list', objectArg<SessionArtifactListRequest>('artifact list request', validateSessionArtifactListRequest), async (event, request): Promise<SessionArtifact[]> => {
    const workspaceId = readWorkspaceIdOption(request)
    if (context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      return sessionEngine.getSessionView(request.sessionId)?.artifacts || []
    }
    return context.workspaceGateway.listCloudArtifacts(event, request.sessionId, workspaceId)
  })

  registerIpcInvoke(context, 'artifact:upload', objectArg<SessionArtifactUploadRequest>('artifact upload request', validateSessionArtifactUploadRequest), async (event, request): Promise<SessionArtifact> => {
    const workspaceId = readWorkspaceIdOption(request)
    if (context.workspaceGateway.isLocalWorkspace(event, workspaceId)) {
      throw new Error('Artifact upload is only available for Cloud workspaces.')
    }
    return context.workspaceGateway.uploadCloudArtifact(event, request, workspaceId)
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

    const { source } = context.resolvePrivateArtifactPath(request)

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
    const { source } = context.resolvePrivateArtifactPath(request)
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
    const chartRoot = resolve(getChartArtifactsRoot(request.sessionId))
    const isChartArtifact = root === safeRealPath(chartRoot)
    if (!isChartArtifact && !isReadableSessionArtifact(sessionEngine.getSessionView(request.sessionId), source)) {
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
