import type { IpcHandlerContext } from './context.ts'
import { normalizeSessionId, normalizeSessionTitle } from './session-handler-validation.ts'
import { getBrandName } from '../config-loader.ts'
import { removeParentSession } from '../events.ts'
import { isInternalCoworkMessage } from '../internal-message-utils.ts'
import { log } from '../logger.ts'
import { shortSessionId } from '../log-sanitizer.ts'
import { normalizeSessionInfo, normalizeSessionMessages, normalizeShareUrl } from '../opencode-adapter.ts'
import { clearPermissionsForSession } from '../permission-tracker.ts'
import { getRuntimeHomeDir } from '../runtime.ts'
import { cleanupSandboxWorkspaceForSession } from '../sandbox-storage.ts'
import { mergeSessionDiffsWithSynthetic, normalizeSessionFileDiffs } from '../session-diff-fallback.ts'
import { sessionEngine } from '../session-engine.ts'
import { startSessionStatusReconciliation } from '../session-status-reconciler.ts'
import { getSessionRecord, removeSessionRecord, updateSessionRecord } from '../session-registry.ts'
import { getThreadIndexService } from '../thread-index-service.ts'

export function registerSessionActionHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('session:export', async (_event, sessionId: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      const session = await client.session.get({ sessionID: sessionId })
      const normalizedSession = normalizeSessionInfo(session.data)
      const messagesResult = await client.session.messages({ sessionID: sessionId }, { throwOnError: true })
      const messages = normalizeSessionMessages(messagesResult.data)
      if (!messages) return null

      let markdown = `# ${normalizedSession?.title || 'Thread'}\n\n`
      markdown += `_Exported from ${getBrandName()}_\n\n---\n\n`
      for (const message of messages) {
        let text = ''
        for (const part of message.parts) {
          if (part.type === 'text' && part.text) text += part.text
        }
        if (!text || isInternalCoworkMessage(text)) continue
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

  context.ipcMain.handle('session:share', async (_event, sessionId: string) => {
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

  context.ipcMain.handle('session:unshare', async (_event, sessionId: string) => {
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
  context.ipcMain.handle('session:summarize', async (_event, sessionId: string) => {
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
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false as const, message }
    }
  })

  context.ipcMain.handle('session:revert', async (_event, sessionId: string, messageId?: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      await client.session.revert({
        sessionID: sessionId,
        ...(messageId ? { messageID: messageId } : {}),
      })
      log('session', `Reverted ${shortSessionId(sessionId)}${messageId ? ' to message' : ''}`)
      return true
    } catch (err) {
      context.logHandlerError(`session:revert ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  context.ipcMain.handle('session:unrevert', async (_event, sessionId: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      await client.session.unrevert({ sessionID: sessionId })
      log('session', `Unreverted ${shortSessionId(sessionId)}`)
      return true
    } catch (err) {
      context.logHandlerError(`session:unrevert ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  context.ipcMain.handle('session:children', async (_event, sessionId: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      const result = await client.session.children({ sessionID: sessionId })
      return result.data || []
    } catch (err) {
      context.logHandlerError(`session:children ${shortSessionId(sessionId)}`, err)
      return []
    }
  })

  context.ipcMain.handle('session:diff', async (_event, sessionId: string, messageId?: string) => {
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

  context.ipcMain.handle('session:delete', async (_event, sessionId: string, confirmationToken?: string | null) => {
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
