import { app } from 'electron'
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { sanitizeLogMessage } from './log-sanitizer'

let telemetryPath: string | null = null
const TELEMETRY_RETENTION_DAYS = 14

function pruneOldTelemetry(dir: string) {
  const cutoff = Date.now() - TELEMETRY_RETENTION_DAYS * 24 * 60 * 60 * 1000
  for (const file of readdirSync(dir)) {
    if (!/^events-\d{4}-\d{2}-\d{2}\.ndjson$/.test(file)) continue
    const path = join(dir, file)
    try {
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path)
      }
    } catch {}
  }
}

function getPath(): string {
  if (telemetryPath) return telemetryPath
  const dir = join(app.getPath('userData'), 'cowork', 'telemetry')
  mkdirSync(dir, { recursive: true })
  pruneOldTelemetry(dir)
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
  authLogin: () => trackEvent('auth.login'),
  sessionCreated: () => trackEvent('session.created'),
  errorOccurred: (error: string) => trackEvent('error', { error: sanitizeLogMessage(error).slice(0, 200) }),
}
