import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { getConfig, getConfigDir } from '../../config.js'
import type { GatewayConfig } from '../../config.js'
import {
  LAUNCHD_SERVICE_LABEL as LAUNCHD_LABEL,
  SYSTEMD_SERVICE_NAME,
  buildLaunchdPlist,
  buildSystemdUnit,
  decideDaemonControl,
  detectManagedService,
  enableSystemdService,
  isServiceManagerUnreachable,
  startManagedService,
  stopManagedService,
} from '../../service-manager.js'
import { ensureLocalHttpAdminTokenFile, gatewayServiceEnvironment, redactSensitiveText } from '../../security.js'
import { commandLooksLikeGatewayDaemon, readProcessCommand } from '../../daemon-lifecycle.js'
import { formatTaskCounts } from '../../task-summary.js'
import { serviceLogPath } from '../../service-logs.js'
import {
  assertConfigured,
  fetchGatewayJson,
  formatObservabilityStatusLine,
  gatewayFetch,
  normalizeServiceHealthReport,
} from '../shared.js'

export async function start(options: { progressToStderr?: boolean } = {}) {
  assertConfigured('start')
  const config = getConfig()
  // In `--json` callers (quickstart --json) human progress must not corrupt the
  // machine-readable object on stdout, so route it to stderr.
  const log = options.progressToStderr ? (...args: unknown[]) => console.error(...args) : (...args: unknown[]) => console.log(...args)

  // Check if already running
  try {
    const res = await gatewayFetch('/health')
    if (res.ok) {
      log('Gateway is already running.')
      return
    }
  } catch {}

  // When the service is installed (LaunchAgent/systemd user unit), start through
  // the service manager so the daemon runs supervised instead of as a detached
  // orphan that a login-time service instance would later collide with.
  const service = detectManagedService()
  if (decideDaemonControl({ action: 'start', ...service }) === 'service_manager') {
    const result = startManagedService(service)
    if (result.ok) {
      log(`Gateway daemon starting via ${result.method}`)
      log(`Logs: ${service.manager === 'systemd' ? `journalctl --user -u ${SYSTEMD_SERVICE_NAME}` : serviceLogPath()}`)
      log()
      await waitForDaemonHealth(config, log)
      return
    }
    console.error(`Service-manager start failed (${result.method}): ${result.detail || 'unknown error'}`)
    if (!isServiceManagerUnreachable(result)) {
      console.error(service.manager === 'launchd'
        ? `Start manually: launchctl bootstrap gui/$(id -u) ${service.serviceFilePath}`
        : `Start manually: systemctl --user start ${SYSTEMD_SERVICE_NAME}`)
      console.error(`If this machine should not run a supervised daemon, remove the stale service file (${service.serviceFilePath}) and rerun \`opencode-gateway start\`.`)
      process.exit(1)
    }
    // A leftover unit file without a reachable user service manager (for
    // example a container/SSH box without a systemd user bus) must not brick
    // `start`: no real supervisor exists, so a direct spawn cannot collide
    // with a supervised instance.
    console.error(`The ${service.manager} user service manager is unreachable; starting the daemon directly instead.`)
    console.error(`Remove the stale service file to stop routing through ${service.manager}: ${service.serviceFilePath}`)
  }

  const logFile = serviceLogPath()
  fs.mkdirSync(path.dirname(logFile), { recursive: true })

  const scriptPath = daemonScriptPath()
  const out = fs.openSync(logFile, 'a')
  const err = fs.openSync(logFile, 'a')

  // Provision + hand the daemon the local admin token file so authenticated
  // loopback WRITE calls succeed under the hardened `capabilityScopedLoopback`
  // default. The CLI resolves the same token from this file (see cliDaemonToken),
  // so a directly-spawned daemon accepts the CLI's bearer token out of the box.
  const adminTokenFile = ensureLocalHttpAdminTokenFile()

  const pidFile = cliPidFilePath()
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      GATEWAY_HTTP_PORT: String(config.httpPort),
      OPENCODE_GATEWAY_URL: config.opencodeUrl,
      OPENCODE_GATEWAY_PIDFILE: pidFile,
      OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE: adminTokenFile,
    },
  })

  child.unref()

  fs.mkdirSync(path.dirname(pidFile), { recursive: true })
  fs.writeFileSync(pidFile, String(child.pid))

  log(`Gateway daemon started (PID: ${child.pid})`)
  log(`Logs: ${logFile}`)
  log()
  await waitForDaemonHealth(config, log)
}

