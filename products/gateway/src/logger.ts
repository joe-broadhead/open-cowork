/**
 * Structured, leveled logger for the Gateway daemon's own process log stream.
 *
 * The durable event model already carries correlation/trace ids, but the process
 * log stream was 400+ raw `console.*` calls with no levels, timestamps, or JSON
 * option. This module is the standard log substrate: every line carries an ISO
 * timestamp, a level, an optional component, and optional structured fields
 * (including correlationId/traceId threaded from the durable model). Output is a
 * timestamped human-readable line by default, or newline-delimited JSON when
 * `GATEWAY_LOG_FORMAT=json`. All rendered text and every string field value is
 * routed through the existing secret-redaction helper so secrets never reach the
 * console or the service-log file.
 */
import type { GatewayConfig } from './config.js'
import { getConfig } from './config.js'
import { redactSensitiveText } from './security.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LogFields {
  component?: string
  correlationId?: string
  traceId?: string
  [key: string]: unknown
}

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  child(fields: LogFields): Logger
}

type LogSink = (line: string) => void

const defaultSink: LogSink = line => { try { process.stderr.write(line + '\n') } catch {} }
let sink: LogSink = defaultSink

/** Redirect log output for tests; pass null to restore the stderr sink. */
export function __setLogSinkForTest(next: LogSink | null): void {
  sink = next || defaultSink
}

function configuredLevel(): LogLevel {
  const raw = String(process.env['GATEWAY_LOG_LEVEL'] || '').toLowerCase()
  return (raw in LEVEL_WEIGHT ? raw : 'info') as LogLevel
}

function jsonFormatEnabled(): boolean {
  return String(process.env['GATEWAY_LOG_FORMAT'] || '').toLowerCase() === 'json'
}

function safeConfig(): GatewayConfig | undefined {
  try { return getConfig() } catch { return undefined }
}

function redact(value: string): string {
  const text = String(value ?? '')
  try { return redactSensitiveText(text, safeConfig()) } catch { return text }
}

function renderFieldValue(value: unknown): string {
  if (typeof value === 'string') return redact(value)
  if (value === null) return 'null'
  if (typeof value === 'object') { try { return redact(JSON.stringify(value)) } catch { return '[unserializable]' } }
  return String(value)
}

/**
 * Recursively produce a redaction-safe, JSON-serializable copy of a field value:
 * every string (at any depth) is routed through the redactor, cycles are broken
 * with a marker, and BigInt is stringified. This gives JSON mode the same "no
 * secret survives" guarantee as human mode (which redacts `JSON.stringify(value)`)
 * without embedding nested objects raw or throwing on non-serializable input.
 */
function deepRedact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redact(value)
  if (typeof value === 'bigint') return redact(value.toString())
  if (value === null || typeof value !== 'object') {
    // number/boolean pass through; undefined/function/symbol are dropped by JSON.stringify.
    return value
  }
  if (value instanceof Date) return value.toISOString()
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(entry => deepRedact(entry, seen))
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = deepRedact(entry, seen)
  }
  return out
}

/** Render a single log line. Exported so tests can assert format without a sink. */
export function formatLogLine(level: LogLevel, message: string, fields: LogFields = {}, now: Date = new Date()): string {
  const ts = now.toISOString()
  const { component, ...rest } = fields
  const safeMessage = redact(message)
  if (jsonFormatEnabled()) {
    const base: Record<string, unknown> = { ts, level, ...(component ? { component } : {}), message: safeMessage }
    try {
      const record: Record<string, unknown> = { ...base }
      for (const [key, value] of Object.entries(rest)) {
        if (value === undefined) continue
        // Deep-redact ALL field values (nested strings included) so a secret one
        // level down cannot reach the log, matching human mode's guarantee.
        record[key] = deepRedact(value)
      }
      return JSON.stringify(record)
    } catch {
      // A log call must NEVER throw: fall back to a valid, secret-free JSON line.
      return JSON.stringify({ ...base, fields: '[unserializable]' })
    }
  }
  const parts = [ts, level.toUpperCase()]
  if (component) parts.push(`[${component}]`)
  parts.push(safeMessage)
  const kv: string[] = []
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue
    kv.push(`${key}=${renderFieldValue(value)}`)
  }
  if (kv.length) parts.push(kv.join(' '))
  return parts.join(' ')
}

export function logAt(level: LogLevel, message: string, fields?: LogFields): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[configuredLevel()]) return
  sink(formatLogLine(level, message, fields || {}))
}

/** Create a logger with a fixed set of base fields (e.g. a component name). */
export function createLogger(base: LogFields = {}): Logger {
  const emit = (level: LogLevel, message: string, fields?: LogFields) =>
    logAt(level, message, { ...base, ...(fields || {}) })
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: fields => createLogger({ ...base, ...fields }),
  }
}

/** Shared root logger. Prefer a component child in each module. */
export const logger = createLogger()
