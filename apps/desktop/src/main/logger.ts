import { app } from 'electron'
import { createWriteStream, mkdirSync } from 'fs'
import { join } from 'path'

let logPath: string | null = null
let logStream: ReturnType<typeof createWriteStream> | null = null

function getLogPath(): string {
  if (logPath) return logPath
  const dir = join(app.getPath('userData'), 'cowork', 'logs')
  mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().split('T')[0]
  logPath = join(dir, `cowork-${date}.log`)
  return logPath
}

function getStream(): ReturnType<typeof createWriteStream> {
  if (logStream) return logStream
  logStream = createWriteStream(getLogPath(), { flags: 'a' })
  return logStream
}

export function log(category: string, message: string) {
  const ts = new Date().toISOString()
  const line = `[${ts}] [${category}] ${message}`
  console.log(line)
  try {
    getStream().write(line + '\n')
  } catch {}
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
