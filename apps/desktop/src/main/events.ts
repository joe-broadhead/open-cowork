import type { BrowserWindow } from 'electron'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { trackPermission } from './ipc-handlers'
import { log } from './logger'
import { calculateCost } from './pricing'
import { loadSettings } from './settings'
import { touchSessionRecord, updateSessionRecord } from './session-registry'

// Track sessions created by our UI (not subtask child sessions)
const parentSessions = new Set<string>()
const sessionLineage = new Map<string, string>()

function registerSession(sessionId?: string | null, parentId?: string | null) {
  if (!sessionId) return
  if (!parentId) {
    if (!sessionLineage.has(sessionId)) {
      sessionLineage.set(sessionId, sessionId)
    }
    return
  }
  sessionLineage.set(sessionId, parentId)
}

function resolveRootSession(sessionId?: string | null) {
  if (!sessionId) return sessionId ?? undefined

  let current = sessionId
  const seen = new Set<string>()

  while (true) {
    const next = sessionLineage.get(current)
    if (!next) return current
    if (next === current) return current
    if (seen.has(current)) return current
    seen.add(current)
    current = next
  }
}

export function trackParentSession(sessionId: string) {
  parentSessions.add(sessionId)
  sessionLineage.set(sessionId, sessionId)
}

export function removeParentSession(sessionId: string) {
  parentSessions.delete(sessionId)
  sessionLineage.delete(sessionId)
}

