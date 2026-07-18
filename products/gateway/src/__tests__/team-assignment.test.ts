import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createTeamTaskAssignments, getTeamTaskAssignment, listTeamTaskAssignments, recordTeamAssignmentReceipt } from '../team-assignment.js'
import { clearConfigCacheForTest, type AgentProfile } from '../config.js'
import type { OpenCodeAssetAvailability } from '../access-inspection.js'
import { appendWorkEvents, clearWorkStateForTest, createRoadmap, createWorkTask, listWorkEvents, startWorkTaskRun } from '../work-store.js'

describe('team task assignments', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-team-assignment-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const blueprintDir = path.join(testDir, 'blueprints')
  const now = new Date('2026-06-15T12:00:00.000Z')
  const availability: OpenCodeAssetAvailability = {
    agents: new Set(),
    skills: new Set(),
    mcpServers: new Set(),
    tools: new Set(),
    source: 'provided',
  }

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(blueprintDir, { recursive: true })
    clearConfigCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
  })

  it('creates deterministic assignments for assembled team members with budgets, scope, gates, and evidence', () => {
    writeBlueprint(promotedBlueprint())
    const task = createWorkTask({ title: 'Assigned delivery task' })

    const first = createTeamTaskAssignments({
      idempotencyKey: 'assign:req:delivery:1',
      objective: 'Execute the bounded team delivery task.',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      taskId: task.id,
      roadmapId: task.roadmapId,
      sessionId: 'ses_parent',
      roles: [{ role: 'implement' }, { role: 'verify' }],
      grants: [
        { role: 'implement', tools: ['gateway_task_update'], reason: 'Task mutation for implementation.' },
        { role: 'verify', skills: ['gateway-review-gate'], tools: ['gateway_task_update'], reason: 'Review validation.' },
      ],
      budget: { maxRuntimeMs: 600000, maxTokens: 120000, maxCostUsd: 12, retryLimit: 2 },
      gates: [
        { id: 'review-pass', type: 'review', requiredBefore: 'complete' },
        { id: 'evidence-present', type: 'evidence', requiredBefore: 'complete' },
        { id: 'quality', type: 'completion_quality', requiredBefore: 'complete', criteria: 'Meets acceptance criteria.' },
      ],
      evidenceRequirements: [{ id: 'validation', type: 'command', summary: 'Validation command output' }],
    }, { blueprintDirs: [blueprintDir], availability, now })
    const replay = createTeamTaskAssignments({
      idempotencyKey: 'assign:req:delivery:1',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      taskId: task.id,
      roadmapId: task.roadmapId,
      sessionId: 'ses_parent',
    }, { blueprintDirs: [blueprintDir], availability, now })

    expect(first.ok).toBe(true)
    expect(first.receipt).toMatchObject({ status: 'accepted', idempotencyStatus: 'created', links: { task: `/tasks/${task.id}` } })
    expect(first.receipt.assignments.map(assignment => assignment.role)).toEqual(['implement', 'verify'])
    expect(first.receipt.assignments[0]).toMatchObject({
      taskId: task.id,
      budget: { maxRuntimeMs: 600000, maxTokens: 120000, maxCostUsd: 12, retryLimit: 2 },
      requiredEvidence: [expect.objectContaining({ id: 'validation', required: true })],
      gates: expect.arrayContaining([expect.objectContaining({ id: 'review-pass', type: 'review' })]),
    })
    expect(first.receipt.links['assignments']).toBe(`/team-assignments?receiptId=${first.receipt.id}`)
    expect(listTeamTaskAssignments({ receiptId: first.receipt.id })).toHaveLength(2)
    expect(replay.ok).toBe(true)
    expect(replay.receipt.idempotencyStatus).toBe('replayed')
    expect(replay.receipt.assignments.map(assignment => assignment.id)).toEqual(first.receipt.assignments.map(assignment => assignment.id))
    const unrelatedTask = createWorkTask({ title: 'Newer unrelated assignment task' })
    createTeamTaskAssignments({
      idempotencyKey: 'assign:req:delivery:2',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      taskId: unrelatedTask.id,
      roles: [{ role: 'implement' }],
    }, { blueprintDirs: [blueprintDir], availability, now })
    expect(listTeamTaskAssignments({ taskId: task.id })).toHaveLength(2)
    expect(listTeamTaskAssignments({ taskId: task.id, limit: 1 })).toEqual([
      expect.objectContaining({ taskId: task.id }),
    ])
  })

  it('rejects idempotency replays that point at a different durable target', () => {
    writeBlueprint(promotedBlueprint())
    const firstTask = createWorkTask({ title: 'First idempotent assignment task' })
    const secondTask = createWorkTask({ title: 'Second idempotent assignment task' })
    const created = createTeamTaskAssignments({
      idempotencyKey: 'assign:req:stale-target',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      taskId: firstTask.id,
      roles: [{ role: 'implement' }],
    }, { blueprintDirs: [blueprintDir], availability, now })

    const staleReplay = createTeamTaskAssignments({
      idempotencyKey: 'assign:req:stale-target',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      taskId: secondTask.id,
      roles: [{ role: 'implement' }],
    }, { blueprintDirs: [blueprintDir], availability, now })
    const missingTargetReplay = createTeamTaskAssignments({
      idempotencyKey: 'assign:req:stale-target',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      roles: [{ role: 'implement' }],
    }, { blueprintDirs: [blueprintDir], availability, now })
    const partialReplay = createTeamTaskAssignments({
      idempotencyKey: 'assign:req:stale-target',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      roadmapId: firstTask.roadmapId,
      roles: [{ role: 'implement' }],
    }, { blueprintDirs: [blueprintDir], availability, now })

    expect(created.ok).toBe(true)
    expect(staleReplay.ok).toBe(false)
    expect(staleReplay.receipt).toMatchObject({ status: 'rejected', idempotencyStatus: 'rejected', assignments: [] })
    expect(staleReplay.receipt.rejectionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'assignment_idempotency_target_mismatch', path: 'taskId' }),
    ]))
    expect(missingTargetReplay.ok).toBe(false)
    expect(missingTargetReplay.receipt.rejectionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing_assignment_target', path: 'taskId' }),
    ]))
    expect(partialReplay.ok).toBe(false)
    expect(partialReplay.receipt.rejectionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'assignment_idempotency_target_mismatch', path: 'taskId' }),
    ]))
    expect(listTeamTaskAssignments({ taskId: firstTask.id })).toHaveLength(1)
    expect(listTeamTaskAssignments({ taskId: secondTask.id })).toHaveLength(0)
  })

  it('fails closed with stable actionable errors for invalid budgets, wildcard scope, and missing evidence gate prerequisites', () => {
    writeBlueprint(promotedBlueprint())
    const task = createWorkTask({ title: 'Invalid assignment task' })

    const result = createTeamTaskAssignments({
      idempotencyKey: 'assign:req:invalid',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      taskId: task.id,
      delegationId: 'missing-delegation-receipt',
      roles: [{ role: 'verify' }],
      grants: [{ role: 'verify', tools: ['gateway_task_update'], reason: 'Scoped task edit.' }],
      budget: { maxTokens: 0, maxCostUsd: 0, retryLimit: 30 },
      scope: { tools: ['*'] },
      gates: [{ id: 'evidence', type: 'evidence', requiredBefore: 'external_side_effect' }],
    }, { blueprintDirs: [blueprintDir], availability, now })

    expect(result.ok).toBe(false)
    expect(result.receipt.status).toBe('rejected')
    expect(result.receipt.rejectionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_budget_limit', path: 'budget.maxTokens' }),
      expect.objectContaining({ code: 'invalid_budget_limit', path: 'budget.maxCostUsd' }),
      expect.objectContaining({ code: 'invalid_retry_limit', path: 'budget.retryLimit' }),
      expect.objectContaining({ code: 'evidence_gate_without_requirements' }),
      expect.objectContaining({ code: 'invalid_gate_required_before', path: 'gates.0.requiredBefore' }),
      expect.objectContaining({ code: 'delegation_not_found', path: 'delegationId' }),
    ]))
    expect(listWorkEvents(100).map(event => event.type)).toContain('team_assignment.rejected')
  })

  it('fails closed when assignment scope requests a broader permission policy than the assembled member grant', () => {
    writeBlueprint(promotedBlueprint())
    const task = createWorkTask({ title: 'Permission escalation assignment task' })

    const result = createTeamTaskAssignments({
      idempotencyKey: 'assign:req:permission-escalation',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      taskId: task.id,
      roles: [{ role: 'verify' }],
      grants: [{ role: 'verify', tools: ['gateway_task_update'], reason: 'Scoped task edit.' }],
      scope: { permissions: { edit: 'ask' } },
    }, { blueprintDirs: [blueprintDir], availability, now })

    expect(result.ok).toBe(false)
    expect(result.receipt.status).toBe('rejected')
    expect(result.receipt.rejectionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'scope_permission_escalates', path: 'scope.permissions.edit' }),
    ]))
    expect(result.receipt.assignments).toHaveLength(0)
    expect(listWorkEvents(100).map(event => event.type)).toContain('team_assignment.rejected')
  })

  it('fails closed when assignment scope contains an invalid runtime permission policy', () => {
    writeBlueprint(promotedBlueprint())
    const task = createWorkTask({ title: 'Invalid permission policy assignment task' })

    const result = createTeamTaskAssignments({
      idempotencyKey: 'assign:req:invalid-permission-policy',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      taskId: task.id,
      roles: [{ role: 'implement' }],
      grants: [{ role: 'implement', tools: ['gateway_task_update'], reason: 'Scoped task edit.' }],
      scope: { permissions: { edit: 'sometimes' as any } },
    }, { blueprintDirs: [blueprintDir], availability, now })

    expect(result.ok).toBe(false)
    expect(result.receipt.status).toBe('rejected')
    expect(result.receipt.rejectionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid_scope_permission_policy', path: 'scope.permissions.edit' }),
    ]))
    expect(result.receipt.assignments).toHaveLength(0)
    expect(listWorkEvents(100).map(event => event.type)).toContain('team_assignment.rejected')
  })

  it('fails closed when a run belongs to a different roadmap than the assignment request', () => {
    writeBlueprint(promotedBlueprint())
    const runTask = createWorkTask({ title: 'Run source task' })
    const otherRoadmap = createRoadmap({ title: 'Other assignment roadmap' })
    const run = startWorkTaskRun(runTask.id, 'implement', 'ses_run_assignment', 'implementer')!.run

    const result = createTeamTaskAssignments({
      idempotencyKey: 'assign:req:run-roadmap-mismatch',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      runId: run.id,
      roadmapId: otherRoadmap.id,
      roles: [{ role: 'implement' }],
    }, { blueprintDirs: [blueprintDir], availability, now })

    expect(result.ok).toBe(false)
    expect(result.receipt.rejectionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'roadmap_task_mismatch', path: 'roadmapId' }),
    ]))
  })

  it('keeps older durable assignments addressable beyond the recent event cap', () => {
    writeBlueprint(promotedBlueprint())
    const task = createWorkTask({ title: 'Older durable assignment task' })
    const created = createTeamTaskAssignments({
      idempotencyKey: 'assign:req:old-durable',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      taskId: task.id,
      roles: [{ role: 'implement' }],
    }, { blueprintDirs: [blueprintDir], availability, now })
    const assignment = created.receipt.assignments[0]

    const newerEvents = []
    for (let index = 0; index < 5001; index += 1) {
      const receipt = {
        ...created.receipt,
        id: `team_assignment_receipt_newer_${index}`,
        idempotencyKey: `assign:req:newer:${index}`,
        assignments: created.receipt.assignments.map(row => ({
          ...row,
          id: `team_assignment_newer_${index}_${row.role}`,
          idempotencyKey: `assign:req:newer:${index}`,
        })),
      }
      newerEvents.push({ type: 'team_assignment.created', subjectId: receipt.id, payload: { receipt } })
    }
    appendWorkEvents(newerEvents)

    expect(getTeamTaskAssignment(assignment!.id)?.id).toBe(assignment!.id)
    expect(listTeamTaskAssignments({ receiptId: created.receipt.id })).toEqual([
      expect.objectContaining({ id: assignment!.id }),
    ])
    const completion = recordTeamAssignmentReceipt({
      assignmentId: assignment!.id,
      receiptKind: 'completion',
      status: 'passed',
      summary: 'Older assignment completed after many newer receipts.',
    })
    expect(completion.ok).toBe(true)
  }, 30000)

  it('records durable gate, review, and completion receipts and blocks completion until gates pass', () => {
    writeBlueprint(promotedBlueprint())
    const task = createWorkTask({ title: 'Receipt assignment task' })
    const created = createTeamTaskAssignments({
      idempotencyKey: 'assign:req:receipts',
      blueprintName: 'delivery',
      blueprintVersion: '1.0.0',
      teamName: 'delivery',
      taskId: task.id,
      roles: [{ role: 'verify' }],
      grants: [{ role: 'verify', tools: ['gateway_task_update'], reason: 'Review needs task evidence.' }],
      gates: [{ id: 'review-pass', type: 'review', requiredBefore: 'complete' }],
      evidenceRequirements: [{ id: 'review-log', type: 'artifact', summary: 'Review notes' }],
    }, { blueprintDirs: [blueprintDir], availability, now })
    const assignment = created.receipt.assignments[0]

    const blocked = recordTeamAssignmentReceipt({
      assignmentId: assignment!.id,
      receiptKind: 'completion',
      status: 'passed',
      summary: 'Try to complete early.',
      evidence: ['artifact:early'],
    })
    const review = recordTeamAssignmentReceipt({
      assignmentId: assignment!.id,
      receiptKind: 'review_outcome',
      gateId: 'review-pass',
      status: 'approved',
      summary: 'Review passed.',
      reviewer: 'test-reviewer',
      evidence: ['review-log: artifact:review.md'],
    })
    const completion = recordTeamAssignmentReceipt({
      assignmentId: assignment!.id,
      receiptKind: 'completion',
      status: 'passed',
      summary: 'Assignment completed with evidence.',
      evidence: ['review-log: artifact:review.md'],
    })

    expect(blocked.ok).toBe(false)
    expect(blocked.rejectionReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'completion_gate_unmet' }),
      expect.objectContaining({ code: 'evidence_required', path: 'evidence.review-log' }),
    ]))
    expect(review.ok).toBe(true)
    expect(completion.ok).toBe(true)
    expect(getTeamTaskAssignment(assignment!.id)?.receipts.map(receipt => receipt.receiptKind)).toEqual(['review_outcome', 'completion'])
  })

  function writeBlueprint(blueprint: ReturnType<typeof promotedBlueprint>): void {
    fs.writeFileSync(path.join(blueprintDir, `${blueprint.name}.json`), JSON.stringify(blueprint, null, 2))
  }
})

