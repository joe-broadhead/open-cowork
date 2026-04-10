import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'

interface TelemetryEvent {
  ts: string
  event: string
  data?: Record<string, unknown>
}

let telemetryPath: string | null = null

function getPath(): string {
  if (telemetryPath) return telemetryPath
  const dir = join(app.getPath('userData'), 'cowork', 'telemetry')
  mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().split('T')[0]
  telemetryPath = join(dir, `events-${date}.ndjson`)
  return telemetryPath
}

export function trackEvent(event: string, data?: Record<string, unknown>) {
  const entry: TelemetryEvent = {
    ts: new Date().toISOString(),
    event,
    ...(data ? { data } : {}),
  }
  try {
    appendFileSync(getPath(), JSON.stringify(entry) + '\n')
  } catch {}
}

// Pre-built event helpers
export const telemetry = {
  sessionCreated: (sessionId: string) =>
    trackEvent('session.created', { sessionId }),

  sessionDeleted: (sessionId: string) =>
    trackEvent('session.deleted', { sessionId }),

  promptSent: (sessionId: string, textLength: number, attachments: number) =>
    trackEvent('prompt.sent', { sessionId, textLength, attachments }),

  responseCompleted: (sessionId: string, cost: number, tokens: Record<string, number>) =>
    trackEvent('response.completed', { sessionId, cost, ...tokens }),

  skillLoaded: (skillName: string) =>
    trackEvent('skill.loaded', { skillName }),

  toolUsed: (toolName: string, status: string) =>
    trackEvent('tool.used', { toolName, status }),

  pluginInstalled: (pluginId: string) =>
    trackEvent('plugin.installed', { pluginId }),

  pluginUninstalled: (pluginId: string) =>
    trackEvent('plugin.uninstalled', { pluginId }),

  mcpConnected: (mcpName: string) =>
    trackEvent('mcp.connected', { mcpName }),

  authLogin: (email: string) =>
    trackEvent('auth.login', { email }),

  appLaunched: () =>
    trackEvent('app.launched'),

  sessionExported: (sessionId: string) =>
    trackEvent('session.exported', { sessionId }),

  errorOccurred: (error: string, context?: string) =>
    trackEvent('error', { error: error.slice(0, 200), context }),
}