export async function subscribeToEvents(
  client: OpencodeClient,
  getMainWindow: () => BrowserWindow | null,
) {
  function toIsoTimestamp(value?: number) {
    const raw = typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
    const ms = raw < 1_000_000_000_000 ? raw * 1000 : raw
    return new Date(ms).toISOString()
  }

  log('events', 'Subscribing to SSE event stream')
  // Use the global event stream so sessions in different directories all
  // publish into the same renderer pipeline. Project-scoped `/event`
  // subscriptions only surface events for a single OpenCode instance.
  const result = typeof (client as any).global?.event === 'function'
    ? await (client as any).global.event()
    : await client.event.subscribe()
  const stream = result.stream
  log('events', 'SSE stream connected')

  // Cache model ID once — loadSettings() reads a local JSON file (fast, no gcloud)
  const cachedModelId = loadSettings().defaultModel

  // Track message roles to filter user vs assistant
  const messageRoles = new Map<string, 'user' | 'assistant'>()

  for await (const event of stream) {
    const win = getMainWindow()
    if (!win) continue

    // `/event` yields the raw Event object, while `/global/event` yields
    // `{ directory, payload }`. Normalize both into the same `data` shape.
    const envelope = event as any
    const data = envelope?.payload ?? envelope
    if (!data?.type) continue


    switch (data.type) {
      // Track which messages are user vs assistant
      case 'message.updated': {
        const info = data.properties?.info
        if (info?.id && info?.role) {
          messageRoles.set(info.id, info.role)
        }
        if (info?.sessionID) {
          registerSession(info.sessionID)
        }
        break
      }

      // Streaming deltas — incremental text chunks
      case 'message.part.delta': {
        const props = data.properties || {}
        const delta = props.delta
        const sessionId = resolveRootSession(props.sessionID)
        if (delta && sessionId) {
          win.webContents.send('stream:event', {
            type: 'text',
            sessionId,
            data: { type: 'text', content: String(delta) },
          })
        }
        break
      }

      // Full part updates — accumulated text, tool states, cost
      case 'message.part.updated': {
        const props = data.properties || {}
        const part = props.part
        if (!part) break

        const messageRole = messageRoles.get(part.messageID)

        // Skip user message parts (we already show those from the UI)
        if (messageRole === 'user') break

        // Capture cost from step-finish parts
        if (part.type === 'step-finish' && (part.cost !== undefined || part.tokens)) {
          const tokens = part.tokens || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          // Use reported cost if available, otherwise estimate from token counts
          let cost = part.cost || 0
          if (cost === 0 && (tokens.input > 0 || tokens.output > 0)) {
            cost = calculateCost(cachedModelId, tokens)
          }
          const sessionId = resolveRootSession(part.sessionID)
          win.webContents.send('stream:event', {
            type: 'cost',
            sessionId,
            data: {
              type: 'cost',
              cost,
              tokens: part.tokens || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          })
          break
        }

        // Forward agent parts to renderer — shows which subagent is running
        if (part.type === 'agent') {
          const agentName = (part as any).agent || (part as any).name || ''
          log('agent', `Subagent: ${agentName}`)
          if (agentName) {
            const sessionId = resolveRootSession(part.sessionID)
            win.webContents.send('stream:event', {
              type: 'agent',
              sessionId,
              data: { type: 'agent', name: agentName },
            })
          }
        }

        // Skip non-text parts that aren't tools
        if (part.type === 'reasoning' || part.type === 'step-start'
          || part.type === 'snapshot' || part.type === 'compaction' || part.type === 'agent'
          || part.type === 'retry' || part.type === 'patch') {
          break
        }

        // Text is handled by message.part.delta above — skip here to avoid duplicates
        if (part.type === 'text') break

        if (part.type === 'tool') {
          // Tool state can be nested: part.state.type or flat on part
          const state = part.state || {}
          const stateType = state.type || ''
          const isComplete = stateType === 'completed' || stateType === 'complete' || !!state.output
          const isError = stateType === 'error'
          const status = isComplete ? 'complete' : isError ? 'error' : 'running'

          // For task/subtask tools, extract the title for display
          const title = (part as any).title || state.title || ''
          const metadata = (part as any).metadata || state.metadata || {}
          const sessionId = resolveRootSession(part.sessionID)

          log('tool', `[${part.sessionID?.slice(-8) || '?'}=>${sessionId?.slice(-8) || '?'}] ${part.tool} status=${status} title=${title}`)

          // question tool is denied in our config — skip if it somehow appears
          if (part.tool === 'question') break

          // Use title as the display name for task tools
          const displayName = part.tool === 'task' && title ? title : part.tool

          // For task tools, input might be a string prompt or in raw field
          let toolInput = state.input || state.args || {}
          if (part.tool === 'task' && typeof state.raw === 'string' && !Object.keys(toolInput).length) {
            toolInput = { prompt: state.raw }
          }

          // Extract attachments (images, files, charts)
          const attachments = state.attachments || (part as any).attachments || []

          win.webContents.send('stream:event', {
            type: 'tool_call',
            sessionId,
            data: {
              type: 'tool_call',
              id: part.callID || part.id,
              name: displayName,
              input: toolInput,
              status,
              output: state.output || state.result,
              agent: metadata.agent || null,
              attachments: attachments.length > 0 ? attachments : undefined,
            },
          })
        }
        break
      }

      case 'permission.updated': {
        const perm = data.properties
        if (perm) {
          log('permission', `FULL EVENT: ${JSON.stringify(perm).slice(0, 500)}`)
          trackPermission(perm.id, perm.sessionID)
          const sessionId = resolveRootSession(perm.sessionID)

          // Stop "Thinking" — the agent is waiting for user approval
          win.webContents.send('stream:event', {
            type: 'done', sessionId, data: { type: 'done' },
          })

          win.webContents.send('permission:request', {
            id: perm.id,
            sessionId: sessionId || perm.sessionID,
            tool: perm.title || perm.type,
            input: perm.metadata || {},
            description: perm.title || `Permission requested for ${perm.type}`,
          })
        }
        break
      }

      case 'session.status': {
        const status = data.properties?.status
        const actualSessionId = data.properties?.sessionID
        const sessionId = resolveRootSession(actualSessionId)

        if (status?.type === 'busy') {
          if (sessionId) touchSessionRecord(sessionId)
          win.webContents.send('stream:event', {
            type: 'busy', sessionId, data: { type: 'busy' },
          })
        }

        if (status?.type === 'idle') {
          log('session', `Idle: ${actualSessionId}${sessionId && sessionId !== actualSessionId ? ` => ${sessionId}` : ''}`)
          if (sessionId) touchSessionRecord(sessionId)
          // Only root sessions should dismiss the thread-level busy state.
          if (sessionId && actualSessionId && sessionId === actualSessionId && parentSessions.has(sessionId)) {
            win.webContents.send('stream:event', {
              type: 'done', sessionId, data: { type: 'done' },
            })
          }
        }
        break
      }

      case 'session.compacted': {
        const actualSessionId = data.properties?.sessionID
        const sessionId = resolveRootSession(actualSessionId)
        log('session', `Compacted: ${actualSessionId}${sessionId && sessionId !== actualSessionId ? ` => ${sessionId}` : ''}`)
        // Context was compacted — notify renderer to reset context tracking
        win.webContents.send('stream:event', {
          type: 'compacted',
          sessionId,
          data: { type: 'compacted' },
        })
        break
      }

      case 'session.created': {
        const info = data.properties?.info
        if (info?.id) {
          registerSession(info.id, info.parentID)
        }
        break
      }

      // Session lifecycle — auto-sync sidebar
      case 'session.updated': {
        const info = data.properties?.info
        if (info?.id) {
          registerSession(info.id, info.parentID)
        }
        if (info?.id && info?.title && !info?.parentID) {
          updateSessionRecord(info.id, {
            title: info.title,
            updatedAt: toIsoTimestamp(info.time?.updated || info.time?.created),
          })
          win.webContents.send('session:updated', {
            id: info.id,
            title: info.title,
          })
        }
        break
      }

      case 'session.deleted': {
        const info = data.properties?.info
        if (info?.id) {
          sessionLineage.delete(info.id)
          if (!info.parentID) {
            parentSessions.delete(info.id)
          }
        }
        break
      }

      case 'todo.updated': {
        const props = data.properties
        const sessionId = resolveRootSession(props?.sessionID)
        if (sessionId && props?.todos) {
          win.webContents.send('stream:event', {
            type: 'todos',
            sessionId,
            data: { type: 'todos', todos: props.todos },
          })
        }
        break
      }

      case 'file.edited': {
        const file = data.properties?.file
        if (file) {
          log('file', `Edited: ${file}`)
        }
        break
      }

      case 'session.error': {
        const sessionId = resolveRootSession(data.properties?.sessionID)
        const error = data.properties?.error
        if (sessionId) touchSessionRecord(sessionId)
        log('error', `Session error: ${JSON.stringify(error)}`)
        win.webContents.send('stream:event', {
          type: 'error',
          sessionId,
          data: { type: 'error', message: error?.message || 'An error occurred' },
        })
        break
      }
    }
  }

  log('events', 'SSE stream ended — triggering reconnect')
  throw new Error('SSE stream ended unexpectedly')
}

export async function getMcpStatus(client: OpencodeClient) {
  try {
    const result = await client.mcp.status()
    const statuses = result.data as any
    if (!statuses) {
      log('mcp', 'mcp.status() returned no data')
      return []
    }
    const entries = Object.entries(statuses).map(([name, info]: [string, any]) => ({
      name,
      connected: info?.status === 'connected',
      rawStatus: info?.status,
    }))
    const connected = entries.filter(e => e.connected).length
    log('mcp', `Status: ${connected}/${entries.length} connected (${entries.filter(e => !e.connected).map(e => `${e.name}=${e.rawStatus}`).join(', ')})`)
    return entries
  } catch (err: any) {
    log('error', `mcp.status() failed: ${err?.message}`)
    return []
  }
}
