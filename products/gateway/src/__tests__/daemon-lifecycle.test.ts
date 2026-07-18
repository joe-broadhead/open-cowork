import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import {
  commandLooksLikeGatewayDaemon,
  registerDaemonShutdownHandler,
  removeOwnedPidFile,
  requestDaemonShutdown,
  type DaemonShutdownRequest,
} from '../daemon-lifecycle.js'
import { checkBoundChannelSession, computeDaemonLeadershipLeaseMs, createLeadershipStatusHandler, describeServerListenError } from '../daemon.js'
import { systemRoutes } from '../daemon-routes/system.js'
import { dispatchRoute } from '../daemon-router.js'
import { clearConfigCacheForTest, getConfig, updateConfig } from '../config.js'
import { clearWorkStateForTest } from '../work-store.js'
import { clearCurrentDaemonLeadershipForTest } from '../daemon-leadership.js'

describe('daemon lifecycle', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-daemon-lifecycle-'))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
    clearCurrentDaemonLeadershipForTest()
  })

  afterEach(() => {
    registerDaemonShutdownHandler(null)
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    clearCurrentDaemonLeadershipForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('routes /shutdown and /restart through the registered graceful shutdown handler', async () => {
    // Lifecycle ops are exempt from the destructive-action human gate even with
    // the default (enabled) humanLoop config: a local `opencode-gateway stop`
    // must never be answered with a 428 approval demand.
    updateConfig({ humanLoop: { enabled: true, destructiveActionApproval: true } } as any)
    const requests: DaemonShutdownRequest[] = []
    registerDaemonShutdownHandler(request => requests.push(request))

    const shutdownResponse = await dispatchRoute(systemRoutes(), context('POST', '/shutdown', {}))
    expect(shutdownResponse).toMatchObject({ status: 200, body: { ok: true } })
    shutdownResponse!.afterSend?.()
    expect(requests).toEqual([{ reason: 'http /shutdown' }])

    // /restart exits non-zero so on-failure service-manager policies respawn the daemon.
    const restartResponse = await dispatchRoute(systemRoutes(), context('POST', '/restart', {}))
    expect(restartResponse?.status).toBe(200)
    restartResponse!.afterSend?.()
    expect(requests).toEqual([{ reason: 'http /shutdown' }, { reason: 'http /restart', exitCode: 1 }])
  })

  it('forwards shutdown requests to the registered graceful handler', () => {
    const seen: DaemonShutdownRequest[] = []
    registerDaemonShutdownHandler(request => seen.push(request))
    requestDaemonShutdown({ reason: 'SIGTERM' })
    expect(seen).toEqual([{ reason: 'SIGTERM' }])

    // Without a handler (never the case once serve() has booted) the request
    // is a no-op instead of a delayed hard exit.
    registerDaemonShutdownHandler(null)
    expect(() => requestDaemonShutdown({ reason: 'SIGTERM' })).not.toThrow()
    expect(seen).toEqual([{ reason: 'SIGTERM' }])
  })

  it('floors writer leadership leases above blocking environment prepare timeouts', () => {
    expect(computeDaemonLeadershipLeaseMs(getConfig())).toBeGreaterThanOrEqual(60 * 60 * 1000 + 30_000)
  })

  it('runs the writer recovery pass on standby-to-writer promotion, once per promotion', () => {
    const recoveries: string[] = []
    const channelStarts: string[] = []
    const onStatus = createLeadershipStatusHandler({
      initiallyWriter: false,
      runWriterRecovery: source => recoveries.push(String(source)),
      startChannels: source => channelStarts.push(String(source)),
      stopChannels: () => {},
    })

    onStatus({ canWrite: false })
    expect(recoveries).toEqual([])
    expect(channelStarts).toEqual([])

    onStatus({ canWrite: true })
    onStatus({ canWrite: true })
    expect(recoveries).toEqual(['leadership recovery'])
    expect(channelStarts.length).toBe(2)

    // Losing and regaining the lease re-runs recovery for the new generation.
    onStatus({ canWrite: false })
    onStatus({ canWrite: true })
    expect(recoveries).toEqual(['leadership recovery', 'leadership recovery'])
  })

  it('does not re-run writer recovery when the daemon booted as writer', () => {
    const recoveries: string[] = []
    const stops: string[] = []
    const onStatus = createLeadershipStatusHandler({
      initiallyWriter: true,
      runWriterRecovery: source => recoveries.push(String(source)),
      startChannels: () => {},
      stopChannels: source => stops.push(String(source)),
    })
    onStatus({ canWrite: true })
    onStatus({ canWrite: true })
    expect(recoveries).toEqual([])
    onStatus({ canWrite: false })
    onStatus({ canWrite: false })
    expect(stops).toEqual(['leadership lost'])
  })

  it('describes listen failures with the port, the likely cause, and a remediation', () => {
    const message = describeServerListenError({ code: 'EADDRINUSE' }, { port: 4097, host: '127.0.0.1' })
    expect(message).toContain('http://127.0.0.1:4097')
    expect(message).toContain('EADDRINUSE')
    expect(message).toContain('opencode-gateway stop')
    expect(message).toContain('httpPort')
    expect(describeServerListenError({ code: 'EACCES' }, { port: 80, host: '127.0.0.1' })).toContain('unprivileged port')
    expect(describeServerListenError(new Error('boom'), { port: 4097, host: '127.0.0.1' })).toContain('boom')
  })

  it('classifies bound-session checks so transient OpenCode failures keep the binding', async () => {
    const usable = { session: { get: async () => ({ data: { id: 'ses_1' } }) } }
    const missing = { session: { get: async () => { throw Object.assign(new Error('session not found'), { status: 404 }) } } }
    const transientNetwork = { session: { get: async () => { throw new Error('fetch failed') } } }
    const transientServer = { session: { get: async () => { throw Object.assign(new Error('upstream unavailable'), { status: 503 }) } } }

    expect(await checkBoundChannelSession(usable, 'ses_1')).toBe('usable')
    expect(await checkBoundChannelSession(missing, 'ses_1')).toBe('missing')
    expect(await checkBoundChannelSession(transientNetwork, 'ses_1')).toBe('transient')
    expect(await checkBoundChannelSession(transientServer, 'ses_1')).toBe('transient')
  })

  it('only signals PIDs whose command line looks like a gateway daemon', () => {
    expect(commandLooksLikeGatewayDaemon('node /usr/local/lib/node_modules/opencode-gateway/dist/daemon.js')).toBe(true)
    expect(commandLooksLikeGatewayDaemon('node /Users/dev/opencode-gateway/dist/daemon.js')).toBe(true)
    expect(commandLooksLikeGatewayDaemon('node /srv/my-gateway/daemon.ts')).toBe(true)
    expect(commandLooksLikeGatewayDaemon('vim notes.txt')).toBe(false)
    expect(commandLooksLikeGatewayDaemon('node /srv/unrelated/daemon.js')).toBe(false)
    expect(commandLooksLikeGatewayDaemon('')).toBe(false)

    // The CLI passes the exact daemon script it spawns, so a genuine daemon in
    // a checkout whose path contains no "gateway" token is still recognized.
    expect(commandLooksLikeGatewayDaemon('node /Users/x/src/ocg/dist/daemon.js', '/Users/x/src/ocg/dist/daemon.js')).toBe(true)
    expect(commandLooksLikeGatewayDaemon('node /Users/x/src/ocg/dist/daemon.js')).toBe(false)
    expect(commandLooksLikeGatewayDaemon('vim notes.txt', '/Users/x/src/ocg/dist/daemon.js')).toBe(false)
  })

  it('removes the PID file only when it records this process', () => {
    const pidFile = path.join(testDir, 'pid')

    fs.writeFileSync(pidFile, String(process.pid))
    removeOwnedPidFile(process.pid, pidFile)
    expect(fs.existsSync(pidFile)).toBe(false)

    fs.writeFileSync(pidFile, String(process.pid + 1))
    removeOwnedPidFile(process.pid, pidFile)
    expect(fs.existsSync(pidFile)).toBe(true)
  })
})

function context(method: string, path: string, body?: unknown) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as any
  req.method = method
  req.headers = {}
  return {
    req,
    url: new URL(path, 'http://127.0.0.1:4097'),
    client: {},
    channels: new Map<string, any>(),
  }
}