function promotedBlueprint() {
  return {
    name: 'delivery',
    version: '1.0.0',
    requiredOpenCode: {
      agents: ['gateway-implementer', 'gateway-verifier'],
      skills: ['gateway-stage', 'gateway-review-gate'],
      mcpServers: ['gateway'],
      tools: ['gateway_task_update'],
    },
    profiles: {
      'implementer-bounded': profile('gateway-implementer', ['repo-write'], { edit: 'ask', bash: 'ask' }),
      'verifier-bounded': {
        ...profile('gateway-verifier', ['review'], { edit: 'deny', bash: 'ask' }),
        skills: ['gateway-stage', 'gateway-review-gate'],
      },
    },
    teams: {
      delivery: {
        version: '1.0.0',
        promotionState: 'promoted' as const,
        roles: { implement: 'implementer-bounded', verify: 'verifier-bounded' },
        capabilityRequirements: { implement: ['repo-write'], verify: ['review'] },
        qualitySpecDefaults: { evidenceRequirements: ['validation output'] },
      },
    },
  }
}

function profile(agent: string, capabilities: string[], permission: Record<string, string> = {}): AgentProfile {
  return {
    model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' },
    agent,
    skills: ['gateway-stage'],
    mcpServers: ['gateway'],
    tools: ['gateway_task_update'],
    permission: { read: 'allow', gateway_task_update: 'allow', ...permission },
    heartbeatMs: 0,
    maxTokens: 100000,
    role: 'execution',
    capabilities,
    promotionState: 'promoted',
  }
}
