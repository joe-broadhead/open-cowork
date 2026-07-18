import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest } from '../config.js'
import { recordWorkerCompletion } from '../observability.js'
import { buildSupervisorObservability, formatSupervisorObservability } from '../supervisor-observability.js'
import { appendWorkEvent, clearWorkStateForTest, createRoadmap, createRoadmapSupervisor, loadWorkState, proposeRoadmapCompletion, upsertProjectBinding } from '../work-store.js'

describe('observability', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-observability-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN']
    clearConfigCacheForTest()
  })

  it('uses canonical scheduler status instead of inferring from assistant text', async () => {
    await recordWorkerCompletion(client('This prompt mentions blocked in the schema but the run passed.'), {
      id: 'ses_passed',
      title: 'Parser stress [verify]',
      stage: 'verify',
      retries: 0,
      status: 'completed',
      summary: 'canonical pass',
    } as any)

    const lines = fs.readFileSync(path.join(testDir, 'observability', 'executions.jsonl'), 'utf-8').trim().split('\n')
    const row = JSON.parse(lines.at(-1)!)

    expect(row.status).toBe('completed')
    expect(row.lastMessage).toBe('canonical pass')
  })

  it('redacts observability artifacts and writes them with private permissions', async () => {
    process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'] = 'super-secret-http-token'
    await recordWorkerCompletion(client('Authorization: Bearer super-secret-http-token'), {
      id: 'ses_secret',
      title: 'Secret handling [verify]',
      stage: 'verify',
      retries: 0,
      status: 'failed',
      summary: 'failed with token=abc123 and Bearer super-secret-http-token',
    } as any)

    const execFile = path.join(testDir, 'observability', 'executions.jsonl')
    const combined = fs.readFileSync(execFile, 'utf-8')

    expect(combined).toContain('Bearer <redacted>')
    expect(combined).toContain('token=<redacted>')
    expect(combined).not.toContain('super-secret-http-token')
    expect(combined).not.toContain('abc123')
    expect((fs.statSync(execFile).mode & 0o777).toString(8)).toBe('600')
  })

  it('summarizes supervisor health and recent audit events', () => {
    const roadmap = createRoadmap({ title: 'Observed supervisor' })
    const supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_supervisor', nextReviewAt: '2000-01-01T00:00:00.000Z' })
    upsertProjectBinding({ alias: 'observed', roadmapId: roadmap.id, sessionId: supervisor.sessionId })
    proposeRoadmapCompletion({ roadmapId: roadmap.id, evidence: ['verify'], recommendation: 'ready' })
    appendWorkEvent('roadmap.supervisor.result_applied', roadmap.id, { supervisorId: supervisor.supervisorId, status: 'ok' })

    const report = buildSupervisorObservability(loadWorkState(), { now: Date.parse('2026-06-13T00:00:00.000Z') })
    const text = formatSupervisorObservability(report)

    expect(report.summary).toMatchObject({ total: 1, active: 1, due: 1, pendingCompletionProposals: 1 })
    expect(report.supervisors[0]).toMatchObject({ alias: 'observed', health: 'due', pendingCompletionProposals: 1 })
    expect(report.auditEvents.map(event => event.type)).toEqual(expect.arrayContaining(['roadmap.supervisor.result_applied', 'roadmap.completion.proposed']))
    expect(text).toContain('Supervisor Observability')
    expect(text).toContain('[due] observed')
  })
})

function client(text: string): any {
  return {
    session: {
      get: async () => ({ data: { agent: 'gateway-verifier', model: { modelID: 'model', providerID: 'provider' }, cost: 0, tokens: {}, time: { created: Date.now() } } }),
      messages: async () => ({ data: [{ parts: [{ type: 'text', text }] }] }),
    },
  }
}
