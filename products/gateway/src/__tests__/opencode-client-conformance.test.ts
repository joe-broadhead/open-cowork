import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { schedulerCycle } from '../scheduler.js'
import { clearConfigCacheForTest } from '../config.js'
import { clearWorkStateForTest, createWorkTask, loadWorkState } from '../work-store.js'
import { clearEventsForTest } from '../wakeup.js'
import { clearWorkersForTest } from '../workers.js'
import { clearInFlightSupervisorPromptsForTest } from '../scheduler.js'
import { clearCurrentDaemonLeadershipForTest } from '../daemon-leadership.js'
import { buildAssistantMessage, buildFakeSession, createFakeOpencodeClient, type UsedSessionApi } from './helpers/typed-opencode-client.js'

// Conformance test for the typed OpencodeClient fake.
//
// (1) Compile-time: the assignments below prove the fake's `client` really is
//     an `OpencodeClient` and that `UsedSessionApi` matches the session surface
//     the scheduler/daemon call. If the SDK renames/removes any used method,
//     `UsedSessionApi` (in the helper) fails to compile; if the method
//     signatures drift, `schedulerAcceptsFake` below fails to compile.
// (2) Runtime: driving the REAL `schedulerCycle` with the fake proves it is
//     structurally accepted wherever an `OpencodeClient` is required and that a
//     full dispatch cycle works against it — no `as any` anywhere.

// Compile-time tripwire: schedulerCycle demands an OpencodeClient; the fake's
// client must satisfy it with no cast.
const schedulerAcceptsFake: (c: OpencodeClient) => Promise<unknown> = schedulerCycle
void schedulerAcceptsFake

// Compile-time tripwire: the used-session surface must include exactly the
// methods the product calls; drop one and this object errors.
const _sessionSurface: Record<keyof UsedSessionApi, true> = {
  create: true,
  get: true,
  list: true,
  messages: true,
  prompt: true,
  promptAsync: true,
  abort: true,
  delete: true,
}
void _sessionSurface

describe('typed OpencodeClient fake conformance', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-sdk-fake-'))
  const store = path.join(testDir, 'gateway.db')

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearWorkStateForTest(store)
    clearWorkersForTest()
    clearEventsForTest()
    clearConfigCacheForTest()
    clearCurrentDaemonLeadershipForTest()
    clearInFlightSupervisorPromptsForTest()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    clearConfigCacheForTest()
    clearCurrentDaemonLeadershipForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('builders produce structurally valid SDK records', () => {
    const session = buildFakeSession({ id: 'ses_1', title: 'GW: x' })
    expect(session).toMatchObject({ id: 'ses_1', projectID: expect.any(String), directory: expect.any(String), version: expect.any(String) })
    expect(typeof session.time.created).toBe('number')

    const message = buildAssistantMessage({ id: 'msg_1', sessionID: 'ses_1' })
    expect(message).toMatchObject({ role: 'assistant', tokens: { cache: { read: 0, write: 0 } } })
  })

  it('packages the upgraded @opencode-ai/sdk with createOpencodeClient export', async () => {
    const mod = await import('@opencode-ai/sdk')
    expect(typeof mod.createOpencodeClient).toBe('function')
    // Pin body: install must be >= 1.17.16 from Phase 0; monorepo may resolve 1.18.x+.
    const pkgPath = new URL('../../node_modules/@opencode-ai/sdk/package.json', import.meta.url)
    const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(pkgPath, 'utf8')) as { version: string }
    const parts = String(pkg.version).split('.').map(n => Number(n))
    const major = parts[0] ?? 0
    const minor = parts[1] ?? 0
    const patch = parts[2] ?? 0
    expect(major).toBeGreaterThanOrEqual(1)
    const atLeast11716 =
      major > 1
      || (major === 1 && minor > 17)
      || (major === 1 && minor === 17 && patch >= 16)
    expect(atLeast11716, `expected @opencode-ai/sdk >= 1.17.16, got ${pkg.version}`).toBe(true)
  })

  it('drives a real scheduler cycle end to end (fake accepted as OpencodeClient)', async () => {
    createWorkTask({ title: 'Conformance dispatch task', priority: 'HIGH', pipeline: ['implement'] }, store)
    const handle = createFakeOpencodeClient()

    const state = await schedulerCycle(handle.client)

    // The scheduler used the fake to create a session and prompt it.
    expect(handle.creates.length).toBeGreaterThan(0)
    expect(handle.prompts.length).toBeGreaterThan(0)
    // A run row now exists tied to a real session id the fake minted.
    const runs = loadWorkState(store).runs || []
    expect(runs.length).toBeGreaterThan(0)
    expect(state.tasks.length).toBeGreaterThan(0)
  })
})
