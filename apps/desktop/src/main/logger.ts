import { createWriteStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getAppDataDir, getLogFilePrefix } from './config-loader.ts'
import { sanitizeLogMessage } from './log-sanitizer.ts'

let logPath: string | null = null
let logStream: ReturnType<typeof createWriteStream> | null = null
const LOG_RETENTION_DAYS = 14

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

export function log(category: string, message: string) {
  const ts = new Date().toISOString()
  const line = `[${ts}] [${category}] ${sanitizeLogMessage(message)}`
  console.log(line)
  try {
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