async function waitForDaemonHealth(_config: GatewayConfig, log: (...args: unknown[]) => void = console.log): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000))
    try {
      const res = await gatewayFetch('/health')
      if (res.ok) {
        log('Daemon is healthy.')
        return
      }
    } catch {}
  }
  log('Daemon might still be starting. Check status in a few seconds.')
}

export async function stop() {
  assertConfigured('stop')
  const config = getConfig()
  const pidFile = cliPidFilePath()

  // A service-managed daemon must be stopped through the service manager;
  // killing the process directly would only get it resurrected by launchd/systemd.
  const service = detectManagedService()
  if (decideDaemonControl({ action: 'stop', ...service }) === 'service_manager') {
    const result = stopManagedService(service)
    if (result.ok) {
      // The service manager only proves its own job is gone; a direct-started
      // daemon can still be serving the port (for example a crash-looping
      // launchd copy kept the job loaded while a direct daemon owns the port).
      if (!(await daemonStillServing(config))) {
        console.log(`Daemon stopped via ${result.method}`)
        console.log(service.manager === 'launchd'
          ? 'The LaunchAgent is unloaded; it reloads at next login or with `opencode-gateway start`.'
          : 'The systemd unit is stopped; it starts at next login (if enabled) or with `opencode-gateway start`.')
        removePidFileIfRecordedProcessDead(pidFile)
        return
      }
      console.log(`Stopped the managed service via ${result.method}, but a daemon is still serving on port ${config.httpPort}; falling back to direct shutdown.`)
    } else {
      console.log(`Service-manager stop failed (${result.method}): ${result.detail || 'unknown error'}; falling back to direct shutdown.`)
    }
  }

  try {
    // Try graceful shutdown
    const res = await gatewayFetch('/shutdown', { method: 'POST' })
    if (res.ok) {
      console.log('Daemon stopped gracefully.')
      fs.rmSync(pidFile, { force: true })
      return
    }
  } catch {}

  // Fall back to SIGTERM via PID file; the daemon's signal handler runs the same
  // graceful shutdown path. Never signal a PID that does not look like ours.
  let pid = NaN
  try {
    pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
  } catch {
    console.log('Daemon not running.')
    return
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    fs.rmSync(pidFile, { force: true })
    console.log('Daemon not running (invalid PID file removed).')
    return
  }
  try {
    process.kill(pid, 0)
  } catch {
    fs.rmSync(pidFile, { force: true })
    console.log('Daemon not running (stale PID file removed).')
    return
  }
  const command = readProcessCommand(pid)
  if (!command || !commandLooksLikeGatewayDaemon(command, daemonScriptPath())) {
    // Keep the PID file: it is the only stop lever left for a live daemon that
    // this guard misclassifies, and the guard already prevents a wrong signal.
    console.log(`Refusing to signal PID ${pid}: its command line does not look like an opencode-gateway daemon${command ? ` (${redactSensitiveText(command).substring(0, 120)})` : ''}. Keeping the PID file; verify the process and stop it manually if it is a Gateway daemon.`)
    return
  }
  process.kill(pid, 'SIGTERM')
  console.log('Daemon stopped (SIGTERM via PID file; graceful shutdown handler releases the writer lease).')
  fs.rmSync(pidFile, { force: true })
}

/** The daemon entry point this CLI spawns; also used to recognize our own daemon in PID checks. */
function daemonScriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'daemon.js')
}

/** PID file written by `opencode-gateway start`, honoring OPENCODE_GATEWAY_CONFIG_DIR. */
function cliPidFilePath(): string {
  return path.join(getConfigDir(), 'pid')
}

/** Briefly poll /health after a service-manager stop: true when a daemon is still serving past the deadline. */
async function daemonStillServing(_config: GatewayConfig, deadlineMs = 600): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    try {
      const res = await gatewayFetch('/health')
      if (!res.ok) return false
    } catch {
      return false
    }
    if (Date.now() >= deadline) return true
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

/**
 * Remove the PID file only when it can no longer be a stop lever: unreadable
 * or invalid content, or a recorded PID that is not alive. A live recorded PID
 * keeps its file even after a service-manager stop reported success.
 */
