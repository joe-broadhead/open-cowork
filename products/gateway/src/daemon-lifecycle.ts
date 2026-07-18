/**
 * Daemon process lifecycle coordination.
 *
 * The daemon registers a graceful-shutdown handler at boot; HTTP routes
 * (/shutdown, /restart) and CLI signal fallbacks request shutdown through this
 * module instead of calling process.exit() directly, so timers, channels, the
 * HTTP server, and the writer leadership lease are always released.
 */

import * as fs from 'node:fs'
import { spawnSync } from 'node:child_process'

export interface DaemonShutdownRequest {
  reason: string
  exitCode?: number
}

type DaemonShutdownHandler = (request: DaemonShutdownRequest) => void

let shutdownHandler: DaemonShutdownHandler | null = null

export function registerDaemonShutdownHandler(handler: DaemonShutdownHandler | null): void {
  shutdownHandler = handler
}

/**
 * Ask the running daemon to shut down gracefully. serve() registers the
 * graceful handler before the HTTP server can dispatch any request, so a
 * registered handler is always present by the time /shutdown or /restart
 * (or a CLI signal fallback) reaches this function.
 */
export function requestDaemonShutdown(request: DaemonShutdownRequest): void {
  shutdownHandler?.(request)
}

/** Remove the PID file written by `opencode-gateway start` when it records this process. */
export function removeOwnedPidFile(pid = process.pid, pidFile = process.env['OPENCODE_GATEWAY_PIDFILE']): void {
  if (!pidFile) return
  try {
    const recorded = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
    if (recorded === pid) fs.rmSync(pidFile, { force: true })
  } catch {}
}

/** Read the command line of a live process, or undefined when it cannot be resolved. */
export function readProcessCommand(pid: number): string | undefined {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  if (result.status !== 0) return undefined
  const command = String(result.stdout || '').trim()
  return command || undefined
}

/**
 * Heuristic guard for `opencode-gateway stop`: only signal a PID whose command
 * line plausibly belongs to a Gateway daemon, so a recycled PID from a stale
 * PID file never receives SIGTERM. `knownDaemonScript` lets the CLI accept the
 * exact daemon entry point it spawns itself, even when that path contains no
 * "gateway" token (for example a checkout at ~/src/ocg/dist/daemon.js).
 */
export function commandLooksLikeGatewayDaemon(command: string, knownDaemonScript?: string): boolean {
  const text = String(command || '')
  if (knownDaemonScript && text.includes(knownDaemonScript)) return true
  if (text.includes('opencode-gateway')) return true
  return /daemon\.(js|ts)\b/.test(text) && /gateway/i.test(text)
}
