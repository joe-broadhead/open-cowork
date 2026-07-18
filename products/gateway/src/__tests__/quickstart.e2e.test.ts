import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Message, Part } from '@opencode-ai/sdk'
import { createDaemonHttpServer } from '../daemon.js'
import { createJsonRoutes } from '../daemon-routes/index.js'
import { buildAssistantMessage, createFakeOpencodeClient } from './helpers/typed-opencode-client.js'
import { clearConfigCacheForTest, updateConfig } from '../config.js'
import { clearWorkStateForTest, loadWorkState } from '../work-store.js'
import { clearCurrentDaemonLeadershipForTest } from '../daemon-leadership.js'
import { clearMissionDataCacheForTest } from '../mission-data.js'
import { localHttpAdminTokenFilePath } from '../security.js'
import { runQuickstart, type QuickstartGateway, type QuickstartNarrator } from '../quickstart.js'

/**
 * End-to-end acceptance for the guided first-run: boot the REAL Gateway daemon
 * HTTP server (createDaemonHttpServer, the same handler daemon.ts serves in
 * production) on an ephemeral port with a FAKED OpenCode SDK client (the typed
 * helper), then drive the exported `runQuickstart` core against it and assert a
 * fresh operator reaches a real completed task with a run id + dashboard link.
 * A second test proves the preflight-failure path stops BEFORE creating work.
 */
