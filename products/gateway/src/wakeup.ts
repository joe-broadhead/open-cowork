/**
 * Event queue for heartbeat logging and dashboard replay.
 *
 * JOE-996 / H3: authoritative persistence is operational-sidecar.sqlite
 * (not events.json). Legacy events.json is imported once on first open.
 */
import { getConfig } from './config.js'
import { redactSensitiveText } from './security.js'
import {
  loadOperationalEvents,
  operationalSidecarPath,
  replaceOperationalEvents,
} from './operational-sidecar-store.js'

let queuedEvents: string[] = []
let loaded = false
// operational_events is bounded telemetry. Rewriting SQLite on every queued
// line under a busy channel would thrash the DB, so persistence is throttled:
// the in-memory queue stays authoritative and the store is flushed at most once
// per interval. A hard crash can lose at most the last interval of telemetry
// lines, which is acceptable (durable workflow events live in gateway.db).
const SAVE_MIN_INTERVAL_MS = 1000
let lastSaveMs = 0

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  try {
    queuedEvents = loadOperationalEvents()
  } catch {
    queuedEvents = []
  }
}

function saveEvents(): void {
  try {
    replaceOperationalEvents(queuedEvents)
  } catch {
    // Best-effort operational telemetry — do not take down the daemon.
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
  // Memory only — persist/reload tests call getQueuedEvents after clear.
  loaded = false
  queuedEvents = []
  lastSaveMs = 0
}

/** Path of the durable operational sidecar (tests / diagnostics). */
export function operationalEventsStorePath(): string {
  return operationalSidecarPath()
}

export function flushQueuedEventsForTest(): void {
  ensureLoaded()
  lastSaveMs = 0
  saveEvents()
}
