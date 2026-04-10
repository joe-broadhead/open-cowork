import type { BrowserWindow } from 'electron'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { trackPermission } from './ipc-handlers'
import { log } from './logger'
import { calculateCost } from './pricing'
import { loadSettings } from './settings'

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

          log('tool', `${part.tool} state=${stateType} status=${status} keys=${Object.keys(state).join(',')}`)

          // question tool is denied in our config — skip if it somehow appears
          if (part.tool === 'question') break

          win.webContents.send('stream:event', {
            type: 'tool_call',
            sessionId: part.sessionID,
            data: {
              type: 'tool_call',
              id: part.callID || part.id,
              name: part.tool,
              input: state.input || state.args || {},
              status,
              output: state.output || state.result,
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
          // Clean up tracking map
          messageRoles.clear()
          win.webContents.send('stream:event', {
            type: 'done',
            sessionId,
            data: { type: 'done' },
          })
        }
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

  log('events', 'SSE stream ended')
}

export async function getMcpStatus(client: OpencodeClient) {
  try {
    const result = await client.mcp.status()
    const statuses = result.data as any
    if (!statuses) return []
    return Object.entries(statuses).map(([name, info]: [string, any]) => ({
      name,
      connected: info?.status === 'connected',
    }))
  } catch {
    return []
  }
}
