import { describe, expect, it } from 'vitest'
import { delegationRequestSchema, validateDelegationRequest, type DelegationRequest } from '../delegation-contract.js'

describe('delegation contract', () => {
  it('parses a durable issue delegation with deterministic defaults', () => {
    const request = delegationRequestSchema.parse({
      idempotencyKey: 'parent-session-1:tax-rounding',
      target: { type: 'issue', projectAlias: 'checkout', title: 'Fix tax rounding' },
      objective: 'Fix checkout tax rounding and prove coupon behavior is unchanged.',
      context: {
        summary: 'A parent agent found a durable checkout bug.',
        references: ['JOE-51'],
        constraints: ['No unrelated refactors'],
        nonGoals: ['Do not change tax rates'],
      },
      acceptanceCriteria: ['Totals round consistently'],
      definitionOfDone: ['Tests and evidence are recorded'],
      evidence: [{ summary: 'test output' }],
      parentSession: { sessionId: 'ses_parent' },
    })

    expect(request.version).toBe(1)
    expect(request.completionPolicy).toBe('assistant_proposes_user_approves')
    expect(request.notificationTarget).toMatchObject({ mode: 'parent_session' })
    expect(validateDelegationRequest(request)).toMatchObject({ ok: true })
  })

  it('rejects issue delegation without project context', () => {
    const request: DelegationRequest = delegationRequestSchema.parse({
      idempotencyKey: 'missing-project',
      target: { type: 'project', title: 'Temporary shell' },
      objective: 'Create a project shell.',
      context: { summary: 'setup', references: [], constraints: [], nonGoals: [] },
      acceptanceCriteria: ['project exists'],
      definitionOfDone: ['project is visible'],
    })

    const invalid = { ...request, target: { type: 'issue' as const, title: 'orphan task' } }
    expect(validateDelegationRequest(invalid)).toMatchObject({
      ok: false,
      failureMode: 'ambiguous_project_context',
    })
  })

  it('rejects underspecified blueprint delegation', () => {
    const request = delegationRequestSchema.parse({
      idempotencyKey: 'blueprint-empty',
      target: { type: 'agent_team_blueprint', name: 'payments' },
      objective: 'Propose a payments team.',
      context: { summary: 'team routing', references: [], constraints: [], nonGoals: [] },
      acceptanceCriteria: ['proposal is auditable'],
      definitionOfDone: ['proposal can be reviewed'],
    })

    expect(validateDelegationRequest(request)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/roles, capability requirements, or quality defaults/),
    })
  })

  it('classifies budget threshold violations as gate requirements', () => {
    const request = delegationRequestSchema.parse({
      idempotencyKey: 'budget-ok',
      target: { type: 'project', title: 'Launch audit' },
      objective: 'Audit launch readiness.',
      context: { summary: 'launch project', references: [], constraints: [], nonGoals: [] },
      acceptanceCriteria: ['risks are listed'],
      definitionOfDone: ['owner can decide launch'],
      budget: { maxCostUsd: 10, requiresApprovalAbove: 20 },
    })

    expect(validateDelegationRequest({ ...request, budget: { maxCostUsd: 25, requiresApprovalAbove: 20 } })).toMatchObject({
      ok: false,
      failureMode: 'budget_or_gate_required',
    })
  })
})
