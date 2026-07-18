/**
 * Service-manager integration for the Gateway daemon.
 *
 * Owns the LaunchAgent/systemd user-unit definitions and the launchctl/systemctl
 * control paths so `opencode-gateway install|start|stop` and install.sh agree on
 * one supervision story:
 * - install writes the definition AND loads/starts it via the service manager.
 * - start/stop route through the service manager whenever the service is
 *   installed, so a supervised daemon stays stopped when stopped and is
 *   supervised (not a detached orphan) when started.
 * - restart policies only respawn on failure (KeepAlive SuccessfulExit=false,
 *   Restart=on-failure) with throttling, so a clean shutdown stays down and a
 *   crash loop (for example EADDRINUSE) cannot hot-loop.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

export const LAUNCHD_SERVICE_LABEL = 'com.opencode-gateway.daemon'
export const SYSTEMD_SERVICE_NAME = 'opencode-gateway'

export type ServiceManagerKind = 'launchd' | 'systemd' | 'none'

export interface ManagedServiceStatus {
  manager: ServiceManagerKind
  installed: boolean
  loaded: boolean
  serviceFilePath?: string
}

export interface ServiceControlResult {
  ok: boolean
  method: string
  detail?: string
}

export type CommandRunner = (command: string, args: string[], options?: { timeoutMs?: number; maxBuffer?: number }) => { status: number | null; stdout: string; stderr: string }

export const defaultRunner: CommandRunner = (command, args, options) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: options?.timeoutMs, maxBuffer: options?.maxBuffer })
  if (result.error) return { status: null, stdout: '', stderr: (result.error as Error).message }
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') }
}

export function serviceDefinitionPath(platform: NodeJS.Platform = process.platform, homeDir = os.homedir()): string | undefined {
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'LaunchAgents', `${LAUNCHD_SERVICE_LABEL}.plist`)
  if (platform === 'linux') return path.join(homeDir, '.config', 'systemd', 'user', `${SYSTEMD_SERVICE_NAME}.service`)
  return undefined
}

/**
 * Pure decision core for `opencode-gateway start|stop`:
 * - start goes through the service manager whenever the service is installed,
 *   even when currently unloaded, so the daemon comes back supervised.
 * - stop only goes through the service manager when the service is actually
 *   loaded; an installed-but-unloaded service means the daemon (if any) was
 *   started directly and the PID/HTTP path is the right stop lever.
 */
export function decideDaemonControl(input: { action: 'start' | 'stop'; manager: ServiceManagerKind; installed: boolean; loaded: boolean }): 'service_manager' | 'direct' {
  if (input.manager === 'none' || !input.installed) return 'direct'
  if (input.action === 'start') return 'service_manager'
  return input.loaded ? 'service_manager' : 'direct'
}

/**
 * A failed managed start whose failure indicates the user service manager
 * itself is unreachable (no systemd user bus in a container/SSH session, or a
 * missing launchctl/systemctl binary) — not a failure of the daemon. In that
 * case the anti-dual-instance rationale for refusing a direct start does not
 * hold: no real supervisor exists, so `opencode-gateway start` should fall
 * back to a direct spawn instead of hard-failing on a leftover unit file.
 */
export function isServiceManagerUnreachable(result: ServiceControlResult): boolean {
  if (result.ok) return false
  const detail = result.detail || ''
  if (/failed to connect to bus/i.test(detail)) return true
  if (/command not found|ENOENT|not found/i.test(detail)) return true
  // defaultRunner reports spawn failures as status null; the derived detail is
  // then `exit null` when the tool produced no stderr at all.
  if (/^exit null$/.test(detail)) return true
  return false
}

export function detectManagedService(options: {
  platform?: NodeJS.Platform
  homeDir?: string
  uid?: number
  runner?: CommandRunner
} = {}): ManagedServiceStatus {
  const platform = options.platform || process.platform
  const homeDir = options.homeDir || os.homedir()
  const runner = options.runner || defaultRunner
  const serviceFilePath = serviceDefinitionPath(platform, homeDir)
  if (!serviceFilePath) return { manager: 'none', installed: false, loaded: false }
  const manager: ServiceManagerKind = platform === 'darwin' ? 'launchd' : 'systemd'
  const installed = fs.existsSync(serviceFilePath)
  if (!installed) return { manager, installed, loaded: false, serviceFilePath }
  if (manager === 'launchd') {
    const uid = options.uid ?? process.getuid?.() ?? 0
    const print = runner('launchctl', ['print', `gui/${uid}/${LAUNCHD_SERVICE_LABEL}`])
    return { manager, installed, loaded: print.status === 0, serviceFilePath }
  }
  const active = runner('systemctl', ['--user', 'is-active', '--quiet', SYSTEMD_SERVICE_NAME])
  return { manager, installed, loaded: active.status === 0, serviceFilePath }
}

