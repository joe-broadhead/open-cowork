import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createHeadlessHostStatusOutput,
  planHeadlessHostRequest,
  readHeadlessHostState,
  runHeadlessHostCommand,
  writeHeadlessHostState,
} from '../apps/desktop/src/main/headless-host.ts'
import {
  buildDetachedHeadlessHostArgs,
  parseArgs,
} from '../scripts/headless-host.ts'

test('headless host planner allows loopback check mode and blocks remote binding', () => {
  assert.deepEqual(planHeadlessHostRequest({
    mode: 'check',
    topology: 'loopback',
    bindHost: '127.0.0.1',
    port: 0,
  }), {
    ok: true,
    mode: 'check',
    topology: 'loopback',
    bindHost: '127.0.0.1',
    port: 0,
    reasonCode: 'headless-loopback-check-ready',
  })

  assert.equal(planHeadlessHostRequest({
    mode: 'start',
    topology: 'lan',
    bindHost: '0.0.0.0',
    port: 8787,
  }).reasonCode, 'headless-remote-binding-blocked')

  assert.equal(planHeadlessHostRequest({
    mode: 'status',
    port: 70_000,
  }).reasonCode, 'headless-invalid-port')
})

test('headless host status output redacts tokens and home paths', () => {
  const openRouterKey = 'sk-or-v1-' + 'abcdefghijklmnopqrstuvwxyz1234567890'
  const queryToken = 'abcdefghijklmnopqrstuvwxyz' + '1234567890'
  const status = createHeadlessHostStatusOutput({
    request: { mode: 'doctor' },
    runtimeStatus: {
      ready: false,
      phase: 'error',
      error: 'Authorization: Bearer token-secret-value at /Users/alice/private',
      updatedAt: '2026-06-02T00:00:00.000Z',
      checks: [{
        code: 'runtime.auth',
        severity: 'error',
        status: 'fail',
        message: `${openRouterKey} at /Users/alice/private`,
        evidence: {
          url: `https://example.test/path?token=${queryToken}`,
        },
        updatedAt: '2026-06-02T00:00:00.000Z',
      }],
    },
  })
  const serialized = JSON.stringify(status)

  assert.equal(serialized.includes('token-secret-value'), false)
  assert.equal(serialized.includes('/Users/alice'), false)
  assert.equal(serialized.includes(queryToken), false)
  assert.equal(status.redacted, true)
})

