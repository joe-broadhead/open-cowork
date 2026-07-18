import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getConfig, type GatewayConfig } from './config.js'
import { redactSensitiveText } from './security.js'
import { defaultRunner, type CommandRunner } from './service-manager.js'

export const SERVICE_LOG_MAX_BYTES = 10 * 1024 * 1024
export const SERVICE_LOG_KEEP = 5

export function serviceLogPath(): string {
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Logs', 'opencode-gateway.log')
    : path.join(os.homedir(), '.local', 'share', 'opencode-gateway.log')
}

export function serviceLogCandidates(): string[] {
  return [
    path.join(os.homedir(), 'Library', 'Logs', 'opencode-gateway.log'),
    path.join(os.homedir(), '.local', 'share', 'opencode-gateway.log'),
  ]
}

/**
 * Size-based copy-truncate rotation for the daemon's own service log file.
 *
 * launchd (and `opencode-gateway start`) append to a plain file with no
 * platform rotation, so the daemon rotates it itself: at boot and on a periodic
 * size check it shifts `log.1..log.N` and copies+truncates the live file, which
 * keeps supervisor-held append file descriptors valid. On Linux the systemd
 * unit logs to journald (which rotates natively); this helper is then a no-op
 * unless a legacy file log exists.
 */
export function rotateServiceLogIfNeeded(options: { file?: string; maxBytes?: number; keep?: number } = {}): { rotated: boolean; file: string; size: number } {
  const file = options.file || serviceLogPath()
  const maxBytes = options.maxBytes ?? SERVICE_LOG_MAX_BYTES
  const keep = Math.max(1, options.keep ?? SERVICE_LOG_KEEP)
  let size = 0
  try {
    size = fs.statSync(file).size
  } catch {
    return { rotated: false, file, size: 0 }
  }
  if (size < maxBytes) return { rotated: false, file, size }
  try {
    for (let index = keep - 1; index >= 1; index--) {
      const from = `${file}.${index}`
      if (fs.existsSync(from)) fs.renameSync(from, `${file}.${index + 1}`)
    }
    fs.copyFileSync(file, `${file}.1`)
    fs.truncateSync(file, 0)
  } catch {
    return { rotated: false, file, size }
  }
  return { rotated: true, file, size }
}

/**
 * Read recent daemon lines from journald (Linux systemd user unit). Returns
 * undefined when journalctl is unavailable or the unit has no journal entries,
 * so callers can fall back to legacy file logs.
 */
export function readJournaldLogLines(lines: number, options: { runner?: CommandRunner } = {}): string[] | undefined {
  const runner = options.runner || defaultRunner
  // The daemon's GET /logs route reaches this synchronous read: bound it so a
  // wedged journald (D-state journalctl) cannot hang the event loop, and fall
  // back to file logs via the undefined return.
  const result = runner('journalctl', ['--user', '-u', 'opencode-gateway', '-n', String(Math.max(1, Math.min(lines, 1000))), '--no-pager', '--output=cat'], { timeoutMs: 2000, maxBuffer: 4 * 1024 * 1024 })
  if (result.status !== 0) return undefined
  const rows = String(result.stdout || '').split('\n').filter(Boolean)
  return rows.length ? rows : undefined
}

export function readGatewayLogLines(lines: number, options: { files?: string[]; config?: GatewayConfig; platform?: NodeJS.Platform } = {}): string[] {
  const safeLines = Math.max(1, Math.min(lines, 1000))
  const platform = options.platform || process.platform
  // Linux service-managed daemons log to journald (see buildSystemdUnit);
  // prefer it and fall back to legacy/CLI-start file logs.
  if (platform === 'linux' && !options.files) {
    const journal = readJournaldLogLines(safeLines)
    if (journal) {
      const config = options.config || getConfig()
      return journal.slice(-safeLines).map(line => redactSensitiveText(line, config))
    }
  }
  const file = (options.files || serviceLogCandidates()).find(candidate => fs.existsSync(candidate))
  if (!file) return []
  const stat = fs.statSync(file)
  const start = Math.max(0, stat.size - 128 * 1024)
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    const config = options.config || getConfig()
    return buffer.toString('utf-8').split('\n').filter(Boolean).slice(-safeLines).map(line => redactSensitiveText(line, config))
  } finally {
    fs.closeSync(fd)
  }
}
