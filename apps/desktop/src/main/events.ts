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
  // Track part text length to compute deltas
  const partTextSent = new Map<string, number>()

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

      case 'message.part.updated':
      case 'message.part.delta': {
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

        if (part.type === 'text' && part.text) {
          const partId = part.id
          const fullText = part.text as string
          const alreadySent = partTextSent.get(partId) || 0

          // Only send the new delta
          if (fullText.length > alreadySent) {
            const delta = fullText.slice(alreadySent)
            partTextSent.set(partId, fullText.length)

            win.webContents.send('stream:event', {
              type: 'text',
              sessionId: part.sessionID,
              data: { type: 'text', content: delta },
            })
          }
        } else if (part.type === 'tool') {
          // Tool state can be nested: part.state.type or flat on part
          const state = part.state || {}
          const stateType = state.type || ''
          const isComplete = stateType === 'completed' || stateType === 'complete' || !!state.output
          const isError = stateType === 'error'
          const status = isComplete ? 'complete' : isError ? 'error' : 'running'

          log('tool', `${part.tool} state=${stateType} status=${status} keys=${Object.keys(state).join(',')}`)

          // When the question tool fires, the agent is waiting for user input
          // Signal "done" so the UI stops showing "Thinking" and lets the user type
          if (part.tool === 'question') {
            win.webContents.send('stream:event', {
              type: 'done', sessionId: part.sessionID, data: { type: 'done' },
            })
          }

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
          log('permission', `Requested: ${perm.title || perm.type} (${perm.id})`)
          trackPermission(perm.id, perm.sessionID)
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
          // Clean up tracking maps to prevent memory leaks
          partTextSent.clear()
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
