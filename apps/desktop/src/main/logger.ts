import { createWriteStream, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getAppDataDir, getLogFilePrefix } from './config-loader.ts'
import { sanitizeLogMessage } from './log-sanitizer.ts'

let logPath: string | null = null
let logStream: ReturnType<typeof createWriteStream> | null = null
const LOG_RETENTION_DAYS = 14
// Per-file rotation cap. A streaming LLM chat can generate tens of MB
// of debug chatter in a day; without a cap, a user who leaves the app
// open for a week can fill their disk. On rotation we bump the current
// file to `<name>.1` and start fresh — simple one-deep rotation, no
// accumulation beyond the retention window.
const LOG_ROTATE_BYTES = 100 * 1024 * 1024 // 100 MB

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isKnownLogFile(file: string) {
  const prefixes = Array.from(new Set([getLogFilePrefix(), 'cowork', 'open-cowork']))
  return prefixes.some((prefix) => new RegExp(`^${escapeRegex(prefix)}-\\d{4}-\\d{2}-\\d{2}\\.log$`).test(file))
}

function pruneOldLogs(dir: string) {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
  for (const file of readdirSync(dir)) {
    if (!isKnownLogFile(file)) continue
    const path = join(dir, file)
    try {
      if (statSync(path).mtimeMs < cutoff) {
        unlinkSync(path)
      }
    } catch {
      // Ignore log-prune races and continue scanning other files.
    }
  }
}

function getLogPath(): string {
  if (logPath) return logPath
  const dir = join(getAppDataDir(), 'logs')
  mkdirSync(dir, { recursive: true })
  pruneOldLogs(dir)
  const date = new Date().toISOString().split('T')[0]
  logPath = join(dir, `${getLogFilePrefix()}-${date}.log`)
  return logPath
}

function getStream(): ReturnType<typeof createWriteStream> {
  if (logStream) return logStream
  logStream = createWriteStream(getLogPath(), { flags: 'a' })
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

export function log(category: string, message: string) {
  const ts = new Date().toISOString()
  const line = `[${ts}] [${category}] ${sanitizeLogMessage(message)}`
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
    logStream.end()
    logStream = null
  }
}
