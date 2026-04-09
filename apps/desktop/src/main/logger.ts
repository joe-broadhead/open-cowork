import { app } from 'electron'
import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

let logPath: string | null = null

function getLogPath(): string {
  if (logPath) return logPath
  const dir = join(app.getPath('userData'), 'cowork', 'logs')
  mkdirSync(dir, { recursive: true })
  const date = new Date().toISOString().split('T')[0]
  logPath = join(dir, `cowork-${date}.log`)
  return logPath
}

export function log(category: string, message: string) {
  const ts = new Date().toISOString()
  const line = `[${ts}] [${category}] ${message}`
  console.log(line)
  try {
    appendFileSync(getLogPath(), line + '\n')
  } catch {}
}

export function getLogFilePath(): string {
  return getLogPath()
}
