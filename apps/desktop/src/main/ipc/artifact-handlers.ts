import electron from 'electron'
import { resolve } from 'path'
import { basename, join } from 'path'
import { chmodSync, copyFileSync, existsSync, realpathSync, writeFileSync } from 'fs'
import type {
  SessionArtifact,
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

export function copyArtifactForExport(source: string, destination: string) {
  copyFileSync(source, destination)
  chmodSync(destination, 0o600)
}

function safeRealPath(path: string) {
  try {
    return existsSync(path) ? realpathSync.native(path) : null
  } catch {
    return null
  }
}

function decodeAttachmentDataUrl(url: string) {
  const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(url)
  if (!match) throw new Error('Cloud artifact attachment is not a base64 data URL.')
  return Buffer.from(match[2] || '', 'base64')
}

export function registerArtifactHandlers(context: IpcHandlerContext) {
  const { app, shell } = electron

  registerIpcInvoke(context, 'artifact:list', objectArg<SessionArtifactListRequest>('artifact list request', validateSessionArtifactListRequest), async (event, request): Promise<SessionArtifact[]> => {
    const workspaceId = readWorkspaceIdOption(request)
    if (context.workspaceGateway.isLocalWorkspace(event, workspaceId)) return []
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
      const defaultName = request.suggestedName || basename(request.filePath) || 'artifact'
      const result = await dialog.showSaveDialog({
        title: 'Save Artifact As',
        defaultPath: join(app.getPath('downloads'), defaultName),
      })
      if (result.canceled || !result.filePath) return null
      const attachment = await context.workspaceGateway.readCloudArtifactAttachment(_event, request.sessionId, request.filePath, workspaceId)
      writeFileSync(result.filePath, decodeAttachmentDataUrl(attachment.url))
      chmodSync(result.filePath, 0o600)
      log('artifact', `Exported cloud artifact ${attachment.filename} from ${shortSessionId(request.sessionId)}`)
      return result.filePath
    }

    const { source } = context.resolvePrivateArtifactPath(request)

    const result = await dialog.showSaveDialog({
      title: 'Save Artifact As',
      defaultPath: join(app.getPath('downloads'), request.suggestedName || basename(source)),
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
