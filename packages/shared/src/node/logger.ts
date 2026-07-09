/// <reference types="node" />
// Shared logger core: dual-channel (stdout + rotating file) logging with secret
// sanitization, used by the Electron main process and the cloud server. The log
// destination (data directory + brand file prefix) is INJECTED via
// `setLogStorage` rather than imported, so this module carries no config-loader /
// Electron dependency. The desktop wires the resolver in
// `apps/desktop/src/main/logger.ts`; the resolver is invoked lazily (on the first
// file write), so timing is identical to the pre-extraction logger.
import { createWriteStream, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sanitizeLogMessage } from '../log-sanitizer.js'

let logPath: string | null = null
let logStream: ReturnType<typeof createWriteStream> | null = null
const LOG_RETENTION_DAYS = 14
const LOG_MAX_TOTAL_BYTES = 512 * 1024 * 1024 // 512 MB
// Per-file rotation cap. A streaming LLM chat can generate tens of MB
// of debug chatter in a day; without a cap, a user who leaves the app
// open for a week can fill their disk. On rotation we bump the current
// file to `<name>.1` and start fresh — simple one-deep rotation, no
// accumulation beyond the retention window and total-size cap.
const LOG_ROTATE_BYTES = 100 * 1024 * 1024 // 100 MB

export type LogStorage = { directory: string; filePrefix: string }
let logStorageResolver: (() => LogStorage) | null = null

// Inject the log destination. Called once, early, by the host (desktop main or
// cloud entry) — before any importer's first log() call. Resetting the cached
// path lets a later (re)configuration take effect on the next write.
export function setLogStorage(resolver: () => LogStorage) {
  logStorageResolver = resolver
  logPath = null
}

function resolveStorage(): LogStorage {
  if (logStorageResolver) return logStorageResolver()
  // Unconfigured fallback (should not happen in normal startup): keep logging
  // best-effort to a temp location rather than crashing on a missing resolver.
  return { directory: join(tmpdir(), 'open-cowork'), filePrefix: 'open-cowork' }
}

interface LogPruneOptions {
  nowMs?: number
  retentionDays?: number
  maxTotalBytes?: number
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isKnownLogFile(file: string) {
  const prefixes = Array.from(new Set([resolveStorage().filePrefix, 'open-cowork']))
  return prefixes.some((prefix) => new RegExp(`^${escapeRegex(prefix)}-\\d{4}-\\d{2}-\\d{2}\\.log(?:\\.\\d+)?$`).test(file))
}

export function pruneLogDirectory(dir: string, options: LogPruneOptions = {}) {
  const nowMs = options.nowMs ?? Date.now()
  const retentionDays = options.retentionDays ?? LOG_RETENTION_DAYS
  const maxTotalBytes = options.maxTotalBytes ?? LOG_MAX_TOTAL_BYTES
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000
  const retained: Array<{ file: string; path: string; mtimeMs: number; size: number }> = []

  for (const file of readdirSync(dir)) {
    if (!isKnownLogFile(file)) continue
    const path = join(dir, file)
    try {
      const stat = statSync(path)
      if (!stat.isFile()) continue
      if (stat.mtimeMs < cutoff) {
        unlinkSync(path)
      } else {
        retained.push({ file, path, mtimeMs: stat.mtimeMs, size: stat.size })
      }
    } catch {
      // Ignore log-prune races and continue scanning other files.
    }
  }

  if (!Number.isFinite(maxTotalBytes) || maxTotalBytes < 0) return

  retained.sort((a, b) => {
    const mtimeCompare = b.mtimeMs - a.mtimeMs
    return mtimeCompare || a.file.localeCompare(b.file)
  })

  let total = 0
  for (const entry of retained) {
    total += entry.size
    if (total <= maxTotalBytes) continue
    try {
      unlinkSync(entry.path)
    } catch {
      // Ignore log-prune races and continue enforcing the cap.
    }
  }
}

function getLogPath(): string {
  if (logPath) return logPath
  const storage = resolveStorage()
  const dir = join(storage.directory, 'logs')
  mkdirSync(dir, { recursive: true })
  pruneLogDirectory(dir)
  const date = new Date().toISOString().split('T')[0]
  logPath = join(dir, `${storage.filePrefix}-${date}.log`)
  return logPath
}

function getStream(): ReturnType<typeof createWriteStream> {
  if (logStream) return logStream
  logStream = createWriteStream(getLogPath(), { flags: 'a' })
  logStream.on('error', () => {
    // File stream errors are asynchronous, so the log() try/catch cannot
    // catch them. Logging must remain best-effort even if a test or app
    // cleanup removes the log directory after the stream is created.
  })
  return logStream
}

function rotateIfOversized() {
  const path = getLogPath()
  try {
    const size = statSync(path).size
    if (size < LOG_ROTATE_BYTES) return
    if (logStream) {
      logStream.end()
      logStream = null
    }
    // One-deep rotation: drop the previous archive if it exists,
    // then bump the current log aside. No growing tail of .1/.2/.3
    // files — the 14-day retention window is the only accumulation
    // bound, which is plenty for a desktop app.
    const archive = `${path}.1`
    try { unlinkSync(archive) } catch { /* no prior archive */ }
    renameSync(path, archive)
  } catch {
    // stat/rename races are benign — the worst outcome is one log
    // line written to the "old" file right after rotation.
  }
}

// Optional structured-log format for enterprise SIEM ingestion. Flip
// via `OPEN_COWORK_LOG_FORMAT=json` — default stays text so local
// debugging `tail -F` the log file stays human-readable. The flag is
// read once at module load; no hot-reload needed for a deploy-time
// preference.
const USE_JSON = process.env.OPEN_COWORK_LOG_FORMAT?.toLowerCase() === 'json'

function formatLine(ts: string, category: string, message: string): string {
  const sanitized = sanitizeLogMessage(message)
  if (USE_JSON) {
    // Hand-serialize rather than JSON.stringify({...}) so we can trust
    // the key order (timestamp first is a SIEM-friendly convention)
    // and sidestep any unexpected object in the category/message path.
    return JSON.stringify({ ts, level: category, message: sanitized })
  }
  return `[${ts}] [${category}] ${sanitized}`
}

export function log(category: string, message: string) {
  const ts = new Date().toISOString()
  const line = formatLine(ts, category, message)
  // Dual-channel by design: stdout for the dev terminal (live tailing
  // while debugging) and the log file for post-hoc triage. Both feeds
  // go through `formatLine` so they're sanitized identically — no
  // bare prompts, API keys, or home paths either way.
  console.log(line)
  try {
    rotateIfOversized()
    getStream().write(line + '\n')
  } catch {
    // Logging failures must never take down the app.
  }
}

export function getLogFilePath(): string {
  return getLogPath()
}

export function closeLogger() {
  if (logStream) {
    const stream = logStream
    logStream = null
    logPath = null
    return new Promise<void>((resolve) => {
      stream.end(resolve)
    })
  }
  logPath = null
  return Promise.resolve()
}
