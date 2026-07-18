/**
 * Event queue for heartbeat logging and dashboard replay.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getConfig, getConfigDir } from './config.js'
import { redactSensitiveText } from './security.js'

let queuedEvents: string[] = []
let loaded = false
// events.json is a bounded operational-telemetry sidecar. Rewriting the whole
// file on every queued line makes a busy channel session issue hundreds of
// synchronous filesystem writes per minute, so persistence is throttled: the
// in-memory queue stays authoritative and the file is rewritten at most once
// per interval, with skipped lines flushed by the next write. A hard crash can
// lose at most the last interval of telemetry lines, which is acceptable for
// this sidecar (durable workflow events live in SQLite).
const SAVE_MIN_INTERVAL_MS = 1000
let lastSaveMs = 0

function eventStorePath(): string {
  return path.join(process.env['OPENCODE_GATEWAY_STATE_DIR'] || getConfigDir(), 'events.json')
}

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  try {
    const parsed = JSON.parse(fs.readFileSync(eventStorePath(), 'utf-8'))
    queuedEvents = Array.isArray(parsed?.events) ? parsed.events.filter((e: any) => typeof e === 'string').slice(-100) : []
  } catch {}
}

function saveEvents(): void {
  let tmp = ''
  try {
    const file = eventStorePath()
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(dir, 0o700) } catch {}
    tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), events: queuedEvents }, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
    try { fs.chmodSync(file, 0o600) } catch {}
  } catch {
    if (tmp) try { fs.rmSync(tmp, { force: true }) } catch {}
  }
}

export function queueEvent(event: string): void {
  ensureLoaded()
  queuedEvents.push(`${new Date().toISOString()}: ${sanitizeEvent(event)}`)
  if (queuedEvents.length > 100) queuedEvents.shift()
  const now = Date.now()
  if (now - lastSaveMs < SAVE_MIN_INTERVAL_MS) return
  lastSaveMs = now
  saveEvents()
}

function sanitizeEvent(event: string): string {
  try {
    return redactSensitiveText(String(event || ''), getConfig()).substring(0, 1000)
  } catch {
    return redactSensitiveText(String(event || '')).substring(0, 1000)
  }
}

export function getQueuedEvents(): string[] {
  ensureLoaded()
  return [...queuedEvents]
}

export function clearEventsForTest(): void {
  loaded = false
  queuedEvents = []
  lastSaveMs = 0
}