describe.sequential('quickstart guided first-run (real daemon, faked OpenCode)', () => {
  // Fake OpenCode: on session.messages return a fenced-json pass result so the
  // scheduler's completeRunningRuns marks the single-stage run as passed.
  const fake = createFakeOpencodeClient({
    messagesFor: () => [passMessage()],
  })
  let server: http.Server
  let port = 0
  let baseUrl = ''
  let testDir = ''

  beforeAll(async () => {
    server = createDaemonHttpServer({
      client: fake.client,
      channels: new Map(),
      routes: createJsonRoutes(),
      resolvePort: () => port,
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    port = (server.address() as AddressInfo).port
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-quickstart-e2e-'))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    clearMissionDataCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
    clearCurrentDaemonLeadershipForTest()
    // Real token flow: the daemon accepts the token from the admin-token FILE
    // (the same env `opencode-gateway start` passes to the spawned daemon). The
    // quickstart flow provisions the file; the CLI-side gateway resolves the
    // token from that same file — no hand-injected env token or header value the
    // real flow never sets.
    process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE'] = localHttpAdminTokenFilePath()
    // Point dashboard links + config at the ephemeral daemon port.
    updateConfig({ httpPort: port } as any)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE']
    clearConfigCacheForTest()
    clearCurrentDaemonLeadershipForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('drives preflight -> initiative -> dispatch -> completed run with a run id + dashboard link', async () => {
    const narration = captureNarrator()
    const result = await runQuickstart({
      gateway: httpGateway(baseUrl),
      narrator: narration.narrator,
      // OpenCode is faked at the SDK level (no HTTP server), so the reachability
      // probe is injected to report the fake as reachable.
      probeOpencode: async () => ({ ok: true, version: 'fake' }),
      pollIntervalMs: 20,
      timeoutMs: 15_000,
    })

    // Preflight passed.
    expect(result.preflight.ok).toBe(true)
    expect(result.outcome).toBe('completed')
    expect(result.ok).toBe(true)

    // A real initiative + task were created and reached a passed run.
    expect(result.roadmapId).toBeTruthy()
    expect(result.taskId).toBeTruthy()
    expect(result.runId).toBeTruthy()
    expect(result.runStatus).toBe('passed')
    expect(result.taskStatus).toBe('done')

    // The durable store proves it: one roadmap, one done task, one passed run.
    const state = loadWorkState(path.join(testDir, 'gateway.db'))
    expect(state.roadmaps.map(r => r.id)).toContain(result.roadmapId)
    const task = state.tasks.find(t => t.id === result.taskId)
    expect(task?.status).toBe('done')
    expect(state.runs.some(run => run.id === result.runId && run.status === 'passed')).toBe(true)

    // The narration/result surface the run id + dashboard drill-down link.
    expect(result.runUrl).toContain(`view=run&id=${encodeURIComponent(result.runId!)}`)
    expect(result.runUrl).toContain(`127.0.0.1:${port}`)
    const output = narration.lines.join('\n')
    expect(output).toContain(result.runId!)
    expect(output).toContain('view=run')
    expect(output.toLowerCase()).toContain('completed')
    // Next steps point at the real follow-on surfaces.
    expect(result.nextSteps.join('\n')).toMatch(/triage/)
    expect(result.nextSteps.join('\n')).toMatch(/analytics/)
  })

  it('surfaces a mid-flow dispatch failure: work is created + surfaced, no bare Fatal', async () => {
    // Auth is provisioned correctly (write-access check passes), the task is
    // created durably, then the dispatch WRITE fails (daemon returns non-2xx,
    // which the real gateway throws on). The guided flow must surface the created
    // roadmap/task + link + actionable message and return the typed outcome —
    // never a bare Fatal and never silent orphaned work.
    const real = httpGateway(baseUrl)
    const gateway: QuickstartGateway = {
      ...real,
      dispatchNow: async () => { throw new Error('HTTP 500') },
    }
    const narration = captureNarrator()
    const result = await runQuickstart({
      gateway,
      narrator: narration.narrator,
      probeOpencode: async () => ({ ok: true, version: 'fake' }),
      pollIntervalMs: 20,
      timeoutMs: 5_000,
    })

    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('dispatch_failed')

    // The work was created and is durable in the store.
    expect(result.roadmapId).toBeTruthy()
    expect(result.taskId).toBeTruthy()
    const state = loadWorkState(path.join(testDir, 'gateway.db'))
    expect(state.roadmaps.map(r => r.id)).toContain(result.roadmapId)
    expect(state.tasks.map(t => t.id)).toContain(result.taskId)

    // The created work is surfaced with a drill-down link + actionable next steps.
    expect(result.taskUrl).toContain('view=task')
    expect(result.nextSteps.join('\n')).toMatch(/quickstart|doctor|start/i)
    const output = narration.lines.join('\n')
    expect(output).toContain(result.taskId!)
    expect(output).toMatch(/Dispatch failed/i)
  })

  it('stops on a preflight failure (OpenCode unreachable) with an actionable message and no orphaned work', async () => {
    const narration = captureNarrator()
    const result = await runQuickstart({
      gateway: httpGateway(baseUrl),
      narrator: narration.narrator,
      probeOpencode: async () => ({ ok: false, detail: 'connection refused' }),
      pollIntervalMs: 20,
      timeoutMs: 5_000,
    })

    expect(result.ok).toBe(false)
    expect(result.outcome).toBe('preflight_failed')
    // No initiative/task/run was created.
    expect(result.roadmapId).toBeUndefined()
    expect(result.taskId).toBeUndefined()
    const state = loadWorkState(path.join(testDir, 'gateway.db'))
    expect(state.roadmaps).toHaveLength(0)
    expect(state.tasks).toHaveLength(0)
    expect(state.runs).toHaveLength(0)

    // The message is actionable: it names the OpenCode fix.
    const failing = result.preflight.checks.find(check => check.id === 'opencode')
    expect(failing?.ok).toBe(false)
    expect(failing?.fix).toMatch(/opencode serve|opencodeUrl/i)
    expect(result.nextSteps.join('\n')).toMatch(/opencode/i)
    const output = narration.lines.join('\n')
    expect(output).toMatch(/FAIL/)
    expect(output).toMatch(/Fix:/)
  })
})

function passMessage(): { info: Message; parts: Part[] } {
  const info = buildAssistantMessage({ id: 'msg_pass', sessionID: 'ses_quickstart' })
  const payload = JSON.stringify({
    status: 'pass',
    summary: 'Summarized the repository: components, build/test flow, and two improvement ideas.',
    artifacts: ['note:repo-summary'],
    evidence: [{ type: 'note', ref: 'note:repo-summary', summary: 'Repository summary produced by the quickstart run.' }],
  })
  const parts = [{ id: 'part_pass', sessionID: 'ses_quickstart', messageID: 'msg_pass', type: 'text', text: '```json\n' + payload + '\n```' }] as unknown as Part[]
  return { info, parts }
}

function captureNarrator(): { narrator: QuickstartNarrator; lines: string[] } {
  const lines: string[] = []
  const push = (message: string) => { lines.push(message) }
  return {
    lines,
    narrator: { step: push, detail: push, success: push, warn: push },
  }
}

// Resolve the daemon bearer token the way the real CLI does: read it from the
// local admin-token file (`<configDir>/http-admin-token`), which the quickstart
// flow provisions. No hardcoded/hand-injected token.
function authHeaders(): Record<string, string> {
  try {
    const token = fs.readFileSync(localHttpAdminTokenFilePath(), 'utf-8').trim()
    return token ? { Authorization: `Bearer ${token}` } : {}
  } catch {
    return {}
  }
}

function httpGateway(baseUrl: string): QuickstartGateway {
  return {
    getHealth: async () => {
      const res = await fetch(`${baseUrl}/health`, { headers: authHeaders() })
      if (!res.ok) return { ok: false }
      const body = await res.json().catch(() => ({})) as { uptime?: number }
      return { ok: true, uptimeSeconds: body.uptime }
    },
    // Mirror production postGatewayJson: THROW on a non-2xx write so a 403/500 is
    // never swallowed by the guided flow.
    dispatchNow: async input => {
      const res = await fetch(`${baseUrl}/workflows/dispatch-now`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify(input),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json() as Promise<Awaited<ReturnType<QuickstartGateway['dispatchNow']>>>
    },
    getTask: async taskId => {
      const res = await fetch(`${baseUrl}/tasks/${encodeURIComponent(taskId)}`, { headers: authHeaders() })
      if (!res.ok) return null
      const body = await res.json().catch(() => ({})) as { task?: any }
      return body.task ?? null
    },
    // Same probe the CLI uses: a bogus-task dispatch is auth-checked first (403)
    // and otherwise 404s before any scheduler cycle — a safe write-auth check.
    checkWriteAccess: async () => {
      const res = await fetch(`${baseUrl}/workflows/dispatch-now`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ taskId: '__quickstart_write_probe__' }),
      })
      if (res.status === 403) return { ok: false, status: 403 }
      return { ok: true, status: res.status }
    },
  }
}