test('headless host check runs injected lifecycle and persists redacted state', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'open-cowork-headless-state-'))
  const calls: string[] = []
  let runtimeReady = false
  try {
    const result = await runHeadlessHostCommand({
      mode: 'check',
      stateDir,
      workspaceRoot: '/Users/alice/project',
    }, {
      startRuntime: async (workspaceRoot) => {
        calls.push(`start:${workspaceRoot}`)
      },
      stopRuntime: async () => {
        calls.push('stop')
      },
      setRuntimeReady: (ready) => {
        runtimeReady = ready
      },
      runtimeStatus: () => ({
        ready: runtimeReady,
        phase: runtimeReady ? 'ready' : 'environment',
        error: runtimeReady ? null : 'waiting',
        updatedAt: '2026-06-02T00:00:00.000Z',
        timeline: [],
        checks: [],
      }),
      now: () => new Date('2026-06-02T00:00:00.000Z'),
    })

    assert.equal(result.ok, true)
    assert.equal(result.reasonCode, 'headless-runtime-check-passed')
    assert.deepEqual(calls, ['start:/Users/alice/project', 'stop'])
    assert.equal(result.status.runtime.ready, true)
    assert.equal(result.state?.redacted, true)

    const saved = await readHeadlessHostState(stateDir)
    assert.equal(saved?.hostId, 'headless-loopback-127.0.0.1-0')
    assert.equal(saved?.status.runtime.ready, true)

    const status = await runHeadlessHostCommand({ mode: 'status', stateDir }, {
      runtimeStatus: () => ({
        ready: false,
        phase: 'environment',
        error: null,
        updatedAt: '2026-06-02T00:00:01.000Z',
        timeline: [],
        checks: [],
      }),
    })
    assert.equal(status.reasonCode, 'headless-status-read')
    assert.equal(status.state?.status.runtime.ready, true)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('headless host command blocks unsafe start modes and redacts doctor output', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'open-cowork-headless-state-'))
  const openRouterKey = 'sk-or-v1-' + 'abcdefghijklmnopqrstuvwxyz1234567890'
  try {
    let started = false
    const blocked = await runHeadlessHostCommand({
      mode: 'check',
      topology: 'remote',
      bindHost: '0.0.0.0',
      stateDir,
    }, {
      startRuntime: async () => {
        started = true
      },
      runtimeStatus: () => ({
        ready: false,
        phase: 'environment',
        error: null,
        updatedAt: '2026-06-02T00:00:00.000Z',
        timeline: [],
        checks: [],
      }),
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.reasonCode, 'headless-remote-binding-blocked')
    assert.equal(started, false)

    const startResult = await runHeadlessHostCommand({ mode: 'start', stateDir }, {
      startRuntime: async () => {
        started = true
      },
      stopRuntime: async () => {
        started = false
      },
      setRuntimeReady: (ready) => {
        started = ready
      },
      runtimeStatus: () => ({
        ready: started,
        phase: started ? 'ready' : 'environment',
        error: null,
        updatedAt: '2026-06-02T00:00:00.000Z',
        timeline: [],
        checks: [],
      }),
      waitForStop: async (state) => {
        assert.equal(state.mode, 'start')
        assert.equal((await readHeadlessHostState(stateDir))?.mode, 'start')
      },
    })
    assert.equal(startResult.reasonCode, 'headless-stopped')
    assert.equal(await readHeadlessHostState(stateDir), null)

    const doctor = await runHeadlessHostCommand({ mode: 'doctor', stateDir }, {
      diagnosticsBundle: () => 'Authorization: Bearer token-secret-value at /Users/alice/private',
      runtimeStatus: () => ({
        ready: false,
        phase: 'error',
        error: openRouterKey,
        updatedAt: '2026-06-02T00:00:00.000Z',
        timeline: [],
        checks: [],
      }),
    })
    assert.equal(doctor.reasonCode, 'headless-doctor-ready')
    assert.equal(JSON.stringify(doctor).includes('token-secret-value'), false)
    assert.equal(JSON.stringify(doctor).includes('/Users/alice'), false)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('headless host stop signals a running start process and clears state', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'open-cowork-headless-state-'))
  try {
    const status = createHeadlessHostStatusOutput({
      request: { mode: 'start', stateDir },
      runtimeStatus: {
        ready: true,
        phase: 'ready',
        error: null,
        updatedAt: '2026-06-02T00:00:00.000Z',
        timeline: [],
        checks: [],
      },
    })
    const state = await writeHeadlessHostState({ mode: 'start', stateDir }, status, {
      stateDir,
      now: new Date('2026-06-02T00:00:00.000Z'),
    })
    writeFileSync(join(stateDir, 'state.json'), `${JSON.stringify({ ...state, pid: 12345 }, null, 2)}\n`)

    const signals: Array<{ pid: number; signal: string }> = []
    const stopped = await runHeadlessHostCommand({ mode: 'stop', stateDir }, {
      signalProcess: (pid, signal) => {
        signals.push({ pid, signal })
      },
      processExists: (pid) => pid === 12345,
      stopRuntime: async () => {},
      runtimeStatus: () => ({
        ready: false,
        phase: 'environment',
        error: null,
        updatedAt: '2026-06-02T00:00:01.000Z',
        timeline: [],
        checks: [],
      }),
    })

    assert.equal(stopped.reasonCode, 'headless-stopped')
    assert.deepEqual(signals, [{ pid: 12345, signal: 'SIGTERM' }])
    assert.equal(await readHeadlessHostState(stateDir), null)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('headless host status clears stale start state when the recorded process is gone', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'open-cowork-headless-state-'))
  try {
    const status = createHeadlessHostStatusOutput({
      request: { mode: 'start', stateDir },
      runtimeStatus: {
        ready: true,
        phase: 'ready',
        error: null,
        updatedAt: '2026-06-02T00:00:00.000Z',
        timeline: [],
        checks: [],
      },
    })
    const state = await writeHeadlessHostState({ mode: 'start', stateDir }, status, {
      stateDir,
      now: new Date('2026-06-02T00:00:00.000Z'),
    })
    writeFileSync(join(stateDir, 'state.json'), `${JSON.stringify({ ...state, pid: 12345 }, null, 2)}\n`)

    const checked = await runHeadlessHostCommand({ mode: 'status', stateDir }, {
      processExists: () => false,
      runtimeStatus: () => ({
        ready: false,
        phase: 'environment',
        error: null,
        updatedAt: '2026-06-02T00:00:01.000Z',
        timeline: [],
        checks: [],
      }),
    })

    assert.equal(checked.ok, false)
    assert.equal(checked.reasonCode, 'headless-state-stale')
    assert.equal(checked.state, null)
    assert.equal(await readHeadlessHostState(stateDir), null)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('headless host CLI detached mode launches a foreground child request', () => {
  const parsed = parseArgs([
    'start',
    '--detached',
    '--workspace',
    '/tmp/project',
    '--state-dir',
    '/tmp/headless-state',
    '--port',
    '0',
  ])
  assert.equal(parsed.request.detached, true)
  assert.deepEqual(buildDetachedHeadlessHostArgs(parsed.request), [
    'start',
    '--port',
    '0',
    '--workspace',
    '/tmp/project',
    '--state-dir',
    '/tmp/headless-state',
  ])
})

test('headless host detached start leaves recoverable state for later status and stop', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'open-cowork-headless-state-'))
  const calls: string[] = []
  let runtimeReady = false
  try {
    const started = await runHeadlessHostCommand({
      mode: 'start',
      stateDir,
      detached: true,
      workspaceRoot: '/Users/alice/project',
    }, {
      startRuntime: async (workspaceRoot) => {
        calls.push(`start:${workspaceRoot}`)
      },
      stopRuntime: async () => {
        calls.push('stop')
      },
      setRuntimeReady: (ready) => {
        runtimeReady = ready
      },
      runtimeStatus: () => ({
        ready: runtimeReady,
        phase: runtimeReady ? 'ready' : 'environment',
        error: null,
        updatedAt: '2026-06-02T00:00:00.000Z',
        timeline: [],
        checks: [],
      }),
      waitForStop: async () => {
        calls.push('wait')
      },
      now: () => new Date('2026-06-02T00:00:00.000Z'),
    })

    assert.equal(started.reasonCode, 'headless-detached-started')
    assert.deepEqual(calls, ['start:/Users/alice/project'])
    assert.equal(started.state?.detached, true)

    const status = await runHeadlessHostCommand({ mode: 'status', stateDir }, {
      runtimeStatus: () => ({
        ready: false,
        phase: 'environment',
        error: null,
        updatedAt: '2026-06-02T00:00:01.000Z',
        timeline: [],
        checks: [],
      }),
    })
    assert.equal(status.reasonCode, 'headless-status-read')
    assert.equal(status.state?.detached, true)
    assert.equal(status.state?.status.runtime.ready, true)

    const stopped = await runHeadlessHostCommand({ mode: 'stop', stateDir }, {
      stopRuntime: async () => {
        calls.push('stop')
      },
      setRuntimeReady: (ready) => {
        runtimeReady = ready
      },
      runtimeStatus: () => ({
        ready: runtimeReady,
        phase: runtimeReady ? 'ready' : 'environment',
        error: null,
        updatedAt: '2026-06-02T00:00:02.000Z',
        timeline: [],
        checks: [],
      }),
    })
    assert.equal(stopped.reasonCode, 'headless-stopped')
    assert.equal(await readHeadlessHostState(stateDir), null)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('readHeadlessHostState distinguishes a corrupt state file from no host running', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'headless-corrupt-'))
  try {
    // No file at all → genuinely no host running.
    assert.equal(await readHeadlessHostState(stateDir), null)

    // A truncated/corrupt state file must NOT read as "no host" (that would orphan a live runtime);
    // it surfaces instead so the caller can refuse to start a duplicate.
    writeFileSync(join(stateDir, 'state.json'), '{ "schemaVersion": 1, "redact')
    await assert.rejects(() => readHeadlessHostState(stateDir), /corrupt/)

    // A parseable but schema-incompatible state is still treated as no usable host.
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ schemaVersion: 999, redacted: true }))
    assert.equal(await readHeadlessHostState(stateDir), null)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
