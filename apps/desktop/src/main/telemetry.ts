import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'

let telemetryPath: string | null = null

function getPath(): string {
  if (telemetryPath) return telemetryPath
  const dir = join(app.getPath('userData'), 'cowork', 'telemetry')
  mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().split('T')[0]
  telemetryPath = join(dir, `events-${date}.ndjson`)
  return telemetryPath
}

function trackEvent(event: string, data?: Record<string, unknown>) {
  try {
    appendFileSync(getPath(), JSON.stringify({ ts: new Date().toISOString(), event, ...(data ? { data } : {}) }) + '\n')
  } catch {}
}

export const telemetry = {
  appLaunched: () => trackEvent('app.launched'),
  authLogin: (email: string) => trackEvent('auth.login', { email }),
  sessionCreated: (sessionId: string) => trackEvent('session.created', { sessionId }),
  errorOccurred: (error: string) => trackEvent('error', { error: error.slice(0, 200) }),
}
