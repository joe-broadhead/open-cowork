import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getAppDataDir, getTelemetryConfig } from './config-loader.ts'
import { sanitizeLogMessage } from './log-sanitizer.ts'

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
    } catch {
      // Ignore telemetry-prune races and continue scanning other files.
    }
  }
}

function getPath(): string {
  if (telemetryPath) return telemetryPath
  const dir = join(getAppDataDir(), 'telemetry')
  mkdirSync(dir, { recursive: true })
  pruneOldTelemetry(dir)
  const date = new Date().toISOString().split('T')[0]
  telemetryPath = join(dir, `events-${date}.ndjson`)
  return telemetryPath
}

// Optional remote forwarder. Downstream forks that want their own
// telemetry sink (PostHog, Mixpanel, an internal collector) set
// `telemetry.endpoint` in `open-cowork.config.json`; we POST each
// event as JSON, fire-and-forget, with a short timeout. Failures
// are silent — local NDJSON stays the source of truth. Upstream
// builds leave `endpoint` unset and never reach out over the
// network.
const REMOTE_TIMEOUT_MS = 2000

async function forwardRemote(payload: Record<string, unknown>) {
  const config = getTelemetryConfig()
  if (!config?.enabled || !config?.endpoint) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS)
  try {
    await fetch(config.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.headers || {}),
      },
      body: JSON.stringify(payload),
    })
  } catch {
    // Network / timeout / DNS failures must never take down the app.
  } finally {
    clearTimeout(timer)
  }
}

function trackEvent(event: string, data?: Record<string, unknown>) {
  const payload = { ts: new Date().toISOString(), event, ...(data ? { data } : {}) }
  try {
    appendFileSync(getPath(), JSON.stringify(payload) + '\n')
  } catch {
    // Telemetry is best-effort only.
  }
  // Remote fan-out runs in the background; never blocks the caller.
  void forwardRemote(payload)
}

export const telemetry = {
  appLaunched: () => trackEvent('app.launched'),
  authLogin: () => trackEvent('auth.login'),
  sessionCreated: () => trackEvent('session.created'),
  errorOccurred: (error: string) => trackEvent('error', { error: sanitizeLogMessage(error).slice(0, 200) }),
  perfSlow: (metric: string, valueMs: number, data?: Record<string, unknown>) => trackEvent('perf.slow', {
    metric: sanitizeLogMessage(metric).slice(0, 120),
    valueMs: Math.round(valueMs * 100) / 100,
    ...(data ? { data } : {}),
  }),
}
