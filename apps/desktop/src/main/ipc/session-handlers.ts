import type { IpcHandlerContext } from './context.ts'
import { getEffectiveSettings } from '../settings.ts'
import { getBrandName } from '../config-loader.ts'
import { getClient, getClientForDirectory, getRuntimeHomeDir } from '../runtime.ts'
import { isSandboxWorkspaceDir } from '../runtime-paths.ts'
import { removeParentSession } from '../events.ts'
import { rememberSubmittedPrompt, trackParentSession } from '../event-task-state.ts'
import type { QuestionAnswer } from '@opencode-ai/sdk/v2'
import { dispatchRuntimeSessionEvent, publishSessionView } from '../session-event-dispatcher.ts'
import { sessionEngine } from '../session-engine.ts'
import { startSessionStatusReconciliation, stopSessionStatusReconciliation } from '../session-status-reconciler.ts'
import {
  getSessionRecord,
  listSessionRecords,
  removeSessionRecord,
  toRendererSession,
  toSessionRecord,
  touchSessionRecord,
  updateSessionRecord,
  upsertSessionRecord,
} from '../session-registry.ts'
import { toIsoTimestamp } from '../task-run-utils.ts'
import {
  clearPermission,
  clearPermissionsForSession,
  getPermissionSession,
} from '../permission-tracker.ts'
import { syncSessionView } from '../session-history-loader.ts'
import { normalizeRuntimeCommands, normalizeSessionInfo, normalizeSessionMessages, normalizeShareUrl } from '../opencode-adapter.ts'
import { shortSessionId } from '../log-sanitizer.ts'
import { isInternalCoworkMessage } from '../internal-message-utils.ts'
import { cleanupSandboxWorkspaceForSession } from '../sandbox-storage.ts'
import { log } from '../logger.ts'
import { ensureRuntimeContextDirectory } from '../runtime-context.ts'
import { mergeSessionDiffsWithSynthetic } from '../session-diff-fallback.ts'