function removePidFileIfRecordedProcessDead(pidFile: string): void {
  let recorded = NaN
  try {
    recorded = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10)
  } catch {
    return
  }
  if (Number.isInteger(recorded) && recorded > 0) {
    try {
      process.kill(recorded, 0)
      return
    } catch {}
  }
  fs.rmSync(pidFile, { force: true })
}

export async function restart() {
  assertConfigured('restart')
  await stop()
  for (let i = 0; i < 10; i++) {
    try {
      await gatewayFetch('/health')
      await new Promise(r => setTimeout(r, 300))
    } catch {
      break
    }
  }
  return start()
}

export async function status() {
  assertConfigured('status')
  const config = getConfig()
  try {
    const res = await gatewayFetch('/health')
    if (!res.ok) throw new Error('unhealthy')
    const data = await res.json() as any

    const [listRes, briefRes, envRes, obsRes] = await Promise.all([
      gatewayFetch('/session-state').catch(() => null),
      gatewayFetch('/tasks').catch(() => null),
      gatewayFetch('/environments').catch(() => null),
      gatewayFetch('/observability').catch(() => null),
    ])
    const sessions = listRes ? await listRes.json() as any : { counts: { total: 0, running: 0 } }
    const tasks = briefRes?.ok ? await briefRes.json() as any : null
    const environments = envRes?.ok ? await envRes.json() as any : null
    const observability = obsRes?.ok ? await obsRes.json() as any : null

    const health = await fetchGatewayJson('/gateway/health').then(normalizeServiceHealthReport).catch(() => null)

    console.log(`Gateway: ${data.status}`)
    if (health) {
      const deferredSuffix = health.deferred?.length ? `; ${health.deferred.length} deferred` : ''
      console.log(`Health:  ${health.status} (${health.counts.ok} ok, ${health.counts.degraded} degraded, ${health.counts.down} down${deferredSuffix})`)
      const leadership = health.components?.find((row: any) => row.id === 'leadership')
      if (leadership) console.log(`Leader:  ${leadership.summary}`)
    }
    console.log(`Uptime:  ${Math.floor((data.uptime || 0) / 60)}m`)
    console.log(`Gateway Sessions: ${sessions.counts.total} total (${sessions.counts.running} running)`)
    if (tasks?.counts) console.log(`Issues:  ${formatTaskCounts(tasks.counts).replace(/ \| /g, ', ')}`)
    if (Array.isArray(environments?.environments)) {
      const rows = environments.environments
      const active = rows.filter((row: any) => row.status === 'prepared' || row.status === 'blocked').length
      const retained = rows.filter((row: any) => row.status === 'retained').length
      const cleanupFailed = rows.filter((row: any) => row.status === 'cleanup_failed' || row.cleanup?.state === 'failed').length
      console.log(`Environments: ${active} active, ${retained} retained, ${cleanupFailed} cleanup failed`)
    }
    if (observability?.trace || Array.isArray(observability?.slo)) {
      console.log(formatObservabilityStatusLine(observability.trace, observability.slo || []))
    }
    console.log(`Port:    ${config.httpPort}`)
    console.log(`Config:  ~/.config/opencode-gateway/config.json`)
    if (health?.attention.length) {
      console.log()
      console.log('Needs attention:')
      for (const row of health.attention.slice(0, 5)) console.log(`- ${row.label}: ${row.summary} Next: ${row.remediation}`)
    }
    if (health?.deferred?.length) {
      console.log()
      console.log('Deferred / non-blocking:')
      for (const row of health.deferred.slice(0, 5)) console.log(`- ${row.label}: ${row.summary} Next: ${row.remediation}`)
    }
  } catch {
    console.log('Gateway: not running')
    console.log('Next: run `opencode-gateway start`; if it still fails, run `opencode-gateway logs`.')
    process.exit(1)
  }
}

export async function install() {
  assertConfigured('install')
  const config = getConfig()
  const home = os.homedir()
  const platform = process.platform // 'darwin' | 'linux'

  if (platform === 'darwin') {
    await installLaunchd(config, home)
  } else if (platform === 'linux') {
    await installSystemd(config, home)
  } else {
    console.log(`Platform ${platform} service installation is not automated.`)
    console.log('Run: opencode-gateway start (in a screen/tmux session)')
  }

  console.log()
  console.log('📋 Base OpenCode assets are installed by `opencode-gateway setup`.')
  console.log('   If you need to add the Gateway MCP manually, add this to your opencode.jsonc MCP section:')
  console.log(`
  "gateway": {
    "type": "local",
      "command": ["node", "${path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'mcp.js')}"],
      "environment": {
      "GATEWAY_DAEMON_URL": "http://127.0.0.1:${config.httpPort}"
    }
  }
`)
}

