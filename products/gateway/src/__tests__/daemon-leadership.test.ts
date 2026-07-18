import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { canCurrentDaemonWrite, clearCurrentDaemonLeadershipForTest, createDaemonLeadership, currentDaemonWriteFence, daemonMutationRequiresWriter, evaluateDaemonMutationFence, redactDaemonLeadershipSnapshot, setCurrentDaemonLeadership } from '../daemon-leadership.js'
import { clearWorkStateForTest, listWorkEvents } from '../work-store.js'

describe('daemon leadership', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-daemon-leadership-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const dbPath = path.join(testDir, 'gateway.db')
  let now = 1_000_000

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(testDir, { recursive: true })
    clearWorkStateForTest(dbPath)
    clearCurrentDaemonLeadershipForTest()
    now = 1_000_000
  })

  afterEach(() => {
    clearCurrentDaemonLeadershipForTest()
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
  })

  it.skipIf(process.platform === 'win32')('restricts the leadership db and its WAL/SHM sidecars to owner-only on every open', () => {
    const permPath = path.join(testDir, 'leadership-permissions.db')
    const leadership = createDaemonLeadership({ filePath: permPath, daemonId: 'daemon-perm', instanceId: 'daemon-perm:1', leaseMs: 60_000, now: () => now })
    leadership.acquireOrRenew()

    // Hold a second connection open so SQLite does not checkpoint and remove
    // the WAL/SHM sidecars when the leadership connection closes.
    const holder = new DatabaseSync(permPath)
    try {
      holder.prepare('SELECT 1').get()
      const files = [permPath, `${permPath}-wal`, `${permPath}-shm`]
      for (const file of files) expect(fs.existsSync(file), file).toBe(true)
      // Simulate sidecars leaked with a permissive umask, then renew the lease:
      // the leadership open path itself must restore owner-only permissions
      // (renewals do not append audit events, so no other db open runs here).
      for (const file of files) fs.chmodSync(file, 0o644)
      leadership.acquireOrRenew()
      for (const file of files) {
        expect((fs.statSync(file).mode & 0o777).toString(8), file).toBe('600')
      }
    } finally {
      holder.close()
    }
  })

  it('elects one local writer and makes the second daemon standby', () => {
    const writer = createDaemonLeadership({ filePath: dbPath, daemonId: 'daemon-a', instanceId: 'daemon-a:1', leaseMs: 60_000, now: () => now })
    const standby = createDaemonLeadership({ filePath: dbPath, daemonId: 'daemon-b', instanceId: 'daemon-b:1', leaseMs: 60_000, now: () => now })

    expect(writer.acquireOrRenew()).toMatchObject({ mode: 'writer', canWrite: true, leaderId: 'daemon-a:1' })
    expect(standby.acquireOrRenew()).toMatchObject({ mode: 'standby', canWrite: false, leaderId: 'daemon-a:1' })

    setCurrentDaemonLeadership(standby)
    expect(canCurrentDaemonWrite()).toBe(false)

    setCurrentDaemonLeadership(writer)
    expect(canCurrentDaemonWrite()).toBe(true)
  })

  it('takes over a stale writer lease and records redacted audit evidence', () => {
    const writer = createDaemonLeadership({ filePath: dbPath, daemonId: 'daemon-a', instanceId: 'daemon-a:1', leaseMs: 60_000, now: () => now })
    writer.acquireOrRenew({ source: 'startup' })

    now += 60_001
    const takeover = createDaemonLeadership({ filePath: dbPath, daemonId: 'daemon-b', instanceId: 'daemon-b:1', leaseMs: 60_000, now: () => now })
    const snapshot = takeover.acquireOrRenew({ source: 'operator' })

    expect(snapshot).toMatchObject({ mode: 'writer', canWrite: true, leaderId: 'daemon-b:1', takeoverCount: 1 })
    const audit = listWorkEvents(20, dbPath).find(event => event.type === 'audit.security' && event.payload['operation'] === 'daemon.leadership.takeover_stale')
    expect(audit?.payload['result']).toBe('ok')
    expect(JSON.stringify(audit)).not.toContain('daemon-a:1')
    expect(JSON.stringify(audit)).not.toContain('daemon-b:1')
  })

  it('redacts daemon and fencing identifiers in public status', () => {
    const writer = createDaemonLeadership({ filePath: dbPath, daemonId: 'daemon-secret-a', instanceId: 'daemon-secret-a:1', leaseMs: 60_000, now: () => now })
    const snapshot = writer.acquireOrRenew()
    const publicSnapshot = redactDaemonLeadershipSnapshot(snapshot)

    expect(publicSnapshot.instanceId).not.toBe(snapshot.instanceId)
    expect(publicSnapshot.leaderId).not.toBe(snapshot.leaderId)
    expect(publicSnapshot.fencingToken).not.toBe(snapshot.fencingToken)
    expect(JSON.stringify(publicSnapshot)).not.toContain('daemon-secret-a')
  })

  it('builds stable redacted write-fence metadata for scheduler and worker leases', () => {
    const writer = createDaemonLeadership({ filePath: dbPath, daemonId: 'daemon-secret-a', instanceId: 'daemon-secret-a:1', leaseMs: 60_000, now: () => now })
    writer.acquireOrRenew()
    setCurrentDaemonLeadership(writer)

    const fence = currentDaemonWriteFence('scheduler')

    expect(fence.canWrite).toBe(true)
    expect(fence.leaseOwner).toMatch(/^scheduler:writer:/)
    expect(fence.generation).toContain('gateway-local-writer:writer:')
    expect(JSON.stringify(fence)).not.toContain('daemon-secret-a')
    expect(JSON.stringify(fence)).not.toContain('daemon-secret-a:1')
  })

  it('requires the writer lease for mutating Gateway routes but not reads or recovery', () => {
    expect(daemonMutationRequiresWriter('GET', '/tasks')).toBe(false)
    expect(daemonMutationRequiresWriter('POST', '/gateway/leadership/recover')).toBe(false)
    expect(daemonMutationRequiresWriter('POST', '/tasks')).toBe(true)

    const writer = createDaemonLeadership({ filePath: dbPath, daemonId: 'daemon-a', instanceId: 'daemon-a:1', leaseMs: 60_000, now: () => now })
    const standby = createDaemonLeadership({ filePath: dbPath, daemonId: 'daemon-b', instanceId: 'daemon-b:1', leaseMs: 60_000, now: () => now })
    writer.acquireOrRenew()
    standby.acquireOrRenew()
    setCurrentDaemonLeadership(standby)

    const denied = evaluateDaemonMutationFence({ method: 'POST', pathname: '/tasks', component: 'http-route' })
    expect(denied).toMatchObject({
      allowed: false,
      status: 409,
      requiresWriter: true,
      leadership: expect.objectContaining({ mode: 'standby', canWrite: false }),
    })
    expect(denied.error).toContain('local writer lease is required')
    expect(JSON.stringify(denied)).not.toContain('daemon-a:1')
    expect(JSON.stringify(denied)).not.toContain('daemon-b:1')
  })

  it('redacts private paths and secret-shaped values from public remediation text', () => {
    const writer = createDaemonLeadership({ filePath: dbPath, daemonId: 'daemon-a', instanceId: 'daemon-a:1', leaseMs: 60_000, now: () => now })
    const snapshot = writer.acquireOrRenew()
    const publicSnapshot = redactDaemonLeadershipSnapshot({
      ...snapshot,
      remediation: 'Cannot open /Users/alice/private/gateway.db with token=secret-value',
    })

    expect(publicSnapshot.remediation).not.toContain('/Users/alice')
    expect(publicSnapshot.remediation).not.toContain('secret-value')
    expect(publicSnapshot.remediation).toContain('<redacted-path>')
    expect(publicSnapshot.remediation).toContain('token=<redacted>')
  })
})