export function registerSessionHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('session:create', async (_event, directory?: string) => {
    const opencodeDirectory = context.normalizeDirectory(directory)
    await ensureRuntimeContextDirectory(opencodeDirectory)
    const client = getClientForDirectory(opencodeDirectory)
    if (!client) throw new Error('Runtime not started')
    const settings = getEffectiveSettings()

    log('session', 'Creating new session')
    const result = await client.session.create({}, { throwOnError: true })
    const session = normalizeSessionInfo(result.data)
    if (!session) {
      throw new Error('Runtime returned an invalid session payload')
    }
    log('session', `Created session ${shortSessionId(session.id)}`)
    trackParentSession(session.id)
    const record = upsertSessionRecord(
      toSessionRecord({
        id: session.id,
        title: session.title || 'New session',
        createdAt: toIsoTimestamp(session.time.created),
        updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
        opencodeDirectory,
        providerId: settings.effectiveProviderId || null,
        modelId: settings.effectiveModel || null,
      }),
    )
    return record
      ? toRendererSession(record)
      : {
          id: session.id,
          title: session.title || 'New session',
          directory: opencodeDirectory === getRuntimeHomeDir() || isSandboxWorkspaceDir(opencodeDirectory) ? null : opencodeDirectory,
          createdAt: toIsoTimestamp(session.time.created),
          updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
        }
  })

  context.ipcMain.handle('session:prompt', async (_event, sessionId: string, text: string, attachments?: Array<{ mime: string; url: string; filename?: string }>, agent?: string) => {
    const { client } = await context.getSessionClient(sessionId)
    const requestedAgent = agent || 'build'
    const settings = getEffectiveSettings()
    const parts: Array<
      | { type: 'file'; mime: string; url: string; filename?: string }
      | { type: 'text'; text: string }
    > = []
    if (attachments) {
      for (const attachment of attachments) {
        parts.push({ type: 'file', mime: attachment.mime, url: attachment.url, filename: attachment.filename })
      }
    }
    parts.push({ type: 'text', text })

    trackParentSession(sessionId)
    touchSessionRecord(sessionId)
    updateSessionRecord(sessionId, {
      providerId: settings.effectiveProviderId || null,
      modelId: settings.effectiveModel || null,
      updatedAt: new Date().toISOString(),
    })
    log('prompt', `Sending prompt to ${shortSessionId(sessionId)} attachments=${attachments?.length || 0} agent=${requestedAgent}`)
    try {
      const win = context.getMainWindow()
      // Use a known live-placeholder suffix so the real user message from
      // OpenCode absorbs this optimistic insert via
      // moveLivePlaceholderStateToMessage — otherwise the UI renders two
      // bubbles (the optimistic one and the server-confirmed one).
      const optimisticMessageId = `${sessionId}:user:live`
      const optimisticSegmentId = `${sessionId}:user:segment:live`
      rememberSubmittedPrompt(sessionId, text)
      dispatchRuntimeSessionEvent(win, {
        type: 'text',
        sessionId,
        data: {
          type: 'text',
          role: 'user',
          content: text,
          attachments: attachments || [],
          mode: 'replace',
          messageId: optimisticMessageId,
          partId: optimisticSegmentId,
        },
      })
      dispatchRuntimeSessionEvent(win, {
        type: 'busy',
        sessionId,
        data: { type: 'busy' },
      })

      await client.session.promptAsync({
        sessionID: sessionId,
        parts,
        agent: requestedAgent,
      }, {
        throwOnError: true,
      })

      startSessionStatusReconciliation(sessionId, {
        getMainWindow: context.getMainWindow,
        onIdle: (_win, reconciledSessionId) => {
          context.reconcileIdleSession(reconciledSessionId)
        },
      })
    } catch (err) {
      const win = context.getMainWindow()
      const message = err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : 'Prompt failed'
      dispatchRuntimeSessionEvent(win, {
        type: 'error',
        sessionId,
        data: {
          type: 'error',
          message,
        },
      })
      dispatchRuntimeSessionEvent(win, {
        type: 'done',
        sessionId,
        data: {
          type: 'done',
          synthetic: true,
        },
      })
      context.logHandlerError(`session:prompt ${shortSessionId(sessionId)}`, err)
      throw err
    }
  })

  context.ipcMain.handle('session:activate', async (_event, sessionId: string, options?: { force?: boolean }) => {
    try {
      const view = await syncSessionView(sessionId, {
        force: options?.force,
        activate: true,
      })
      if (view.isGenerating) {
        startSessionStatusReconciliation(sessionId, {
          getMainWindow: context.getMainWindow,
          onIdle: (_win, reconciledSessionId) => {
            context.reconcileIdleSession(reconciledSessionId)
          },
        })
      }
      const win = context.getMainWindow()
      if (win && !win.isDestroyed()) {
        publishSessionView(win, sessionId)
        // Broadcast SDK-owned fields that syncSessionView refreshed (parent,
        // summary, revertedMessageId) so the sidebar/header chips update
        // without waiting for a session.updated SSE event.
        const record = getSessionRecord(sessionId)
        if (record) {
          win.webContents.send('session:updated', {
            id: record.id,
            title: record.title || null,
            parentSessionId: record.parentSessionId,
            changeSummary: record.changeSummary,
            revertedMessageId: record.revertedMessageId,
          })
        }
      }
      return view
    } catch (err) {
      context.logHandlerError(`session:activate ${shortSessionId(sessionId)}`, err)
      throw err
    }
  })

  context.ipcMain.handle('session:list', async () => {
    return listSessionRecords().map(toRendererSession)
  })

  context.ipcMain.handle('session:get', async (_event, id: string) => {
    const record = context.ensureSessionRecord(id)
    if (!record) return null
    try {
      const client = getClientForDirectory(record.opencodeDirectory)
      if (!client) return toRendererSession(record)
      const result = await client.session.get({ sessionID: id })
      const session = normalizeSessionInfo(result.data)
      if (!session) return null
      const updated = updateSessionRecord(id, {
        title: session.title || undefined,
        updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
        parentSessionId: session.parentID || record.parentSessionId || null,
        changeSummary: session.summary,
        revertedMessageId: session.revertedMessageId,
      })
      return updated ? toRendererSession(updated) : toRendererSession(record)
    } catch (err) {
      context.logHandlerError(`session:get ${shortSessionId(id)}`, err)
      return null
    }
  })

  context.ipcMain.handle('session:abort', async (_event, sessionId: string) => {
    const { client } = await context.getSessionClient(sessionId)
    log('session', `Aborting ${shortSessionId(sessionId)}`)
    stopSessionStatusReconciliation(sessionId)
    const win = context.getMainWindow()
    if (win && !win.isDestroyed()) {
      dispatchRuntimeSessionEvent(win, {
        type: 'done',
        sessionId,
        data: {
          type: 'done',
          synthetic: true,
        },
      })
    }
    try {
      await client.session.abort({ sessionID: sessionId })
    } catch (err) {
      context.logHandlerError(`session:abort ${shortSessionId(sessionId)}`, err)
    }
  })

  // Abort just one sub-agent's child session while leaving its siblings
  // (and the primary orchestrator) running. Child sessions aren't in the
  // local registry, so we can't go through `getSessionClient(childId)` —
  // instead we resolve the directory via the parent/root session record
  // and reuse its client to issue the abort against the child id.
  context.ipcMain.handle('session:abort-task', async (
    _event,
    rootSessionId: string,
    childSessionId: string,
  ) => {
    const { client } = await context.getSessionClient(rootSessionId)
    log('session', `Aborting task ${shortSessionId(childSessionId)} under ${shortSessionId(rootSessionId)}`)
    try {
      await client.session.abort({ sessionID: childSessionId })
    } catch (err) {
      context.logHandlerError(
        `session:abort-task ${shortSessionId(childSessionId)} (root ${shortSessionId(rootSessionId)})`,
        err,
      )
    }
  })

  context.ipcMain.handle('session:fork', async (_event, sessionId: string, messageId?: string) => {
    const { client, record } = await context.getSessionClient(sessionId)
    try {
      const result = await client.session.fork({
        sessionID: sessionId,
        ...(messageId ? { messageID: messageId } : {}),
      })
      const session = normalizeSessionInfo(result.data)
      if (!session) return null
      log('session', `Forked ${shortSessionId(sessionId)} -> ${shortSessionId(session.id)}${messageId ? ' at message' : ''}`)
      trackParentSession(session.id)
      const settings = getEffectiveSettings()
      const forked = upsertSessionRecord(
        toSessionRecord({
          id: session.id,
          title: session.title || 'Forked thread',
          createdAt: toIsoTimestamp(session.time.created),
          updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
          opencodeDirectory: record?.opencodeDirectory || getRuntimeHomeDir(),
          providerId: record?.providerId || settings.effectiveProviderId || null,
          modelId: record?.modelId || settings.effectiveModel || null,
          parentSessionId: session.parentID || sessionId,
          changeSummary: session.summary,
          revertedMessageId: session.revertedMessageId,
        }),
      )
      return forked
        ? toRendererSession(forked)
        : {
            id: session.id,
            title: session.title || 'Forked thread',
            directory: record?.directory || null,
            createdAt: toIsoTimestamp(session.time.created),
            updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
            parentSessionId: session.parentID || sessionId,
            changeSummary: session.summary,
            revertedMessageId: session.revertedMessageId,
          }
    } catch (err) {
      context.logHandlerError(`session:fork ${shortSessionId(sessionId)}`, err)
      return null
    }
  })

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
      const diffs = result.data || []
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

  // File-snippet reader used by the diff viewer's "Show N unchanged
  // lines" affordance. Reads a byte range from a file that must live
  // under the session's working directory — rejects any path that
  // tries to escape via `..`, absolute prefixes, or pointing outside
  // the session directory. Returns a string[] keyed by 1-based line
  // numbers so the caller can render the unchanged context inline.
  context.ipcMain.handle('session:file-snippet', async (
    _event,
    request: { sessionId: string; filePath: string; startLine: number; endLine: number },
  ) => {
    const { sessionId, filePath, startLine, endLine } = request
    const record = getSessionRecord(sessionId)
    if (!record) throw new Error(`Unknown ${getBrandName()} session: ${sessionId}`)

    const root = record.opencodeDirectory || getRuntimeHomeDir()
    const { resolve } = await import('path')
    const { existsSync, readFileSync, realpathSync, statSync } = await import('fs')

    const absoluteRoot = resolve(root)
    const absolutePath = resolve(absoluteRoot, filePath)
    // Existence check before realpath so symlink-to-nowhere fails
    // cleanly with a typed error instead of a raw ENOENT from
    // realpathSync.
    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      throw new Error('File is not available for snippet read.')
    }
    // Dereference symlinks on BOTH sides. Prefix-matching the
    // un-resolved path lets a symlink inside the project dir (e.g.
    // `link -> /etc/passwd`) bypass the containment check; realpath
    // collapses the symlink so the prefix check is semantically
    // meaningful.
    const realRoot = realpathSync.native(absoluteRoot)
    const realPath = realpathSync.native(absolutePath)
    if (!(realPath === realRoot || realPath.startsWith(`${realRoot}/`))) {
      throw new Error('File snippet path escapes the session directory.')
    }

    // Cap the range so a pathological request (huge file, wide gap)
    // doesn't paste thousands of lines into the viewer. 500 is plenty
    // of headroom for normal collapsed-context expansion.
    const MAX_LINES = 500
    const safeStart = Math.max(1, Math.floor(startLine))
    const safeEnd = Math.max(safeStart, Math.min(Math.floor(endLine), safeStart + MAX_LINES - 1))

    // Read from the resolved-real path so a symlink target swap
    // between our check and the read can't smuggle a different file
    // through. realPath was validated to live inside realRoot above.
    const contents = readFileSync(realPath, 'utf-8')
    const lines = contents.split('\n')
    return lines.slice(safeStart - 1, safeEnd)
  })

  context.ipcMain.handle('command:list', async () => {
    const client = getClient()
    if (!client) return []
    try {
      const result = await client.command.list()
      return normalizeRuntimeCommands(result.data)
    } catch (err) {
      context.logHandlerError('command:list', err)
      return []
    }
  })

  context.ipcMain.handle('command:run', async (_event, sessionId: string, commandName: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      trackParentSession(sessionId)
      await client.session.command({ sessionID: sessionId, command: commandName })
      touchSessionRecord(sessionId)
      return true
    } catch (err) {
      context.logHandlerError(`command:run ${shortSessionId(sessionId)}:${commandName}`, err)
      return false
    }
  })

  context.ipcMain.handle('session:rename', async (_event, sessionId: string, title: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      await client.session.update({ sessionID: sessionId, title })
      log('session', `Renamed ${shortSessionId(sessionId)}`)
      updateSessionRecord(sessionId, { title, updatedAt: new Date().toISOString() })
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

  context.ipcMain.handle('permission:respond', async (_event, permissionId: string, allowed: boolean) => {
    const sessionId = getPermissionSession(permissionId)
    if (!sessionId) throw new Error(`No session for permission ${permissionId}`)
    const { client } = await context.getSessionV2Client(sessionId)

    log('permission', `${allowed ? 'Approved' : 'Denied'} ${permissionId}`)
    await client.permission.reply({
      requestID: permissionId,
      reply: allowed ? 'once' : 'reject',
    }, {
      throwOnError: true,
    })
    clearPermission(permissionId)
    const resolvedSessionId = sessionEngine.resolveApproval(permissionId)
    const win = context.getMainWindow()
    if (resolvedSessionId && win && !win.isDestroyed()) {
      dispatchRuntimeSessionEvent(win, {
        type: 'approval_resolved',
        sessionId: resolvedSessionId,
        data: { type: 'approval_resolved', id: permissionId },
      })
    }
  })

  context.ipcMain.handle('question:reply', async (_event, sessionId: string, requestId: string, answers: string[][]) => {
    const { client } = await context.getSessionV2Client(sessionId)
    await client.question.reply({
      requestID: requestId,
      answers: answers as QuestionAnswer[],
    }, { throwOnError: true })
    startSessionStatusReconciliation(sessionId, {
      getMainWindow: context.getMainWindow,
      onIdle: (_win, reconciledSessionId) => {
        context.reconcileIdleSession(reconciledSessionId)
      },
    })
  })

  context.ipcMain.handle('question:reject', async (_event, sessionId: string, requestId: string) => {
    const { client } = await context.getSessionV2Client(sessionId)
    await client.question.reject({
      requestID: requestId,
    }, { throwOnError: true })
    startSessionStatusReconciliation(sessionId, {
      getMainWindow: context.getMainWindow,
      onIdle: (_win, reconciledSessionId) => {
        context.reconcileIdleSession(reconciledSessionId)
      },
    })
  })

  ipcCommandAndTodoHandlers(context)
}

function ipcCommandAndTodoHandlers(context: IpcHandlerContext) {
  context.ipcMain.handle('session:todo', async (_event, sessionId: string) => {
    const { client } = await context.getSessionClient(sessionId)
    try {
      const result = await client.session.todo({ sessionID: sessionId })
      return result.data || []
    } catch (err) {
      context.logHandlerError(`session:todo ${shortSessionId(sessionId)}`, err)
      return []
    }
  })
}