async function installLaunchd(config: GatewayConfig, home: string) {
  const logDir = path.join(home, 'Library', 'Logs')
  const plistDir = path.join(home, 'Library', 'LaunchAgents')
  const plistPath = path.join(plistDir, `${LAUNCHD_LABEL}.plist`)

  fs.mkdirSync(logDir, { recursive: true })
  fs.mkdirSync(plistDir, { recursive: true })

  // Stable paths: the daemon entry comes from this module's own install
  // location and the working directory is the Gateway config dir — never the
  // install-time cwd. Rerunning `opencode-gateway install` heals definitions
  // written by older versions.
  const daemonScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'daemon.js')
  const adminTokenFile = ensureLocalHttpAdminTokenFile()
  const plist = buildLaunchdPlist({
    nodePath: process.execPath,
    daemonScript,
    workingDirectory: path.resolve(getConfigDir()),
    environment: gatewayServiceEnvironment(config, { adminTokenFile }),
    logPath: path.join(logDir, 'opencode-gateway.log'),
  })

  // Reload the definition if a previous version is loaded, then bootstrap it so
  // the daemon starts supervised now and at login — install.sh relies on this.
  const previous = detectManagedService()
  fs.writeFileSync(plistPath, plist)
  console.log(`✅ LaunchAgent installed: ${plistPath}`)
  if (previous.manager === 'launchd' && previous.loaded) {
    const stopped = stopManagedService(previous)
    console.log(stopped.ok ? `   Unloaded previous definition (${stopped.method}).` : `   Could not unload previous definition: ${stopped.detail || stopped.method}`)
  }
  const started = startManagedService({ manager: 'launchd', installed: true, loaded: false, serviceFilePath: plistPath })
  if (started.ok) {
    console.log(`   Loaded and started via ${started.method}`)
  } else {
    console.log(`   Could not load the service automatically (${started.detail || started.method}).`)
    console.log(`   Load manually: launchctl bootstrap gui/$(id -u) ${plistPath}`)
  }
  console.log(`   Logs: ${path.join(logDir, 'opencode-gateway.log')} (rotated by the daemon at 10MB, 5 kept)`)
  console.log(`   HTTP admin token file: ${adminTokenFile}`)
  console.log()
  console.log('Commands:')
  console.log('  opencode-gateway stop     # stop via launchctl (stays stopped)')
  console.log('  opencode-gateway start    # start via launchctl')
}

async function installSystemd(config: GatewayConfig, home: string) {
  const unitDir = path.join(home, '.config', 'systemd', 'user')
  const daemonScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'daemon.js')
  const adminTokenFile = ensureLocalHttpAdminTokenFile()
  const unit = buildSystemdUnit({
    nodePath: process.execPath,
    daemonScript,
    workingDirectory: path.resolve(getConfigDir()),
    environment: gatewayServiceEnvironment(config, { adminTokenFile }),
  })

  fs.mkdirSync(unitDir, { recursive: true })
  const unitPath = path.join(unitDir, `${SYSTEMD_SERVICE_NAME}.service`)
  fs.writeFileSync(unitPath, unit)

  console.log(`✅ systemd unit installed: ${unitPath}`)
  const enabled = enableSystemdService()
  if (enabled.ok) {
    console.log(`   Enabled and started via ${enabled.method}`)
  } else {
    console.log(`   Could not enable the unit automatically (${enabled.detail || enabled.method}).`)
    console.log(`   Enable manually: systemctl --user enable --now ${SYSTEMD_SERVICE_NAME}`)
  }
  console.log()
  console.log('Commands:')
  console.log('  opencode-gateway stop                       # stop via systemctl (stays stopped)')
  console.log('  opencode-gateway start                      # start via systemctl')
  console.log(`  systemctl --user status ${SYSTEMD_SERVICE_NAME}    # check status`)
  console.log(`  journalctl --user -u ${SYSTEMD_SERVICE_NAME} -f    # follow logs (journald rotates them)`)
  console.log(`  HTTP admin token file: ${adminTokenFile}`)
}
