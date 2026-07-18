import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  LAUNCHD_SERVICE_LABEL,
  SYSTEMD_SERVICE_NAME,
  buildLaunchdPlist,
  buildSystemdUnit,
  decideDaemonControl,
  detectManagedService,
  enableSystemdService,
  isServiceManagerUnreachable,
  serviceDefinitionPath,
  startManagedService,
  stopManagedService,
  type ManagedServiceStatus,
} from '../service-manager.js'

type Call = { command: string; args: string[] }

function fakeRunner(responses: Record<string, number>, calls: Call[] = []) {
  return (command: string, args: string[]) => {
    calls.push({ command, args })
    const key = `${command} ${args.join(' ')}`
    const match = Object.keys(responses).find(prefix => key.startsWith(prefix))
    const status = match === undefined ? 1 : responses[match]!
    return { status, stdout: '', stderr: status === 0 ? '' : `failed: ${key}` }
  }
}

describe('service manager', () => {
  it('decides start/stop control paths from service install and load state', () => {
    // start goes through the service manager whenever installed, even if unloaded.
    expect(decideDaemonControl({ action: 'start', manager: 'launchd', installed: true, loaded: false })).toBe('service_manager')
    expect(decideDaemonControl({ action: 'start', manager: 'systemd', installed: true, loaded: true })).toBe('service_manager')
    expect(decideDaemonControl({ action: 'start', manager: 'launchd', installed: false, loaded: false })).toBe('direct')
    expect(decideDaemonControl({ action: 'start', manager: 'none', installed: false, loaded: false })).toBe('direct')

    // stop only goes through the service manager when the service is loaded;
    // installed-but-unloaded means the daemon (if any) was started directly.
    expect(decideDaemonControl({ action: 'stop', manager: 'launchd', installed: true, loaded: true })).toBe('service_manager')
    expect(decideDaemonControl({ action: 'stop', manager: 'systemd', installed: true, loaded: true })).toBe('service_manager')
    expect(decideDaemonControl({ action: 'stop', manager: 'launchd', installed: true, loaded: false })).toBe('direct')
    expect(decideDaemonControl({ action: 'stop', manager: 'systemd', installed: false, loaded: false })).toBe('direct')
  })

  it('classifies failed managed starts whose service manager is unreachable so start can fall back to a direct spawn', () => {
    // A leftover unit file without a reachable user manager (container/SSH box
    // with no systemd user bus, missing systemctl) means no real supervisor
    // exists: falling back to a direct start cannot create a dual instance.
    const method = `systemctl --user start ${SYSTEMD_SERVICE_NAME}`
    expect(isServiceManagerUnreachable({ ok: false, method, detail: 'Failed to connect to bus: No medium found' })).toBe(true)
    expect(isServiceManagerUnreachable({ ok: false, method, detail: 'spawn systemctl ENOENT' })).toBe(true)
    expect(isServiceManagerUnreachable({ ok: false, method, detail: 'systemctl: command not found' })).toBe(true)
    expect(isServiceManagerUnreachable({ ok: false, method, detail: 'exit null' })).toBe(true)

    // A reachable manager that refused the start keeps the no-fallback behavior.
    expect(isServiceManagerUnreachable({ ok: false, method, detail: 'Unit opencode-gateway.service has a bad unit file setting.' })).toBe(false)
    expect(isServiceManagerUnreachable({ ok: false, method, detail: 'exit 1' })).toBe(false)
    expect(isServiceManagerUnreachable({ ok: true, method })).toBe(false)

    // The end-to-end shape: a bus-less start failure carries the stderr detail.
    const failed = startManagedService(
      { manager: 'systemd', installed: true, loaded: false, serviceFilePath: '/tmp/x.service' },
      { runner: () => ({ status: 1, stdout: '', stderr: 'Failed to connect to bus: Operation not permitted' }) },
    )
    expect(failed.ok).toBe(false)
    expect(isServiceManagerUnreachable(failed)).toBe(true)
  })

  it('detects the platform service definition path and load state', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-service-manager-'))
    expect(serviceDefinitionPath('darwin', home)).toBe(path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_SERVICE_LABEL}.plist`))
    expect(serviceDefinitionPath('linux', home)).toBe(path.join(home, '.config', 'systemd', 'user', `${SYSTEMD_SERVICE_NAME}.service`))
    expect(serviceDefinitionPath('win32' as NodeJS.Platform, home)).toBeUndefined()

    expect(detectManagedService({ platform: 'win32' as NodeJS.Platform, homeDir: home })).toMatchObject({ manager: 'none', installed: false, loaded: false })
    expect(detectManagedService({ platform: 'darwin', homeDir: home, runner: fakeRunner({}) })).toMatchObject({ manager: 'launchd', installed: false, loaded: false })

    const plist = serviceDefinitionPath('darwin', home)!
    fs.mkdirSync(path.dirname(plist), { recursive: true })
    fs.writeFileSync(plist, 'placeholder')
    expect(detectManagedService({ platform: 'darwin', homeDir: home, uid: 501, runner: fakeRunner({ 'launchctl print': 0 }) }))
      .toMatchObject({ manager: 'launchd', installed: true, loaded: true, serviceFilePath: plist })
    expect(detectManagedService({ platform: 'darwin', homeDir: home, uid: 501, runner: fakeRunner({ 'launchctl print': 1 }) }))
      .toMatchObject({ installed: true, loaded: false })

    const unit = serviceDefinitionPath('linux', home)!
    fs.mkdirSync(path.dirname(unit), { recursive: true })
    fs.writeFileSync(unit, 'placeholder')
    expect(detectManagedService({ platform: 'linux', homeDir: home, runner: fakeRunner({ 'systemctl --user is-active': 0 }) }))
      .toMatchObject({ manager: 'systemd', installed: true, loaded: true })
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('stops via launchctl bootout with an unload fallback, and via systemctl stop', () => {
    const darwin: ManagedServiceStatus = { manager: 'launchd', installed: true, loaded: true, serviceFilePath: '/tmp/x.plist' }
    expect(stopManagedService(darwin, { uid: 501, runner: fakeRunner({ 'launchctl bootout': 0 }) }))
      .toMatchObject({ ok: true, method: `launchctl bootout gui/501/${LAUNCHD_SERVICE_LABEL}` })
    expect(stopManagedService(darwin, { uid: 501, runner: fakeRunner({ 'launchctl bootout': 1, 'launchctl unload': 0 }) }))
      .toMatchObject({ ok: true, method: 'launchctl unload /tmp/x.plist' })
    expect(stopManagedService(darwin, { uid: 501, runner: fakeRunner({}) }).ok).toBe(false)

    const linux: ManagedServiceStatus = { manager: 'systemd', installed: true, loaded: true, serviceFilePath: '/tmp/x.service' }
    expect(stopManagedService(linux, { runner: fakeRunner({ 'systemctl --user stop': 0 }) }))
      .toMatchObject({ ok: true, method: `systemctl --user stop ${SYSTEMD_SERVICE_NAME}` })
    expect(stopManagedService({ manager: 'none', installed: false, loaded: false }).ok).toBe(false)
  })

  it('starts via launchctl bootstrap with a kickstart fallback, and via systemctl start', () => {
    const darwin: ManagedServiceStatus = { manager: 'launchd', installed: true, loaded: false, serviceFilePath: '/tmp/x.plist' }
    expect(startManagedService(darwin, { uid: 501, runner: fakeRunner({ 'launchctl bootstrap': 0 }) }))
      .toMatchObject({ ok: true, method: 'launchctl bootstrap gui/501 /tmp/x.plist' })
    // Already bootstrapped after a clean exit: kickstart the loaded job.
    expect(startManagedService(darwin, { uid: 501, runner: fakeRunner({ 'launchctl bootstrap': 1, 'launchctl kickstart': 0 }) }))
      .toMatchObject({ ok: true, method: `launchctl kickstart gui/501/${LAUNCHD_SERVICE_LABEL}` })

    const calls: Call[] = []
    const linux: ManagedServiceStatus = { manager: 'systemd', installed: true, loaded: false, serviceFilePath: '/tmp/x.service' }
    expect(startManagedService(linux, { runner: fakeRunner({ 'systemctl --user daemon-reload': 0, 'systemctl --user start': 0 }, calls) }).ok).toBe(true)
    expect(calls.map(call => call.args.join(' '))).toEqual(['--user daemon-reload', `--user start ${SYSTEMD_SERVICE_NAME}`])

    expect(enableSystemdService({ runner: fakeRunner({ 'systemctl --user daemon-reload': 0, 'systemctl --user enable --now': 0 }) }))
      .toMatchObject({ ok: true, method: `systemctl --user enable --now ${SYSTEMD_SERVICE_NAME}` })

    const reloadFailureCalls: Call[] = []
    expect(enableSystemdService({ runner: fakeRunner({ 'systemctl --user daemon-reload': 1, 'systemctl --user enable --now': 0 }, reloadFailureCalls) }))
      .toMatchObject({ ok: false, method: 'systemctl --user daemon-reload' })
    expect(reloadFailureCalls.map(call => call.args.join(' '))).toEqual(['--user daemon-reload'])
  })

  it('builds a launchd plist with stable paths, failure-only KeepAlive, and respawn throttling', () => {
    const plist = buildLaunchdPlist({
      nodePath: '/usr/local/bin/node',
      daemonScript: '/opt/gateway/dist/daemon.js',
      workingDirectory: '/home/op/.config/opencode-gateway',
      environment: { GATEWAY_HTTP_PORT: '4097', OPENCODE_GATEWAY_URL: 'http://127.0.0.1:4096' },
      logPath: '/home/op/Library/Logs/opencode-gateway.log',
    })
    expect(plist).toContain(`<string>${LAUNCHD_SERVICE_LABEL}</string>`)
    expect(plist).toContain('<string>/opt/gateway/dist/daemon.js</string>')
    expect(plist).toContain('<string>/home/op/.config/opencode-gateway</string>')
    expect(plist).not.toContain(process.cwd())
    // Clean stop stays stopped; crashes respawn, throttled against hot-loops.
    expect(plist).toContain('<key>SuccessfulExit</key>')
    expect(plist).toContain('<key>ThrottleInterval</key>')
    expect(plist).toContain('<key>ExitTimeOut</key>')
    expect(plist).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>30<\/integer>/)
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    expect(plist).toContain('<string>/home/op/Library/Logs/opencode-gateway.log</string>')
  })

  it('builds a systemd unit that logs to journald and restarts only on failure with a start limit', () => {
    const unit = buildSystemdUnit({
      nodePath: '/usr/bin/node',
      daemonScript: '/opt/gateway/dist/daemon.js',
      workingDirectory: '/home/op/.config/opencode-gateway',
      environment: { GATEWAY_HTTP_PORT: '4097' },
    })
    expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/gateway/dist/daemon.js"')
    expect(unit).toContain('WorkingDirectory="/home/op/.config/opencode-gateway"')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('StartLimitIntervalSec=60')
    expect(unit).toContain('StartLimitBurst=5')
    expect(unit).toContain('KillSignal=SIGTERM')
    expect(unit).toContain('TimeoutStopSec=30')
    expect(unit).toContain('UMask=0077')
    expect(unit).toContain('NoNewPrivileges=true')
    expect(unit).toContain('LogRateLimitIntervalSec=30s')
    // journald owns output (and rotation): no file redirection.
    expect(unit).not.toContain('StandardOutput=')
    expect(unit).not.toContain('StandardError=')
    expect(unit).toContain('Environment="GATEWAY_HTTP_PORT=4097"')
  })

  it('quotes systemd paths with spaces and escapes systemd percent specifiers', () => {
    const unit = buildSystemdUnit({
      nodePath: '/opt/Node Current/bin/node',
      daemonScript: '/srv/gateway 100%/dist/daemon.js',
      workingDirectory: '/home/op/Gateway 100%',
      environment: { OPENCODE_GATEWAY_URL: 'http://127.0.0.1:4096/%project' },
    })

    expect(unit).toContain('ExecStart="/opt/Node Current/bin/node" "/srv/gateway 100%%/dist/daemon.js"')
    expect(unit).toContain('WorkingDirectory="/home/op/Gateway 100%%"')
    expect(unit).toContain('Environment="OPENCODE_GATEWAY_URL=http://127.0.0.1:4096/%%project"')
  })
})
