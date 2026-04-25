import electron from 'electron'
import { resolve } from 'path'
import { basename, join } from 'path'
import { chmodSync, copyFileSync } from 'fs'
import type { SessionArtifactExportRequest, SessionArtifactRequest } from '@open-cowork/shared'
import type { IpcHandlerContext } from './context.ts'
import { buildArtifactAttachmentPayload } from '../artifact-attachments.ts'
import { getChartArtifactsRoot } from '../chart-artifacts.ts'
import { cleanupSandboxStorage, getSandboxStorageStats } from '../sandbox-storage.ts'
import { shortSessionId } from '../log-sanitizer.ts'
import { log } from '../logger.ts'
import { sessionEngine } from '../session-engine.ts'
import { isReadableSessionArtifact } from '../session-artifact-access.ts'

export function copyArtifactForExport(source: string, destination: string) {
  copyFileSync(source, destination)
  chmodSync(destination, 0o600)
}

export function registerArtifactHandlers(context: IpcHandlerContext) {
  const { app, shell } = electron

  context.ipcMain.handle('artifact:export', async (_event, request: SessionArtifactExportRequest) => {
    const { dialog } = await import('electron')
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

  context.ipcMain.handle('artifact:reveal', async (_event, request: SessionArtifactRequest) => {
    const { source } = context.resolvePrivateArtifactPath(request)
    shell.showItemInFolder(source)
    log('artifact', `Revealed artifact ${basename(source)} from ${shortSessionId(request.sessionId)}`)
    return true
  })

  context.ipcMain.handle('artifact:read-attachment', async (_event, request: SessionArtifactRequest) => {
    const { root, source } = context.resolvePrivateArtifactPath(request)
    const chartRoot = resolve(getChartArtifactsRoot(request.sessionId))
    if (root !== chartRoot && !isReadableSessionArtifact(sessionEngine.getSessionView(request.sessionId), source)) {
      throw new Error('Only surfaced session artifacts can be attached to the thread.')
    }
    return buildArtifactAttachmentPayload(source)
  })

  context.ipcMain.handle('artifact:storage-stats', async () => {
    return getSandboxStorageStats()
  })

  context.ipcMain.handle('artifact:cleanup', async (_event, mode: 'old-unreferenced' | 'all-unreferenced') => {
    const result = cleanupSandboxStorage(mode)
    log('artifact', `Cleanup ${mode}: removed ${result.removedWorkspaces} workspace(s), freed ${result.removedBytes} bytes`)
    return result
  })
}
