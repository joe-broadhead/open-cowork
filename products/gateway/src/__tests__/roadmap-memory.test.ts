import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildRoadmapMemory, formatRoadmapMemory } from '../roadmap-memory.js'
import { clearWorkStateForTest, completeWorkTaskRun, createRoadmap, createWorkTask, startWorkTaskRun } from '../work-store.js'
import type { EnvironmentRunRecord } from '../environments.js'

describe('roadmap memory', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-roadmap-memory-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const store = path.join(testDir, 'gateway.db')

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearWorkStateForTest(store)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
  })

  it('summarizes roadmap decisions, evidence, failures, and recent tasks', () => {
    const roadmap = createRoadmap({ title: 'Launch memory' }, store)
    const task = createWorkTask({ title: 'Verify launch', roadmapId: roadmap.id, pipeline: ['verify'] }, store)
    const started = startWorkTaskRun(task.id, 'verify', 'ses_verify', 'verifier', store, {}, { environment: envRun({ artifacts: ['artifact://env-log'] }) })!
    completeWorkTaskRun(started.run.id, { status: 'fail', summary: 'test failed', feedback: 'fix npm test', failureClass: 'verification_failed', artifacts: ['npm test'], evidence: [{ type: 'test', ref: 'npm test', summary: 'failed output' }], decisions: ['Keep launch behind flag'], raw: '{}' }, 2, store)

    const memory = buildRoadmapMemory(roadmap.id, undefined, Date.parse('2026-06-13T00:00:00.000Z'))!

    expect(memory.summary).toContain('failure')
    expect(memory.decisions).toContain('Keep launch behind flag')
    expect(memory.evidence.join('\n')).toContain('npm test')
    expect(memory.evidence.join('\n')).toContain('environment local-process/local-node')
    expect(memory.evidence.join('\n')).toContain('artifact://env-log')
    expect(memory.failures.join('\n')).toContain('verification_failed')
    expect(formatRoadmapMemory(memory)).toContain('Roadmap memory: Launch memory')
  })
})

function envRun(overrides: Partial<EnvironmentRunRecord> = {}): EnvironmentRunRecord {
  return {
    id: 'env_memory',
    name: 'local-node',
    backend: 'local-process',
    status: 'prepared',
    specHash: 'abc123',
    workdir: '/tmp/project',
    runtime: process.execPath,
    startedAt: '2026-06-14T00:00:00.000Z',
    updatedAt: '2026-06-14T00:00:00.000Z',
    ttlMs: 3600000,
    cleanup: { retainOnFailure: false, retainOnSuccess: false, state: 'pending' },
    resources: { timeoutMs: 3600000 },
    network: { mode: 'restricted' },
    secrets: { allowedNames: [] },
    preflight: { ok: true, checked: ['node'], missing: [], warnings: [], commandRefs: ['command -v node'] },
    artifacts: [],
    metadata: {},
    ...overrides,
  }
}
