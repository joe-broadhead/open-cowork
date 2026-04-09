import type { IpcMain, BrowserWindow } from 'electron'
import { getClient } from './runtime'
import { getEffectiveSettings, saveSettings, type CoworkSettings } from './settings'
import { getAuthState, loginWithGoogle, getAccessToken, refreshAccessToken } from './auth'
import { log } from './logger'

export function setupIpcHandlers(ipcMain: IpcMain, getMainWindow: () => BrowserWindow | null) {
  // Auth handlers
  ipcMain.handle('auth:status', async () => {
    return getAuthState()
  })

  ipcMain.handle('auth:login', async () => {
    log('auth', 'User initiated login')
    const state = await loginWithGoogle()
    if (state.authenticated) {
      log('auth', `Logged in as ${state.email}`)
      // Set token for gws CLI
      const token = getAccessToken()
      if (token) process.env.GOOGLE_WORKSPACE_CLI_TOKEN = token
      // Boot the runtime
      const { bootRuntime } = await import('./index')
      await bootRuntime()
    }
    return state
  })

  ipcMain.handle('settings:get', async () => {
    return getEffectiveSettings()
  })

  ipcMain.handle('settings:set', async (_event, updates: Partial<CoworkSettings>) => {
    return saveSettings(updates)
  })

  ipcMain.handle('session:create', async () => {
    const client = getClient()
    if (!client) throw new Error('Runtime not started')

    log('session', 'Creating new session')
    const result = await client.session.create({ throwOnError: true })
    const session = result.data as any
    log('session', `Created session ${session.id}`)

    return {
      id: session.id,
      title: session.title || 'New session',
      createdAt: new Date((session.time?.created || Date.now() / 1000) * 1000).toISOString(),
      updatedAt: new Date((session.time?.created || Date.now() / 1000) * 1000).toISOString(),
    }
  })

  ipcMain.handle('session:prompt', async (_event, sessionId: string, text: string) => {
    const client = getClient()
    if (!client) throw new Error('Runtime not started')

    log('prompt', `Sending to ${sessionId}: "${text.slice(0, 80)}..."`)

    try {
      // Use promptAsync — fire-and-forget, response streams via SSE events
      await client.session.promptAsync({
        throwOnError: true,
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text }] },
      })
      log('prompt', `Prompt accepted for ${sessionId}`)
    } catch (err: any) {
      log('error', `Prompt failed: ${err?.message}`)
      const win = getMainWindow()
      win?.webContents.send('stream:event', {
        type: 'error',
        sessionId,
        data: { type: 'error', message: err?.message || 'Prompt failed' },
      })
      win?.webContents.send('stream:event', {
        type: 'done',
        sessionId,
        data: { type: 'done' },
      })
    }
  })

  ipcMain.handle('session:list', async () => {
    const client = getClient()
    if (!client) return []
    const result = await client.session.list({ throwOnError: true })
    const data = result.data as any
    return (data || []).map((s: any) => ({
      id: s.id,
      title: s.title || `Session ${s.id.slice(0, 6)}`,
      createdAt: new Date((s.time?.created || 0) * 1000).toISOString(),
      updatedAt: new Date((s.time?.updated || s.time?.created || 0) * 1000).toISOString(),
    }))
  })

  ipcMain.handle('session:get', async (_event, id: string) => {
    const client = getClient()
    if (!client) return null
    try {
      const result = await client.session.get({ path: { id } })
      const s = result.data as any
      if (!s) return null
      return {
        id: s.id,
        title: s.title,
        createdAt: new Date((s.time?.created || 0) * 1000).toISOString(),
        updatedAt: new Date((s.time?.updated || s.time?.created || 0) * 1000).toISOString(),
      }
    } catch { return null }
  })

  // Load messages for a session (for history)
  ipcMain.handle('session:messages', async (_event, sessionId: string) => {
    const client = getClient()
    if (!client) return []

    try {
      const result = await client.session.messages({
        throwOnError: true,
        path: { id: sessionId },
      })
      const messages = result.data as any[]
      if (!messages) return []

      const out: Array<{ id: string; role: string; content: string; timestamp: string }> = []

      for (const msg of messages) {
        // Get message text from its parts
        let text = ''
        const parts = (msg as any).parts || []
        for (const part of parts) {
          if (part.type === 'text' && part.text) {
            text += part.text
          }
        }
        if (!text) continue

        out.push({
          id: msg.id,
          role: msg.role,
          content: text,
          timestamp: new Date((msg.time?.created || 0) * 1000).toISOString(),
        })
      }

      return out
    } catch (err) {
      log('error', `Failed to load messages for ${sessionId}: ${err}`)
      return []
    }
  })

  ipcMain.handle('session:abort', async (_event, sessionId: string) => {
    const client = getClient()
    if (!client) return
    log('session', `Aborting ${sessionId}`)
    try { await client.session.abort({ path: { id: sessionId } }) } catch {}
  })

  ipcMain.handle('permission:respond', async (_event, permissionId: string, allowed: boolean) => {
    const client = getClient()
    if (!client) throw new Error('Runtime not started')

    const sessionId = permissionSessionMap.get(permissionId)
    if (!sessionId) throw new Error(`No session for permission ${permissionId}`)

    log('permission', `${allowed ? 'Approved' : 'Denied'} ${permissionId}`)
    await client.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionId },
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
}

const permissionSessionMap = new Map<string, string>()

export function trackPermission(permissionId: string, sessionId: string) {
  permissionSessionMap.set(permissionId, sessionId)
}