/** Stop a service-managed daemon so the service manager does not resurrect it. */
export function stopManagedService(status: ManagedServiceStatus, options: { uid?: number; runner?: CommandRunner } = {}): ServiceControlResult {
  const runner = options.runner || defaultRunner
  if (status.manager === 'launchd') {
    const uid = options.uid ?? process.getuid?.() ?? 0
    const bootout = runner('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_SERVICE_LABEL}`])
    if (bootout.status === 0) return { ok: true, method: `launchctl bootout gui/${uid}/${LAUNCHD_SERVICE_LABEL}` }
    const unload = runner('launchctl', ['unload', status.serviceFilePath || ''])
    if (unload.status === 0) return { ok: true, method: `launchctl unload ${status.serviceFilePath}` }
    return { ok: false, method: 'launchctl bootout/unload', detail: (bootout.stderr || unload.stderr || `exit ${bootout.status}`).trim() }
  }
  if (status.manager === 'systemd') {
    const stop = runner('systemctl', ['--user', 'stop', SYSTEMD_SERVICE_NAME])
    if (stop.status === 0) return { ok: true, method: `systemctl --user stop ${SYSTEMD_SERVICE_NAME}` }
    return { ok: false, method: `systemctl --user stop ${SYSTEMD_SERVICE_NAME}`, detail: (stop.stderr || `exit ${stop.status}`).trim() }
  }
  return { ok: false, method: 'none', detail: 'no service manager available on this platform' }
}

/** Start (and load if needed) the service-managed daemon. */
export function startManagedService(status: ManagedServiceStatus, options: { uid?: number; runner?: CommandRunner } = {}): ServiceControlResult {
  const runner = options.runner || defaultRunner
  if (status.manager === 'launchd') {
    const uid = options.uid ?? process.getuid?.() ?? 0
    const bootstrap = runner('launchctl', ['bootstrap', `gui/${uid}`, status.serviceFilePath || ''])
    if (bootstrap.status === 0) return { ok: true, method: `launchctl bootstrap gui/${uid} ${status.serviceFilePath}` }
    // Already bootstrapped (for example after a clean exit with SuccessfulExit=false): kickstart the loaded job.
    const kickstart = runner('launchctl', ['kickstart', `gui/${uid}/${LAUNCHD_SERVICE_LABEL}`])
    if (kickstart.status === 0) return { ok: true, method: `launchctl kickstart gui/${uid}/${LAUNCHD_SERVICE_LABEL}` }
    return { ok: false, method: 'launchctl bootstrap/kickstart', detail: (bootstrap.stderr || kickstart.stderr || `exit ${bootstrap.status}`).trim() }
  }
  if (status.manager === 'systemd') return runSystemdServiceVerb(runner, ['start'])
  return { ok: false, method: 'none', detail: 'no service manager available on this platform' }
}

/** Enable + start the systemd user unit after (re)writing it. */
export function enableSystemdService(options: { runner?: CommandRunner } = {}): ServiceControlResult {
  return runSystemdServiceVerb(options.runner || defaultRunner, ['enable', '--now'])
}

/** daemon-reload, then run one systemctl verb against the Gateway user unit. */
function runSystemdServiceVerb(runner: CommandRunner, verb: string[]): ServiceControlResult {
  const reload = runner('systemctl', ['--user', 'daemon-reload'])
  if (reload.status !== 0) {
    return {
      ok: false,
      method: 'systemctl --user daemon-reload',
      detail: (reload.stderr || `exit ${reload.status}`).trim(),
    }
  }
  const result = runner('systemctl', ['--user', ...verb, SYSTEMD_SERVICE_NAME])
  const method = `systemctl --user ${verb.join(' ')} ${SYSTEMD_SERVICE_NAME}`
  if (result.status === 0) return { ok: true, method }
  return { ok: false, method, detail: (result.stderr || `exit ${result.status}`).trim() }
}

export interface ServiceDefinitionInput {
  nodePath: string
  daemonScript: string
  workingDirectory: string
  environment: Record<string, string>
  logPath?: string
}

/**
 * LaunchAgent definition. Paths are resolved from the installed CLI's own
 * module location and the Gateway config dir — never from the install-time cwd
 * — so a moved repo or global install keeps working; rerunning
 * `opencode-gateway install` regenerates (heals) old definitions.
 * KeepAlive.SuccessfulExit=false means a clean shutdown (opencode-gateway stop,
 * POST /shutdown) stays stopped while crashes are respawned; ThrottleInterval
 * prevents a crash loop (for example EADDRINUSE) from hot-looping.
 */
export function buildLaunchdPlist(input: ServiceDefinitionInput): string {
  const environment = Object.entries(input.environment)
    .map(([key, value]) => `        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(value)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${escapeXml(input.nodePath)}</string>
        <string>${escapeXml(input.daemonScript)}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ExitTimeOut</key>
    <integer>30</integer>
    <key>WorkingDirectory</key>
    <string>${escapeXml(input.workingDirectory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
    <key>StandardOutPath</key>
    <string>${escapeXml(input.logPath || '')}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(input.logPath || '')}</string>
</dict>
</plist>`
}

/**
 * systemd user unit. Output goes to journald (no StandardOutput/StandardError
 * file redirection) so `journalctl --user -u opencode-gateway` works and
 * rotation is handled by journald. Restart=on-failure keeps a clean
 * `systemctl --user stop` / graceful shutdown stopped, and the start limit
 * stops an EADDRINUSE-style crash loop instead of restarting forever.
 */
export function buildSystemdUnit(input: ServiceDefinitionInput): string {
  const environment = Object.entries(input.environment)
    .map(([key, value]) => `Environment="${key}=${escapeSystemd(value)}"`)
    .join('\n')
  return `[Unit]
Description=OpenCode Gateway — OpenCode Work Coordinator
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${systemdQuote(input.nodePath)} ${systemdQuote(input.daemonScript)}
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
SyslogIdentifier=opencode-gateway
LogRateLimitIntervalSec=30s
LogRateLimitBurst=1000
WorkingDirectory=${systemdQuote(input.workingDirectory)}
${environment}

[Install]
WantedBy=default.target
`
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function escapeSystemd(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')
}

function systemdQuote(value: string): string {
  return `"${escapeSystemd(value)}"`
}
