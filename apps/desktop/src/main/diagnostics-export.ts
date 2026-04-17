import { closeSync, openSync, readSync, statSync } from 'fs'
import { getPublicAppConfig } from './config-loader.ts'
import { getLogFilePath } from './logger.ts'
import { getPerfSnapshot } from './perf-metrics.ts'
import { getRuntimeInputDiagnostics } from './runtime-input-diagnostics.ts'
import { getRuntimeStatus } from './runtime-status.ts'
import { getBundledOpencodeVersion } from './runtime-opencode-cli.ts'
import { maskEffectiveSettingsCredentials } from './settings.ts'
import { getEffectiveSettings } from './settings.ts'

// Number of log tail lines included in the bundle. Enough to cover a
// normal session's error window without bloating the text beyond what's
// reasonable to paste into a bug report.
const LOG_TAIL_LINES = 200
// Hard cap on the log tail byte count — defense-in-depth against a
// pathological log file. 512 KB is comfortably larger than
// LOG_TAIL_LINES * typical-line-length but still copy-paste friendly.
const LOG_TAIL_MAX_BYTES = 512 * 1024

function tailLogFile(path: string, lines: number, maxBytes: number): string {
  try {
    if (!path) return '(no log file configured)'
    const stat = statSync(path)
    const readBytes = Math.min(stat.size, maxBytes)
    // Read the tail without loading the whole file into memory.
    const buffer = Buffer.alloc(readBytes)
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buffer, 0, readBytes, Math.max(0, stat.size - readBytes))
    } finally {
      closeSync(fd)
    }
    const text = buffer.toString('utf-8')
    const split = text.split('\n')
    // Drop the first partial line if we started mid-line.
    const usable = stat.size > maxBytes ? split.slice(1) : split
    return usable.slice(-lines).join('\n')
  } catch (err) {
    return `(could not read log: ${(err as Error).message})`
  }
}

function section(title: string, body: string) {
  return `=== ${title} ===\n${body.trimEnd()}\n`
}

export function buildDiagnosticsBundle(): string {
  const now = new Date().toISOString()
  const config = getPublicAppConfig()
  const runtimeInputs = getRuntimeInputDiagnostics()
  const runtimeStatus = getRuntimeStatus()
  const perf = getPerfSnapshot()
  const settings = maskEffectiveSettingsCredentials(getEffectiveSettings())
  const logTail = tailLogFile(getLogFilePath(), LOG_TAIL_LINES, LOG_TAIL_MAX_BYTES)

  const header = [
    `${config.branding.name} diagnostics`,
    `Generated: ${now}`,
    `Branding: ${config.branding.name} (${config.branding.appId})`,
    `Platform: ${process.platform} ${process.arch} node ${process.version}`,
    `Electron: ${process.versions.electron || 'n/a'}`,
    `OpenCode CLI: ${getBundledOpencodeVersion() || 'n/a'}`,
    `Runtime ready: ${runtimeStatus.ready}${runtimeStatus.error ? ` (error: ${runtimeStatus.error})` : ''}`,
  ].join('\n')

  const parts = [
    section('Header', header),
    section('Effective Config (public, credentials redacted)', JSON.stringify(config, null, 2)),
    section('Effective Settings (credentials masked)', JSON.stringify(settings, null, 2)),
    section('Runtime Inputs', JSON.stringify(runtimeInputs, null, 2)),
    section('Perf Snapshot', JSON.stringify(perf, null, 2)),
    section(`Log Tail (last ${LOG_TAIL_LINES} lines, ${getLogFilePath()})`, logTail),
  ]

  return parts.join('\n')
}
