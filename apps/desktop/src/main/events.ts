import type { BrowserWindow } from 'electron'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { trackPermission } from './ipc-handlers'
import { log } from './logger'
import { calculateCost } from './pricing'
import { loadSettings } from './settings'

// Track sessions created by our UI (not subtask child sessions)
const parentSessions = new Set<string>()

export function trackParentSession(sessionId: string) {
  parentSessions.add(sessionId)
}

export function removeParentSession(sessionId: string) {
  parentSessions.delete(sessionId)
}

export async function subscribeToEvents(
  client: OpencodeClient,
  getMainWindow: () => BrowserWindow | null,
) {
  log('events', 'Subscribing to SSE event stream')
  const result = await client.event.subscribe()
  const stream = result.stream
  log('events', 'SSE stream connected')

  // Cache model ID once — loadSettings() reads a local JSON file (fast, no gcloud)
  const cachedModelId = loadSettings().defaultModel

  // Track message roles to filter user vs assistant
  const messageRoles = new Map<string, 'user' | 'assistant'>()

  for await (const event of stream) {
    const win = getMainWindow()
    if (!win) continue

    const data = event as any
    if (!data?.type) continue


    switch (data.type) {
      // Track which messages are user vs assistant
      case 'message.updated': {
        const info = data.properties?.info
        if (info?.id && info?.role) {
          messageRoles.set(info.id, info.role)
        }
        break
      }

      // Streaming deltas — incremental text chunks
      case 'message.part.delta': {
        const props = data.properties || {}
        const delta = props.delta
        const sessionId = props.sessionID
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
          win.webContents.send('stream:event', {
            type: 'cost',
            sessionId: part.sessionID,
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
            win.webContents.send('stream:event', {
              type: 'agent',
              sessionId: part.sessionID,
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

          log('tool', `${part.tool} state=${stateType} status=${status} title=${title} keys=${Object.keys(state).join(',')} input=${JSON.stringify(state.input || state.raw || '').slice(0, 200)}`)

          // question tool is denied in our config — skip if it somehow appears
          if (part.tool === 'question') break

          // Use title as the display name for task tools
          const displayName = part.tool === 'task' && title ? title : part.tool

          // For task tools, input might be a string prompt or in raw field
          let toolInput = state.input || state.args || {}
          if (part.tool === 'task' && typeof state.raw === 'string' && !Object.keys(toolInput).length) {
            toolInput = { prompt: state.raw }
          }

          win.webContents.send('stream:event', {
            type: 'tool_call',
            sessionId: part.sessionID,
            data: {
              type: 'tool_call',
              id: part.callID || part.id,
              name: displayName,
              input: toolInput,
              status,
              output: state.output || state.result,
              agent: metadata.agent || null,
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

          // Stop "Thinking" — the agent is waiting for user approval
          win.webContents.send('stream:event', {
            type: 'done', sessionId: perm.sessionID, data: { type: 'done' },
          })

          win.webContents.send('permission:request', {
            id: perm.id,
            tool: perm.title || perm.type,
            input: perm.metadata || {},
            description: perm.title || `Permission requested for ${perm.type}`,
          })
        }
        break
      }

      case 'session.status': {
        const status = data.properties?.status
        const sessionId = data.properties?.sessionID

        if (status?.type === 'idle') {
          log('session', `Idle: ${sessionId}`)
          // Only send 'done' for parent sessions (not subtask child sessions)
          if (parentSessions.has(sessionId)) {
            messageRoles.clear()
            win.webContents.send('stream:event', {
              type: 'done',
              sessionId,
              data: { type: 'done' },
            })
          }
        }
        break
      }

      case 'session.compacted': {
        const sessionId = data.properties?.sessionID
        log('session', `Compacted: ${sessionId}`)
        // Context was compacted — notify renderer to reset context tracking
        win.webContents.send('stream:event', {
          type: 'compacted',
          sessionId,
          data: { type: 'compacted' },
        })
        break
      }

      case 'session.error': {
        const sessionId = data.properties?.sessionID
        const error = data.properties?.error
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
