import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest, updateSchedulerConfig } from '../config.js'
import { clearWorkStateForTest, startWorkTaskRun, createWorkTask, setWorkDbLeadershipEpochProvider } from '../work-store.js'
import { admitOpenCodeSession, createOpenCodeSessionRuntime, reconcilePendingSessionAdmissions, type OpenCodeSessionRuntime } from '../opencode-session-runtime.js'
import { createFakeOpencodeClient } from './helpers/typed-opencode-client.js'
import { setDaemonClient } from '../gateway-runtime.js'
import { clearCurrentDaemonLeadershipForTest, createDaemonLeadership, setCurrentDaemonLeadership } from '../daemon-leadership.js'
import { DatabaseSync } from 'node:sqlite'

describe('OpenCode session runtime', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-session-runtime-'))
  const store = path.join(testDir, 'gateway.db')

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    clearWorkStateForTest(store)
    clearConfigCacheForTest()
    updateSchedulerConfig({ maxConcurrent: 1 })
  })

  afterEach(() => {
    setWorkDbLeadershipEpochProvider(undefined)
    clearCurrentDaemonLeadershipForTest()
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    clearConfigCacheForTest()
    setDaemonClient(undefined as any)
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('creates sessions through the runtime port', async () => {
    const fake = createFakeOpencodeClient()
    setDaemonClient(fake.client)
    const runtime = createOpenCodeSessionRuntime(fake.client)
    const session = await runtime.createSession({ title: 'GW:test' })
    expect(session.id).toBeTruthy()
    const listed = await runtime.listSessions()
    expect(listed.some((row: any) => row.id === session.id)).toBe(true)
  })

  it('propagates cancellation to classic and V2 session listing transports', async () => {
    const signal = new AbortController().signal
    let classicRequest: any
    const classic = createOpenCodeSessionRuntime({
      session: {
        async list(request: any) {
          classicRequest = request
          return { data: [] }
        },
      },
    } as any)
    await classic.listSessions('/tmp/gateway-project', { signal })
    expect(classicRequest).toMatchObject({
      query: { directory: '/tmp/gateway-project' },
      signal,
    })

    let v2Request: any
    let v2Options: any
    const v2 = createOpenCodeSessionRuntime({
      v2: {
        session: {
          async list(request: any, options: any) {
            v2Request = request
            v2Options = options
            return { data: [] }
          },
        },
      },
    } as any)
    await v2.listSessions(undefined, { signal })
    expect(v2Request).toMatchObject({ limit: 200, order: 'asc' })
    expect(v2Options).toMatchObject({ throwOnError: true, signal })
  })

  it('requires an acknowledged interrupt for fail-closed recovery while preserving best-effort aborts', async () => {
    const transportError = new Error('interrupt transport unavailable')
    const throwOnError: boolean[] = []
    const runtime = createOpenCodeSessionRuntime({
      v2: {
        session: {
          async interrupt(_request: unknown, options: { throwOnError: boolean }) {
            throwOnError.push(options.throwOnError)
            throw transportError
          },
        },
      },
    } as any)

    await expect(runtime.abort('session-1')).resolves.toBeUndefined()
    await expect(runtime.abort('session-1', undefined, { requireConfirmation: true })).rejects.toBe(transportError)
    expect(throwOnError).toEqual([false, true])

    const classicTransportError = new Error('classic abort transport unavailable')
    const classicThrowOnError: Array<boolean | undefined> = []
    const classicRuntime = createOpenCodeSessionRuntime({
      session: {
        async abort(request: { throwOnError?: boolean }) {
          classicThrowOnError.push(request.throwOnError)
          if (request.throwOnError) throw classicTransportError
          return { error: classicTransportError }
        },
      },
    } as any)
    await expect(classicRuntime.abort('session-1')).resolves.toBeUndefined()
    await expect(classicRuntime.abort(
      'session-1',
      undefined,
      { requireConfirmation: true },
    )).rejects.toBe(classicTransportError)
    expect(classicThrowOnError).toEqual([undefined, true])

    await expect(createOpenCodeSessionRuntime({} as any).abort(
      'session-1',
      undefined,
      { requireConfirmation: true },
    )).rejects.toThrow('OpenCode session interrupt is unavailable.')
  })

  it('deletes sessions through the runtime port and verifies absence', async () => {
    const fake = createFakeOpencodeClient()
    setDaemonClient(fake.client)
    const runtime = createOpenCodeSessionRuntime(fake.client)
    const session = await runtime.createSession({ title: 'GW:delete' })

    await runtime.deleteSession(session.id)

    expect(fake.deletes).toEqual([session.id])
    await expect(runtime.getSession(session.id)).resolves.toEqual({ missing: true })
  })

  it('refuses admit when capacity is full', async () => {
    const fake = createFakeOpencodeClient()
    setDaemonClient(fake.client)
    const task = createWorkTask({ title: 'fill capacity', pipeline: ['implement'] }, store)
    startWorkTaskRun(task.id, 'implement', 'ses_running', 'implement', store)
    await expect(admitOpenCodeSession({ title: 'nope', purpose: 'worker' }, createOpenCodeSessionRuntime(fake.client)))
      .rejects.toThrow(/capacity full/)
  })

  it('admits when under capacity and writes receipt', async () => {
    const fake = createFakeOpencodeClient()
    setDaemonClient(fake.client)
    const result = await admitOpenCodeSession({ title: 'ok', agent: 'build', purpose: 'interactive' }, createOpenCodeSessionRuntime(fake.client))
    expect(result.sessionId).toBeTruthy()
    expect(result.admissionId).toMatch(/^adm_/)
  })

  it('bounds repeated admits by counting live admitted sessions (not a free-spawn API)', async () => {
    // Idle scheduler (no runs). maxConcurrent=1 → worker admit limit=1. The gate
    // must count the sessions IT admits, so the second worker admit is refused
    // even though there is no scheduler run. On the old gate (which counted only
    // runs/channel sessions) this loop was unbounded.
    const fake = createFakeOpencodeClient()
    setDaemonClient(fake.client)
    const runtime = createOpenCodeSessionRuntime(fake.client)
    const first = await admitOpenCodeSession({ purpose: 'worker' }, runtime)
    expect(first.sessionId).toBeTruthy()
    await expect(admitOpenCodeSession({ purpose: 'worker' }, runtime)).rejects.toThrow(/capacity full/)
  })

  it('refuses an admit whose directory is not an absolute path', async () => {
    const fake = createFakeOpencodeClient()
    setDaemonClient(fake.client)
    await expect(admitOpenCodeSession({ purpose: 'worker', directory: 'relative/evil' }, createOpenCodeSessionRuntime(fake.client)))
      .rejects.toThrow(/absolute path/)
  })

  it('aborts and durably leaves a reconcilable intent when leadership changes during creation', async () => {
    let now = 1_000
    const writer = createDaemonLeadership({ filePath: store, daemonId: 'admit-a', instanceId: 'admit-a:1', leaseMs: 10_000, now: () => now })
    expect(writer.acquireOrRenew().canWrite).toBe(true)
    setCurrentDaemonLeadership(writer)
    setWorkDbLeadershipEpochProvider(() => writer.captureEpoch())
    const aborted: string[] = []
    const deleted: string[] = []
    let successor: ReturnType<typeof createDaemonLeadership> | undefined
    const runtime: OpenCodeSessionRuntime = {
      async createSession() {
        now += 10_001
        successor = createDaemonLeadership({ filePath: store, daemonId: 'admit-b', instanceId: 'admit-b:1', leaseMs: 10_000, now: () => now })
        expect(successor.acquireOrRenew().canWrite).toBe(true)
        return { id: 'ses_raced' }
      },
      async getSession(sessionId) { return { missing: aborted.includes(sessionId) } },
      async listSessions() { return [] },
      async prompt() {},
      async abort(sessionId) { aborted.push(sessionId) },
      async deleteSession(sessionId) { deleted.push(sessionId) },
      async messages() { return [] },
    }

    await expect(admitOpenCodeSession({ title: 'raced', purpose: 'interactive' }, runtime))
      .rejects.toThrow('cleanup verified')
    expect(aborted).toEqual(['ses_raced'])
    expect(deleted).toEqual(['ses_raced'])

    setCurrentDaemonLeadership(successor!)
    setWorkDbLeadershipEpochProvider(() => successor!.captureEpoch())
    const reconciled = await reconcilePendingSessionAdmissions(runtime, { now: Date.now() + 2_000, graceMs: 1_000 })
    expect(reconciled).toMatchObject({ checked: 1, cleaned: 1, retained: 0 })
    const db = new DatabaseSync(store, { readOnly: true })
    expect((db.prepare('SELECT status FROM session_admissions').get() as { status: string }).status).toBe('failed')
    db.close()
  })
})
