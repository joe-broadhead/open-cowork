import type { BrowserWindow } from 'electron'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

import { getMcpStatus } from './events.ts'
import { log } from './logger.ts'
import { createStartupMcpRecovery } from './runtime-mcp-recovery.ts'

export function restartRuntimeMcpStatusPolling(options: {
  client: OpencodeClient
  runtimeProjectDirectory: string | null
  currentInterval: NodeJS.Timeout | null
  getMainWindow: () => BrowserWindow | null
  scheduleReconnect: () => void
  intervalMs?: number
}) {
  const {
    recoverDisconnectedGoogleAuthMcps,
    recoverFailedLocalMcps,
  } = createStartupMcpRecovery({
    client: options.client,
    runtimeProjectDirectory: options.runtimeProjectDirectory,
  })

  const pollMcp = async () => {
    try {
      const statuses = await getMcpStatus(options.client)
      await recoverDisconnectedGoogleAuthMcps(statuses)
      await recoverFailedLocalMcps(statuses)
      const currentWindow = options.getMainWindow()
      if (currentWindow && !currentWindow.isDestroyed()) {
        currentWindow.webContents.send('mcp:status', statuses)
      }
    } catch (err: unknown) {
      log('error', `MCP status poll failed: ${err instanceof Error ? err.message : String(err)}`)
      options.scheduleReconnect()
    }
  }

  // Kick off the first MCP poll right away so the home page's MCP pill
  // populates on first paint instead of waiting for the recurring tick.
  void pollMcp()
  if (options.currentInterval) clearInterval(options.currentInterval)
  return setInterval(pollMcp, options.intervalMs ?? 10_000)
}
