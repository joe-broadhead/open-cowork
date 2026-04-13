import type { IpcMain, BrowserWindow } from 'electron'
import { readFileSync, existsSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { app } from 'electron'
import { getClient, getClientForDirectory, getModelInfo, getRuntimeHomeDir } from './runtime'
import { getEffectiveSettings, saveSettings, loadSettings, isSetupComplete, type CoworkSettings, type CustomAgent, type CustomMcp, type CustomSkill } from './settings'
import { getAuthState, loginWithGoogle, getCachedAccessToken } from './auth'
import { getInstalledPlugins, installPlugin, uninstallPlugin } from './plugin-manager'
import { log } from './logger'
import { trackParentSession, removeParentSession } from './events'
import { resolveDisplayCost } from './pricing'
import { shortSessionId } from './log-sanitizer'
import { isInternalCoworkMessage, isDeterministicTeamCandidate } from './team-orchestration-utils'
import { runDeterministicTeamOrchestration } from './team-orchestration'
import { getCustomAgentCatalog, getCustomAgentSummaries, normalizeCustomAgent, validateCustomAgent } from './custom-agents'
import { listBuiltInAgentDetails } from './agent-config'
import { normalizeProviderListResponse } from './provider-utils'
import {
  getSessionRecord,
  listSessionRecords,
  removeSessionRecord,
  toRendererSession,
  toSessionRecord,
  touchSessionRecord,
  updateSessionRecord,
  upsertSessionRecord,
} from './session-registry'
import {
  chooseTaskTitle,
  extractAgentName,
  isPlaceholderTaskTitle,
  normalizeAgentName,
  toIsoTimestamp,
} from './task-run-utils'
import { getPublicAppConfig } from './config-loader'

export function setupIpcHandlers(ipcMain: IpcMain, getMainWindow: () => BrowserWindow | null) {
  function findBundledSkillFile(root: string, skillName: string) {
    const direct = join(root, skillName, 'SKILL.md')
    if (existsSync(direct)) return direct
    if (!existsSync(root)) return null

    const queue = [root]
    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) continue

      for (const entry of readdirSync(current)) {
        const candidate = join(current, entry)
        let stats
        try {
          stats = statSync(candidate)
        } catch {
          continue
        }
        if (!stats.isDirectory()) continue
        if (entry === skillName) {
          const skillFile = join(candidate, 'SKILL.md')
          if (existsSync(skillFile)) return skillFile
        }
        queue.push(candidate)
      }
    }

    return null
  }

  function normalizeDirectory(directory?: string | null) {
    return directory ? resolve(directory) : getRuntimeHomeDir()
  }

  function ensureSessionRecord(sessionId: string) {
    return getSessionRecord(sessionId)
  }

  function logHandlerError(handler: string, err: unknown) {
    const message = err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : JSON.stringify(err)
    log('error', `${handler} failed: ${message}`)
  }

  async function getSessionClient(sessionId: string) {
    const record = ensureSessionRecord(sessionId)
    if (!record) {
      throw new Error(`Unknown Open Cowork session: ${sessionId}`)
    }
    const client = getClientForDirectory(record?.opencodeDirectory || getRuntimeHomeDir())
    if (!client) throw new Error('Runtime not started')
    return { client, record }
  }

  // Auth handlers
  ipcMain.handle('auth:status', async () => {
    return getAuthState()
  })

  ipcMain.handle('auth:login', async () => {
    log('auth', 'User initiated login')
    const state = await loginWithGoogle()
    if (state.authenticated && isSetupComplete()) {
      log('auth', 'Login completed')
      const token = getCachedAccessToken()
      if (token) process.env.GOOGLE_WORKSPACE_CLI_TOKEN = token
      const { bootRuntime } = await import('./index')
      await bootRuntime()
    }
    return state
  })

  ipcMain.handle('app:config', async () => {
    return getPublicAppConfig()
  })

  ipcMain.handle('settings:get', async () => {
    return getEffectiveSettings()
  })

  ipcMain.handle('settings:set', async (_event, updates: Partial<CoworkSettings>) => {
    const result = saveSettings(updates)
    const runtimeSensitiveUpdate = Boolean(
      updates.selectedProviderId !== undefined
      || updates.selectedModelId !== undefined
      || updates.providerCredentials !== undefined
      || updates.integrationCredentials !== undefined
      || updates.enableBash !== undefined
      || updates.enableFileWrite !== undefined,
    )

    if (isSetupComplete(result)) {
      const activeClient = getClient()
      if (activeClient && runtimeSensitiveUpdate) {
        const { rebootRuntime } = await import('./index')
        await rebootRuntime()
      } else if (!activeClient) {
        const { bootRuntime } = await import('./index')
        await bootRuntime()
      }
    }

    return result
  })

  ipcMain.handle('model:info', async () => {
    return getModelInfo()
  })

  ipcMain.handle('provider:list', async () => {
    const client = getClient()
    if (!client) return []
    try {
      const result = await client.provider.list()
      const raw = result.data as any
      const data = normalizeProviderListResponse(raw)
      log('provider', `Listed ${data.length} providers: ${data.map((p: any) => `${p.id || p.name}(${Object.keys(p.models || {}).length} models)`).join(', ')}`)
      return data
    } catch (err: any) {
      log('error', `Provider list failed: ${err?.message}`)
      return []
    }
  })

  ipcMain.handle('session:create', async (_event, directory?: string) => {
    const opencodeDirectory = normalizeDirectory(directory)
    const client = getClientForDirectory(opencodeDirectory)
    if (!client) throw new Error('Runtime not started')

    log('session', 'Creating new session')
    const result = await client.session.create({
      throwOnError: true,
    })
    const session = result.data as any
    log('session', `Created session ${shortSessionId(session.id)}`)
    trackParentSession(session.id)
    const record = upsertSessionRecord(
      toSessionRecord({
        id: session.id,
        title: session.title || 'New session',
        createdAt: toIsoTimestamp(session.time?.created),
        updatedAt: toIsoTimestamp(session.time?.updated || session.time?.created),
        opencodeDirectory,
      }),
    )
    return record
      ? toRendererSession(record)
      : {
          id: session.id,
          title: session.title || 'New session',
          directory: opencodeDirectory === getRuntimeHomeDir() ? null : opencodeDirectory,
          createdAt: toIsoTimestamp(session.time?.created),
          updatedAt: toIsoTimestamp(session.time?.updated || session.time?.created),
        }
  })

  ipcMain.handle('dialog:select-directory', async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Project Directory',
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('session:prompt', async (_event, sessionId: string, text: string, attachments?: Array<{ mime: string; url: string; filename?: string }>, agent?: string) => {
    const { client } = await getSessionClient(sessionId)
    const requestedAgent = agent || 'assistant'
    const parts: any[] = []
    if (attachments) {
      for (const a of attachments) {
        parts.push({ type: 'file', mime: a.mime, url: a.url, filename: a.filename })
      }
    }
    parts.push({ type: 'text', text })

    trackParentSession(sessionId)
    touchSessionRecord(sessionId)
    log('prompt', `Sending prompt to ${shortSessionId(sessionId)} attachments=${attachments?.length || 0} agent=${requestedAgent}`)
    try {
      if (isDeterministicTeamCandidate(requestedAgent, text, attachments)) {
        const orchestrated = await runDeterministicTeamOrchestration({
          client,
          sessionId,
          text,
          requestedAgent,
          getMainWindow,
        })
        if (orchestrated) return
      }

      await client.session.promptAsync({
        throwOnError: true,
        path: { id: sessionId },
        body: { parts, agent: requestedAgent },
      })
    } catch (err) {
      logHandlerError(`session:prompt ${shortSessionId(sessionId)}`, err)
      throw err
    }
  })

  ipcMain.handle('session:list', async () => {
    return listSessionRecords().map(toRendererSession)
  })

  ipcMain.handle('session:get', async (_event, id: string) => {
    const record = ensureSessionRecord(id)
    if (!record) return null
    try {
      const client = getClientForDirectory(record.opencodeDirectory)
      if (!client) return toRendererSession(record)
      const result = await client.session.get({ path: { id } })
      const s = result.data as any
      if (!s) return null
      const updated = updateSessionRecord(id, {
        title: s.title,
        updatedAt: toIsoTimestamp(s.time?.updated || s.time?.created),
      })
      return updated ? toRendererSession(updated) : toRendererSession(record)
    } catch (err) {
      logHandlerError(`session:get ${shortSessionId(id)}`, err)
      return null
    }
  })

  // Load messages for a session (for history)
  ipcMain.handle('session:messages', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)

    try {
      const [rootMessagesResult, rootTodosResult, childrenResult, statusResult] = await Promise.all([
        client.session.messages({
          throwOnError: true,
          path: { id: sessionId },
        }),
        client.session.todo({ path: { id: sessionId } }).catch((err) => {
          logHandlerError(`session:messages todo ${shortSessionId(sessionId)}`, err)
          return { data: [] }
        }),
        client.session.children({ path: { id: sessionId } }).catch((err) => {
          logHandlerError(`session:messages children ${shortSessionId(sessionId)}`, err)
          return { data: [] }
        }),
        client.session.status().catch((err) => {
          logHandlerError(`session:messages status ${shortSessionId(sessionId)}`, err)
          return { data: {} }
        }),
      ])

      const rootMessages = (rootMessagesResult.data as any[]) || []
      const rootTodos = ((rootTodosResult as any)?.data as any[]) || []
      const children = ((childrenResult as any)?.data as any[] || [])
        .sort((a, b) => (a?.time?.created || 0) - (b?.time?.created || 0))
      const statuses = ((statusResult as any)?.data as Record<string, any>) || {}
      const cachedModelId = getEffectiveSettings().effectiveModel || loadSettings().selectedModelId || ''
      const rootStatus = statuses[sessionId]?.type || null
      const childCompletesById = new Map<string, boolean>()

      let sequence = 0
      const nextOrder = () => ++sequence
      const out: any[] = []
      const taskRunItems = new Map<string, any>()
      const childByTaskId = new Map<string, any>()
      let childIndex = 0

      const createCostPayload = (part: any) => {
        const tokens = part.tokens || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        const cost = resolveDisplayCost(cachedModelId, part.cost, tokens)
        return {
          cost,
          tokens: {
            input: tokens.input || 0,
            output: tokens.output || 0,
            reasoning: tokens.reasoning || 0,
            cache: { read: tokens.cache?.read || 0, write: tokens.cache?.write || 0 },
          },
        }
      }

      const getTaskStatus = (childId?: string | null) => {
        if (!childId) return 'queued'
        const status = statuses[childId]?.type
        const isTerminal = childCompletesById.get(childId)
        if (status === 'busy') return 'running'
        if (status === 'idle') return isTerminal ? 'complete' : (rootStatus === 'busy' ? 'running' : 'queued')
        if (isTerminal) return 'complete'
        if (rootStatus === 'busy') return 'running'
        if (rootStatus === 'idle') return 'complete'
        return 'queued'
      }

      const addTaskRun = (taskRun: {
        id: string
        title: string
        agent: string | null
        status: string
        sourceSessionId: string | null
      }, timestamp: string) => {
        const item = {
          type: 'task_run',
          id: taskRun.id,
          timestamp,
          sequence: nextOrder(),
          taskRun,
        }
        out.push(item)
        taskRunItems.set(taskRun.id, item)
        return item
      }

      const addRootMessageParts = (messages: any[]) => {
        for (const msg of messages) {
          const info = (msg as any).info || msg
          const parts = (msg as any).parts || []
          const ts = toIsoTimestamp(info.time?.created || msg.time?.created)
          const msgId = info.id || msg.id || crypto.randomUUID()
          const role = info.role || msg.role || 'assistant'
          const textParts = parts.filter((part: any) => part.type === 'text' && typeof part.text === 'string' && part.text.length > 0)
          const fullText = textParts.map((part: any) => part.text).join('')

          if (fullText && !isInternalCoworkMessage(fullText)) {
            textParts.forEach((part: any, index: number) => {
              const partId = part.id || `${msgId}:part:${index}`
              out.push({
                type: 'message',
                id: `${msgId}:${partId}:text`,
                messageId: msgId,
                partId,
                role,
                content: part.text,
                timestamp: ts,
                sequence: nextOrder(),
              })
            })
          }

          for (const part of parts) {
            if (part.type === 'subtask') {
              const child = children[childIndex++] || null
              const taskId = child?.id
                ? `child:${child.id}`
                : `pending:${part.id || crypto.randomUUID()}`
              const taskItem = addTaskRun({
                id: taskId,
                title: chooseTaskTitle(
                  normalizeAgentName(part.agent) || extractAgentName(part.description, (part as any).title, (part as any).prompt, (part as any).raw, child?.title) || null,
                  part.description,
                  (part as any).title,
                  (part as any).prompt,
                  (part as any).raw,
                  child?.title,
                ),
                agent: normalizeAgentName(part.agent) || extractAgentName(part.description, (part as any).title, (part as any).prompt, (part as any).raw, child?.title) || null,
                status: getTaskStatus(child?.id || null),
                sourceSessionId: child?.id || null,
              }, ts)
              if (child) {
                childByTaskId.set(taskId, child)
              }
              continue
            }

            if (part.type === 'compaction') {
              out.push({
                type: 'compaction',
                id: part.id || crypto.randomUUID(),
                timestamp: ts,
                sequence: nextOrder(),
                compaction: {
                  status: 'compacted',
                  auto: !!part.auto,
                  overflow: !!part.overflow,
                  sourceSessionId: sessionId,
                },
              })
              continue
            }

            if (part.type === 'tool' && part.tool && part.tool !== 'task') {
              const state = part.state || {}
              const title = part.title || ''
              const toolOutput = state.output
              if (part.tool.includes('charts')) {
                log('session', `Loading chart tool: ${part.tool} hasOutput=${!!toolOutput} outputType=${typeof toolOutput}`)
              }
              out.push({
                type: 'tool',
                id: part.callID || part.id || crypto.randomUUID(),
                timestamp: ts,
                sequence: nextOrder(),
                tool: {
                  name: part.tool === 'task' && title ? title : part.tool,
                  input: state.input || {},
                  status: toolOutput ? 'complete' : state.error ? 'error' : 'complete',
                  output: toolOutput,
                  agent: (state.metadata?.agent || part.metadata?.agent || null),
                },
              })
            }

            if (part.type === 'step-finish' && (part.cost || part.tokens)) {
              out.push({
                type: 'cost',
                id: part.id || crypto.randomUUID(),
                timestamp: ts,
                sequence: nextOrder(),
                cost: createCostPayload(part),
              })
            }
          }
        }
      }

      addRootMessageParts(rootMessages)

      if (rootTodos.length > 0) {
        out.push({
          type: 'todos',
          id: `todos:${sessionId}`,
          timestamp: toIsoTimestamp(Date.now()),
          sequence: nextOrder(),
          todos: rootTodos,
        })
      }

      for (const child of children.slice(childIndex)) {
        const taskId = `child:${child.id}`
        const agent = extractAgentName(child.title)
        addTaskRun({
          id: taskId,
          title: chooseTaskTitle(agent, child.title),
          agent,
          status: getTaskStatus(child.id),
          sourceSessionId: child.id,
        }, toIsoTimestamp(child.time?.created))
        childByTaskId.set(taskId, child)
      }

      for (const [taskId, child] of childByTaskId.entries()) {
        const [result, childTodoResult] = await Promise.all([
          client.session.messages({
            throwOnError: true,
            path: { id: child.id },
          }),
          client.session.todo({ path: { id: child.id } }).catch((err) => {
            logHandlerError(`session:messages child todo ${shortSessionId(child.id)}`, err)
            return { data: [] }
          }),
        ])
        const childMessages = (result.data as any[]) || []
        const childTodos = ((childTodoResult as any)?.data as any[]) || []
        const taskRunItem = taskRunItems.get(taskId)
        let childHasTerminalStop = false

        for (const msg of childMessages) {
          const info = (msg as any).info || msg
          const parts = (msg as any).parts || []
          const ts = toIsoTimestamp(info.time?.created || msg.time?.created)
          const role = info.role || msg.role || 'assistant'
          const textParts = parts.filter((part: any) => part.type === 'text' && typeof part.text === 'string' && part.text.length > 0)
          const fullText = textParts.map((part: any) => part.text).join('')

          for (const part of parts) {
            if (part.type === 'agent' && taskRunItem) {
              taskRunItem.taskRun.agent = normalizeAgentName(part.name || null)
                || extractAgentName(fullText, part.name)
                || taskRunItem.taskRun.agent
              taskRunItem.taskRun.title = chooseTaskTitle(
                taskRunItem.taskRun.agent,
                !isPlaceholderTaskTitle(taskRunItem.taskRun.title, taskRunItem.taskRun.agent) ? taskRunItem.taskRun.title : null,
              )
            }
            if (part.type === 'tool' && part.tool === 'task' && taskRunItem) {
              taskRunItem.taskRun.agent = normalizeAgentName(part.state?.metadata?.agent || part.metadata?.agent || null)
                || extractAgentName(part.title, part.state?.title, typeof part.state?.raw === 'string' ? part.state.raw : null)
                || taskRunItem.taskRun.agent
              taskRunItem.taskRun.title = chooseTaskTitle(
                taskRunItem.taskRun.agent,
                !isPlaceholderTaskTitle(taskRunItem.taskRun.title, taskRunItem.taskRun.agent) ? taskRunItem.taskRun.title : null,
                part.title,
                part.state?.title,
                typeof part.state?.raw === 'string' ? part.state.raw : null,
                typeof part.state?.input?.prompt === 'string' ? part.state.input.prompt : null,
              )
            }
            if (part.type === 'step-finish' && part.reason === 'stop') {
              childHasTerminalStop = true
            }
          }

          if (role === 'user' && taskRunItem) {
            taskRunItem.taskRun.title = chooseTaskTitle(
              taskRunItem.taskRun.agent,
              !isPlaceholderTaskTitle(taskRunItem.taskRun.title, taskRunItem.taskRun.agent) ? taskRunItem.taskRun.title : null,
              fullText,
            )
          }

        if (fullText && !isInternalCoworkMessage(fullText)) {
          textParts.forEach((part: any, index: number) => {
            const messageId = info.id || crypto.randomUUID()
            const partId = part.id || `${messageId}:part:${index}`
            out.push({
              type: 'task_text',
              id: `${taskId}:${messageId}:${partId}:text`,
              timestamp: ts,
              sequence: nextOrder(),
              taskRunId: taskId,
              messageId,
              partId,
              content: part.text,
            })
          })
          }

          for (const part of parts) {
            if (part.type === 'compaction') {
              out.push({
                type: 'task_compaction',
                id: `${taskId}:${part.id || crypto.randomUUID()}:compaction`,
                timestamp: ts,
                sequence: nextOrder(),
                taskRunId: taskId,
                compaction: {
                  status: 'compacted',
                  auto: !!part.auto,
                  overflow: !!part.overflow,
                  sourceSessionId: child.id,
                },
              })
              continue
            }

            if (part.type === 'tool' && part.tool) {
              const state = part.state || {}
              const title = part.title || ''
              const toolOutput = state.output
              out.push({
                type: 'task_tool',
                id: part.callID || part.id || crypto.randomUUID(),
                timestamp: ts,
                sequence: nextOrder(),
                taskRunId: taskId,
                tool: {
                  name: part.tool === 'task' && title ? title : part.tool,
                  input: state.input || {},
                  status: toolOutput ? 'complete' : state.error ? 'error' : 'complete',
                  output: toolOutput,
                  attachments: state.attachments || [],
                  agent: normalizeAgentName(state.metadata?.agent || part.metadata?.agent || null)
                    || extractAgentName(title, state.title, typeof state.raw === 'string' ? state.raw : null)
                    || taskRunItem?.taskRun.agent
                    || null,
                  sourceSessionId: child.id,
                },
              })
            }

            if (part.type === 'step-finish' && (part.cost || part.tokens)) {
              out.push({
                type: 'task_cost',
                id: `${taskId}:${part.id || crypto.randomUUID()}:cost`,
                timestamp: ts,
                sequence: nextOrder(),
                taskRunId: taskId,
                cost: createCostPayload(part),
              })
            }
          }
        }

        childCompletesById.set(child.id, childHasTerminalStop)
        if (taskRunItem) {
          taskRunItem.taskRun.status = getTaskStatus(child.id)
        }

        if (childTodos.length > 0) {
          out.push({
            type: 'task_todos',
            id: `${taskId}:todos`,
            timestamp: toIsoTimestamp(child.time?.updated || child.time?.created || Date.now()),
            sequence: nextOrder(),
            taskRunId: taskId,
            todos: childTodos,
          })
        }
      }

      return out.sort((a, b) => {
        const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        return timeDiff !== 0 ? timeDiff : a.sequence - b.sequence
      })
    } catch (err: any) {
      const detail = err?.message || err?.stack || JSON.stringify(err)
      log('error', `Failed to load messages for ${sessionId}: ${detail}`)
      return []
    }
  })

  ipcMain.handle('session:abort', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    log('session', `Aborting ${shortSessionId(sessionId)}`)
    try { await client.session.abort({ path: { id: sessionId } }) } catch (e: any) { log('error', `Abort: ${e?.message}`) }
  })

  ipcMain.handle('session:fork', async (_event, sessionId: string, messageId?: string) => {
    const { client, record } = await getSessionClient(sessionId)
    try {
      const result = await client.session.fork({
        path: { id: sessionId },
        body: messageId ? { messageID: messageId } : {},
      })
      const s = result.data as any
      if (!s) return null
      log('session', `Forked ${shortSessionId(sessionId)} -> ${shortSessionId(s.id)}${messageId ? ' at message' : ''}`)
      trackParentSession(s.id)
      const forked = upsertSessionRecord(
        toSessionRecord({
          id: s.id,
          title: s.title || 'Forked thread',
          createdAt: toIsoTimestamp(s.time?.created),
          updatedAt: toIsoTimestamp(s.time?.updated || s.time?.created),
          opencodeDirectory: record?.opencodeDirectory || getRuntimeHomeDir(),
        }),
      )
      return forked
        ? toRendererSession(forked)
        : {
            id: s.id,
            title: s.title || 'Forked thread',
            directory: record?.directory || null,
            createdAt: toIsoTimestamp(s.time?.created),
            updatedAt: toIsoTimestamp(s.time?.updated || s.time?.created),
          }
    } catch (err: any) {
      log('error', `Fork failed: ${err?.message}`)
      return null
    }
  })

  ipcMain.handle('session:export', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      const session = await client.session.get({ path: { id: sessionId } })
      const s = session.data as any
      const messagesResult = await client.session.messages({ throwOnError: true, path: { id: sessionId } })
      const messages = messagesResult.data as any[]
      if (!messages) return null

      let md = `# ${s?.title || 'Thread'}\n\n`
      md += `_Exported from Open Cowork_\n\n---\n\n`
      for (const msg of messages) {
        let text = ''
        const parts = msg.parts || []
        for (const part of parts) {
          if (part.type === 'text' && part.text) text += part.text
        }
        if (!text || isInternalCoworkMessage(text)) continue
        if (msg.role === 'user') {
          md += `## User\n\n${text}\n\n`
        } else {
          md += `## Assistant\n\n${text}\n\n`
        }
      }
      return md
    } catch (err) {
      logHandlerError(`session:export ${shortSessionId(sessionId)}`, err)
      return null
    }
  })

  ipcMain.handle('session:share', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      const result = await client.session.share({ path: { id: sessionId } })
      const data = result.data as any
      // Response may be the session object with a share.url field, or a string URL
      const url = data?.share?.url || data?.url || (typeof data === 'string' ? data : null)
      log('session', `Shared ${shortSessionId(sessionId)} hasUrl=${!!url}`)
      return url
    } catch (err: any) {
      log('error', `Share failed: ${err?.message}`)
      return null
    }
  })

  ipcMain.handle('session:unshare', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      await client.session.unshare({ path: { id: sessionId } })
      log('session', `Unshared ${shortSessionId(sessionId)}`)
      return true
    } catch (err) {
      logHandlerError(`session:unshare ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  ipcMain.handle('session:summarize', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      // Get the first user message and first assistant response as preview
      const result = await client.session.messages({ path: { id: sessionId } })
      const messages = (result.data as any[]) || []
      let userMsg = ''
      let assistantMsg = ''
      for (const msg of messages) {
        const info = msg.info || msg
        const parts = msg.parts || []
        let text = ''
        for (const part of parts) {
          if (part.type === 'text' && part.text) text += part.text
        }
        if (!text) continue
        if (info.role === 'user' && !userMsg) userMsg = text.slice(0, 100)
        if (info.role === 'assistant' && !assistantMsg) { assistantMsg = text.slice(0, 200); break }
      }
      return assistantMsg || userMsg || null
    } catch (err) {
      logHandlerError(`session:summarize ${shortSessionId(sessionId)}`, err)
      return null
    }
  })

  ipcMain.handle('session:revert', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      await client.session.revert({ path: { id: sessionId } })
      log('session', `Reverted ${shortSessionId(sessionId)}`)
      return true
    } catch (err) {
      logHandlerError(`session:revert ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  ipcMain.handle('session:unrevert', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      await client.session.unrevert({ path: { id: sessionId } })
      log('session', `Unreverted ${shortSessionId(sessionId)}`)
      return true
    } catch (err) {
      logHandlerError(`session:unrevert ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  ipcMain.handle('session:children', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      const result = await client.session.children({ path: { id: sessionId } })
      return result.data || []
    } catch (err) {
      logHandlerError(`session:children ${shortSessionId(sessionId)}`, err)
      return []
    }
  })

  ipcMain.handle('session:diff', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      const result = await client.session.diff({ path: { id: sessionId } })
      return result.data || []
    } catch (err) {
      logHandlerError(`session:diff ${shortSessionId(sessionId)}`, err)
      return []
    }
  })

  ipcMain.handle('tool:list', async () => {
    const client = getClient()
    if (!client) return []
    try {
      const result = await client.tool.list({ query: { provider: '', model: '' } })
      return result.data || []
    } catch (err) {
      logHandlerError('tool:list', err)
      return []
    }
  })

  ipcMain.handle('command:list', async () => {
    const client = getClient()
    if (!client) return []
    try {
      const result = await client.command.list()
      return (result.data as any[]) || []
    } catch (err) {
      logHandlerError('command:list', err)
      return []
    }
  })

  ipcMain.handle('command:run', async (_event, sessionId: string, commandName: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      trackParentSession(sessionId)
      await client.session.command({ path: { id: sessionId }, body: { name: commandName } as any })
      touchSessionRecord(sessionId)
      return true
    } catch (err) {
      logHandlerError(`command:run ${shortSessionId(sessionId)}:${commandName}`, err)
      return false
    }
  })

  ipcMain.handle('session:rename', async (_event, sessionId: string, title: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      await client.session.update({ path: { id: sessionId }, body: { title } })
      log('session', `Renamed ${shortSessionId(sessionId)}`)
      updateSessionRecord(sessionId, { title, updatedAt: new Date().toISOString() })
      return true
    } catch (err) {
      logHandlerError(`session:rename ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  ipcMain.handle('session:delete', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      await client.session.delete({ path: { id: sessionId } })
      clearPermissionsForSession(sessionId)
      removeParentSession(sessionId)
      removeSessionRecord(sessionId)
      log('session', `Deleted ${shortSessionId(sessionId)}`)
      return true
    } catch (err) {
      logHandlerError(`session:delete ${shortSessionId(sessionId)}`, err)
      return false
    }
  })

  ipcMain.handle('permission:respond', async (_event, permissionId: string, allowed: boolean) => {
    const sessionId = permissionSessionMap.get(permissionId)
    if (!sessionId) throw new Error(`No session for permission ${permissionId}`)
    const { client } = await getSessionClient(sessionId)

    log('permission', `${allowed ? 'Approved' : 'Denied'} ${permissionId}`)
    await client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: permissionId },
      body: { response: allowed ? 'once' : 'reject' },
    })
    permissionSessionMap.delete(permissionId)
  })

  // MCP auth — triggers browser-based OAuth flow
  ipcMain.handle('mcp:auth', async (_event, mcpName: string) => {
    const client = getClient()
    if (!client) throw new Error('Runtime not started')

    log('mcp', `Triggering OAuth for ${mcpName}`)
    try {
      await client.mcp.auth.authenticate({
        path: { name: mcpName },
      })
      log('mcp', `OAuth complete for ${mcpName}`)
      return true
    } catch (err: any) {
      log('error', `MCP auth failed for ${mcpName}: ${err?.message}`)
      return false
    }
  })

  // MCP connect/disconnect — live toggle without restart
  ipcMain.handle('mcp:connect', async (_event, name: string) => {
    const client = getClient()
    if (!client) throw new Error('Runtime not started')
    try {
      await client.mcp.connect({ path: { name } })
      log('mcp', `Connected: ${name}`)
      return true
    } catch (err: any) {
      log('error', `MCP connect failed for ${name}: ${err?.message}`)
      return false
    }
  })

  ipcMain.handle('mcp:disconnect', async (_event, name: string) => {
    const client = getClient()
    if (!client) throw new Error('Runtime not started')
    try {
      await client.mcp.disconnect({ path: { name } })
      log('mcp', `Disconnected: ${name}`)
      return true
    } catch (err: any) {
      log('error', `MCP disconnect failed for ${name}: ${err?.message}`)
      return false
    }
  })

  // App agents
  ipcMain.handle('app:agents', async () => {
    const client = getClient()
    if (!client) return []
    try {
      const result = await client.app.agents()
      return result.data || []
    } catch (err) {
      logHandlerError('app:agents', err)
      return []
    }
  })

  ipcMain.handle('app:builtin-agents', async () => {
    return listBuiltInAgentDetails()
  })

  ipcMain.handle('agents:catalog', async () => {
    return getCustomAgentCatalog()
  })

  ipcMain.handle('agents:list', async () => {
    return getCustomAgentSummaries()
  })

  ipcMain.handle('agents:create', async (_event, agent: CustomAgent) => {
    const normalized = normalizeCustomAgent(agent)
    const settings = loadSettings()
    const catalog = getCustomAgentCatalog(settings)
    const siblingNames = (settings.customAgents || []).map((entry) => normalizeCustomAgent(entry).name)
    const issues = validateCustomAgent(normalized, catalog, siblingNames)
    if (issues.length > 0) {
      throw new Error(issues[0]?.message || 'Invalid custom sub-agent')
    }

    saveSettings({ customAgents: [...(settings.customAgents || []), normalized] })
    log('agent', `Added custom sub-agent: ${normalized.name}`)
    const { rebootRuntime } = await import('./index')
    await rebootRuntime()
    return true
  })

  ipcMain.handle('agents:update', async (_event, previousName: string, agent: CustomAgent) => {
    const normalized = normalizeCustomAgent(agent)
    const previousNormalized = normalizeCustomAgent({
      ...agent,
      name: previousName,
    }).name
    const settings = loadSettings()
    const catalog = getCustomAgentCatalog(settings)
    const siblingNames = (settings.customAgents || [])
      .filter((entry) => normalizeCustomAgent(entry).name !== previousNormalized)
      .map((entry) => normalizeCustomAgent(entry).name)
    const issues = validateCustomAgent(normalized, catalog, siblingNames)
    if (issues.length > 0) {
      throw new Error(issues[0]?.message || 'Invalid custom sub-agent')
    }

    const nextAgents = (settings.customAgents || [])
      .filter((entry) => normalizeCustomAgent(entry).name !== previousNormalized)
    nextAgents.push(normalized)
    saveSettings({ customAgents: nextAgents })
    log('agent', `Updated custom sub-agent: ${previousNormalized} -> ${normalized.name}`)
    const { rebootRuntime } = await import('./index')
    await rebootRuntime()
    return true
  })

  ipcMain.handle('agents:remove', async (_event, name: string) => {
    const normalizedName = normalizeCustomAgent({
      name,
      description: '',
      instructions: '',
      skillNames: [],
      integrationIds: [],
      enabled: true,
      color: 'accent',
    }).name
    const settings = loadSettings()
    saveSettings({ customAgents: (settings.customAgents || []).filter((entry) => normalizeCustomAgent(entry).name !== normalizedName) })
    log('agent', `Removed custom sub-agent: ${normalizedName}`)
    const { rebootRuntime } = await import('./index')
    await rebootRuntime()
    return true
  })

  // Session todos
  ipcMain.handle('session:todo', async (_event, sessionId: string) => {
    const { client } = await getSessionClient(sessionId)
    try {
      const result = await client.session.todo({ path: { id: sessionId } })
      return result.data || []
    } catch (err) {
      logHandlerError(`session:todo ${shortSessionId(sessionId)}`, err)
      return []
    }
  })

  // Plugin management
  ipcMain.handle('plugins:list', async () => {
    return getInstalledPlugins()
  })

  ipcMain.handle('plugins:install', async (_event, id: string) => {
    log('plugin', `Installing ${id}`)
    const installed = installPlugin(id)
    if (installed) {
      const { rebootRuntime } = await import('./index')
      await rebootRuntime()
    }
    return installed
  })

  ipcMain.handle('plugins:uninstall', async (_event, id: string) => {
    log('plugin', `Uninstalling ${id}`)
    const removed = uninstallPlugin(id)
    if (removed) {
      const { rebootRuntime } = await import('./index')
      await rebootRuntime()
    }
    return removed
  })

  // Read a skill file — returns the full markdown content
  ipcMain.handle('plugins:skill-content', async (_event, skillName: string) => {
    const downstreamRoot = process.env.OPEN_COWORK_DOWNSTREAM_ROOT?.trim()
    // Check multiple locations where skills might be
    const locations = [
      ...(downstreamRoot ? [findBundledSkillFile(join(downstreamRoot, 'skills'), skillName)] : []),
      // Packaged: skills are in extraResources
      findBundledSkillFile(join(process.resourcesPath, 'skills'), skillName),
      join(process.resourcesPath, 'runtime-config', 'skills', skillName, 'SKILL.md'),
      // Dev: relative to app path
      findBundledSkillFile(join(app.getAppPath(), '..', '..', '.opencode', 'skills'), skillName),
      findBundledSkillFile(join(app.getAppPath(), '.opencode', 'skills'), skillName),
      join(app.getAppPath(), 'runtime-config', 'skills', skillName, 'SKILL.md'),
    ]
    for (const path of locations) {
      if (path && existsSync(path)) {
        return readFileSync(path, 'utf-8')
      }
    }
    return null
  })

  // List MCP tools from the runtime
  ipcMain.handle('plugins:mcp-tools', async () => {
    const client = getClient()
    if (!client) return []
    try {
      const result = await client.tool.ids()
      const ids = result.data as string[]
      if (!ids) return []
      // Group by MCP prefix and return tool info
      return ids
        .filter((id: string) => id.startsWith('mcp__'))
        .map((id: string) => {
          const parts = id.replace('mcp__', '').split('__')
          return { id, mcp: parts[0] || '', tool: parts.slice(1).join('__') || id }
        })
    } catch (err) {
      logHandlerError('plugins:mcp-tools', err)
      return []
    }
  })

  // List loaded skills from runtime
  ipcMain.handle('plugins:runtime-skills', async () => {
    const client = getClient()
    if (!client) return []
    try {
      const result = await client.command.list()
      const commands = result.data as any[]
      if (!commands) return []
      return commands
        .filter((c: any) => c.source === 'skill')
        .map((c: any) => ({ name: c.name, description: c.description || '' }))
    } catch (err) {
      logHandlerError('plugins:runtime-skills', err)
      return []
    }
  })

  // ─── Input validation ───

  const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
  const MAX_SKILL_CONTENT = 100 * 1024 // 100KB

  function validateName(name: string, type: string): void {
    if (!name || !VALID_NAME.test(name)) {
      throw new Error(`Invalid ${type} name: "${name}". Use alphanumeric characters, hyphens, and underscores only (max 64 chars).`)
    }
  }

  // ─── Custom MCPs ───

  ipcMain.handle('custom:list-mcps', async () => {
    return loadSettings().customMcps || []
  })

  ipcMain.handle('custom:add-mcp', async (_event, mcp: CustomMcp) => {
    validateName(mcp.name, 'MCP')
    const settings = loadSettings()
    const mcps = settings.customMcps || []
    const filtered = mcps.filter(m => m.name !== mcp.name)
    filtered.push(mcp)
    saveSettings({ customMcps: filtered })
    log('custom', `Added MCP: ${mcp.name} (${mcp.type})`)
    const { rebootRuntime } = await import('./index')
    await rebootRuntime()
    return true
  })

  ipcMain.handle('custom:remove-mcp', async (_event, name: string) => {
    const settings = loadSettings()
    saveSettings({ customMcps: (settings.customMcps || []).filter(m => m.name !== name) })
    log('custom', `Removed MCP: ${name}`)
    const { rebootRuntime } = await import('./index')
    await rebootRuntime()
    return true
  })

  // ─── Custom Skills ───

  ipcMain.handle('custom:list-skills', async () => {
    return loadSettings().customSkills || []
  })

  ipcMain.handle('custom:add-skill', async (_event, skill: CustomSkill) => {
    validateName(skill.name, 'skill')
    if (skill.content && skill.content.length > MAX_SKILL_CONTENT) {
      throw new Error(`Skill content too large (${(skill.content.length / 1024).toFixed(0)}KB). Max is ${MAX_SKILL_CONTENT / 1024}KB.`)
    }
    const settings = loadSettings()
    const skills = settings.customSkills || []
    const filtered = skills.filter(s => s.name !== skill.name)
    filtered.push(skill)
    saveSettings({ customSkills: filtered })
    log('custom', `Added skill: ${skill.name}`)
    const { rebootRuntime } = await import('./index')
    await rebootRuntime()
    return true
  })

  ipcMain.handle('custom:remove-skill', async (_event, name: string) => {
    const settings = loadSettings()
    saveSettings({ customSkills: (settings.customSkills || []).filter(s => s.name !== name) })
    log('custom', `Removed skill: ${name}`)
    const { rebootRuntime } = await import('./index')
    await rebootRuntime()
    return true
  })
}

const permissionSessionMap = new Map<string, string>()

export function trackPermission(permissionId: string, sessionId: string) {
  permissionSessionMap.set(permissionId, sessionId)
}

export function clearPermissionsForSession(sessionId: string) {
  for (const [permissionId, mappedSessionId] of permissionSessionMap.entries()) {
    if (mappedSessionId === sessionId) {
      permissionSessionMap.delete(permissionId)
    }
  }
}
