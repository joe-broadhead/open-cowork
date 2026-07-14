import { getThreadIndexService } from '@open-cowork/runtime-host/thread-index/thread-index-service'
import { getSessionRecord, removeSessionRecord, updateSessionRecord } from '@open-cowork/runtime-host/session-registry'
import { sessionEngine } from '@open-cowork/runtime-host/session-engine'
import { mergeSessionDiffsWithSynthetic, normalizeSessionFileDiffs } from '@open-cowork/runtime-host/session-diff-fallback'
import { sdkErrorMessage } from '@open-cowork/runtime-host/sdk-error'
import { getRuntimeHomeDir } from '@open-cowork/runtime-host/runtime'
import {
  getNativeSession,
  listNativeSessionMessages,
  listNativeSessions,
  normalizeSessionInfo,
  normalizeSessionMessages,
  normalizeShareUrl,
} from '@open-cowork/runtime-host'
import { shortSessionId } from '@open-cowork/shared'
import type { IpcHandlerContext } from './context.ts'
import { normalizeSessionId, normalizeSessionTitle } from './session-handler-validation.ts'
import { getBrandName } from '@open-cowork/runtime-host/config'
import { removeParentSession } from '../events.ts'
import { log } from '@open-cowork/shared/node'
import { clearPermissionsForSession } from '../permission-tracker.ts'
import { cleanupSandboxWorkspaceForSession } from '../sandbox-storage.ts'
import { startSessionStatusReconciliation } from '../session-status-reconciler.ts'
export function registerSessionActionHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('session:export', async (_event, sessionIdInput: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const { client } = await context.getSessionClient(sessionId)
    try {
      const normalizedSession = normalizeSessionInfo(await getNativeSession(client, sessionId))
      const messages = normalizeSessionMessages(await listNativeSessionMessages(client, sessionId))
      if (!messages) return null

      let markdown = `# ${normalizedSession?.title || 'Thread'}\n\n`
      markdown += `_Exported from ${getBrandName()}_\n\n---\n\n`
      for (const message of messages) {
        let text = ''
        for (const part of message.parts) {
          if (part.type === 'text' && part.text) text += part.text
        }
        if (!text) continue
        markdown += message.role === 'user'
          ? `## User\n\n${text}\n\n`
          : `## Assistant\n\n${text}\n\n`
      }
      return markdown
    } catch (err) {
      context.logHandlerError(`session:export ${shortSessionId(sessionId)}`, err)
      return null
    }
  })

  context.ipcMain.handle('session:share', async (_event, sessionIdInput: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const { client } = await context.getSessionClient(sessionId)
    try {
      const result = await client.session.share({ sessionID: sessionId })
      const url = normalizeShareUrl(result.data)
      log('session', `Shared ${shortSessionId(sessionId)} hasUrl=${!!url}`)
      return url
    } catch (err) {
      context.logHandlerError(`session:share ${shortSessionId(sessionId)}`, err)
      return null
    }
  })

  context.ipcMain.handle('session:unshare', async (_event, sessionIdInput: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const { client } = await context.getSessionClient(sessionId)
    try {
      await client.session.unshare({ sessionID: sessionId })
      log('session', `Unshared ${shortSessionId(sessionId)}`)
      return true
    } catch (err) {
      context.logHandlerError(`session:unshare ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  // Manually trigger OpenCode's session summarizer. Used by the "Summarize
  // now" action in the context panel so a user can pre-empt an imminent
  // auto-compaction (or just trim history proactively). The runtime then
  // emits session.compacted + a CompactionPart which our event handlers
  // render as a CompactionNoticeCard in the timeline.
  context.ipcMain.handle('session:summarize', async (_event, sessionIdInput: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const { client } = await context.getSessionClient(sessionId)
    log('session', `Summarizing ${shortSessionId(sessionId)}`)
    try {
      await client.session.summarize({ sessionID: sessionId }, { throwOnError: true })
      startSessionStatusReconciliation(sessionId, {
        getMainWindow: context.getMainWindow,
        onIdle: (_win, reconciledSessionId) => {
          context.reconcileIdleSession(reconciledSessionId)
        },
      })
      return { ok: true as const }
    } catch (err) {
      context.logHandlerError(`session:summarize ${shortSessionId(sessionId)}`, err)
      const message = sdkErrorMessage(err)
      return { ok: false as const, message }
    }
  })

  context.ipcMain.handle('session:revert', async (_event, sessionIdInput: unknown, messageId?: string) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const { client } = await context.getSessionClient(sessionId)
    try {
      if (!messageId) throw new Error('A message id is required to stage a session revert.')
      await client.v2.session.revert.stage({
        sessionID: sessionId,
        messageID: messageId,
        files: true,
      }, { throwOnError: true })
      log('session', `Reverted ${shortSessionId(sessionId)}${messageId ? ' to message' : ''}`)
      return true
    } catch (err) {
      context.logHandlerError(`session:revert ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  context.ipcMain.handle('session:unrevert', async (_event, sessionIdInput: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const { client } = await context.getSessionClient(sessionId)
    try {
      await client.v2.session.revert.clear({ sessionID: sessionId }, { throwOnError: true })
      log('session', `Unreverted ${shortSessionId(sessionId)}`)
      return true
    } catch (err) {
      context.logHandlerError(`session:unrevert ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  context.ipcMain.handle('session:children', async (_event, sessionIdInput: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const { client } = await context.getSessionClient(sessionId)
    try {
      return (await listNativeSessions(client)).filter((session) => session.parentID === sessionId)
    } catch (err) {
      context.logHandlerError(`session:children ${shortSessionId(sessionId)}`, err)
      return []
    }
  })

  context.ipcMain.handle('session:diff', async (_event, sessionIdInput: unknown, messageId?: string) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const { client } = await context.getSessionClient(sessionId)
    try {
      const result = await client.session.diff({
        sessionID: sessionId,
        ...(messageId ? { messageID: messageId } : {}),
      })
      const diffs = normalizeSessionFileDiffs(result.data || [])
      if (messageId) return diffs

      const record = getSessionRecord(sessionId)
      const view = sessionEngine.getSessionView(sessionId)
      const rootDir = record?.opencodeDirectory || getRuntimeHomeDir()
      return mergeSessionDiffsWithSynthetic(diffs, view, rootDir)
    } catch (err) {
      context.logHandlerError(`session:diff ${shortSessionId(sessionId)}${messageId ? ' message' : ''}`, err)
      return []
    }
  })

  context.ipcMain.handle('session:rename', async (_event, sessionIdInput: unknown, titleInput: unknown) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const title = normalizeSessionTitle(titleInput)
    const { client } = await context.getSessionClient(sessionId)
    try {
      await client.session.update({ sessionID: sessionId, title })
      log('session', `Renamed ${shortSessionId(sessionId)}`)
      const record = updateSessionRecord(sessionId, { title, updatedAt: new Date().toISOString() })
      if (record) getThreadIndexService().upsertThreadFromSessionRecord(record)
      return true
    } catch (err) {
      context.logHandlerError(`session:rename ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  context.ipcMain.handle('session:delete', async (_event, sessionIdInput: unknown, confirmationToken?: string | null) => {
    const sessionId = normalizeSessionId(sessionIdInput)
    const { client } = await context.getSessionClient(sessionId)
    try {
      if (!context.consumeDestructiveConfirmation({ action: 'session.delete', sessionId }, confirmationToken)) {
        throw new Error('Confirmation required before deleting a thread.')
      }
      const record = context.ensureSessionRecord(sessionId)
      await client.session.delete({ sessionID: sessionId })
      clearPermissionsForSession(sessionId)
      removeParentSession(sessionId)
      removeSessionRecord(sessionId)
      getThreadIndexService().removeThread(sessionId)
      const removedWorkspace = cleanupSandboxWorkspaceForSession(record)
      sessionEngine.removeSession(sessionId)
      log('session', `Deleted ${shortSessionId(sessionId)}`)
      if (removedWorkspace) {
        log('artifact', `Removed sandbox workspace for ${shortSessionId(sessionId)}`)
      }
      log('audit', `session.delete completed session=${shortSessionId(sessionId)}`)
      return true
    } catch (err) {
      context.logHandlerError(`session:delete ${shortSessionId(sessionId)}`, err)
      return false
    }
  })
}
