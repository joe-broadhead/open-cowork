import { describe, expect, it } from 'vitest'
import {
  buildOperatorDecisionJourney,
  channelActionDeniedDecision,
  completionProposalDecision,
  gatewayHumanGateDecision,
  openCodePermissionDecision,
  openCodeQuestionDecision,
} from '../operator-decisions.js'
import type { HumanGateRecord, RoadmapCompletionProposalRecord } from '../work-store.js'

describe('operator decision contract', () => {
  it('maps Gateway human gates to Gateway-owned decision states', () => {
    const gate = humanGate({ id: 'gate_1', status: 'pending', expiresAt: '2026-06-24T12:00:00.000Z' })

    const decision = gatewayHumanGateDecision(gate, Date.parse('2026-06-24T11:00:00.000Z'))

    expect(decision).toMatchObject({
      id: 'gate_1',
      source: 'gateway_human_gate',
      owner: 'gateway',
      state: 'requires_gateway',
      evidenceRef: 'human_gate:gate_1',
    })
    expect(decision.safeNextAction).toContain('/gate approve gate_1 once')
    expect(decision.authority).toContain('does not answer OpenCode-native')
  })

  it('maps expired Gateway and completion decisions without enabling stale actions', () => {
    const gateDecision = gatewayHumanGateDecision(humanGate({ id: 'gate_expired', expiresAt: '2026-06-24T10:00:00.000Z' }), Date.parse('2026-06-24T11:00:00.000Z'))
    const proposalDecision = completionProposalDecision(completionProposal({ id: 'proposal_expired', expiresAt: '2026-06-24T10:00:00.000Z' }), Date.parse('2026-06-24T11:00:00.000Z'))

    expect(gateDecision.state).toBe('expired')
    expect(gateDecision.actions.every(action => action.enabled === false)).toBe(true)
    expect(proposalDecision.state).toBe('expired')
    expect(proposalDecision.actions.every(action => action.enabled === false)).toBe(true)
    expect(proposalDecision.safeNextAction).toContain('expired')
  })

  it('maps OpenCode questions and permissions to OpenCode-owned decisions', () => {
    const question = openCodeQuestionDecision({
      id: 'q1',
      sessionID: 'ses_question',
      questions: [{ header: 'Choice', question: 'Pick one?', options: [{ label: 'A' }] }],
    })
    const permission = openCodePermissionDecision({
      id: 'p1',
      sessionID: 'ses_permission',
      permission: 'bash',
      patterns: ['npm test'],
      metadata: {},
      always: [],
    })

    expect(question).toMatchObject({ owner: 'opencode', state: 'requires_open_code', source: 'opencode_question' })
    expect(question.safeNextAction).toContain('Gateway only forwards')
    expect(question.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'A', command: '/answer q1 A', owner: 'opencode' }),
      expect.objectContaining({ label: 'Reject', command: '/reject-question q1', owner: 'opencode' }),
    ]))
    expect(permission).toMatchObject({ owner: 'opencode', state: 'requires_open_code', source: 'opencode_permission' })
    expect(permission.safeNextAction).toContain('Gateway does not bypass OpenCode')
    expect(permission.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Approve once', command: '/approve p1 once', owner: 'opencode' }),
      expect.objectContaining({ label: 'Deny', command: '/deny p1', owner: 'opencode' }),
    ]))
  })

  it('maps channel denials to reason-coded fail-closed states', () => {
    expect(channelActionDeniedDecision({ operation: 'gate.approve', targetId: 'gate_1', reason: 'old action', reasonCode: 'stale' })).toMatchObject({
      owner: 'channel',
      state: 'stale',
      reasonCode: 'stale',
    })
    expect(channelActionDeniedDecision({ operation: 'gate.approve', targetId: 'gate_1', reason: 'already processed', reasonCode: 'replayed' }).state).toBe('stale')
    expect(channelActionDeniedDecision({ operation: 'gate.approve', targetId: 'gate_1', reason: 'wrong chat', reasonCode: 'wrong_channel' }).state).toBe('denied')
    expect(channelActionDeniedDecision({ operation: 'permission.reply', targetId: 'p1', reason: 'gone', reasonCode: 'not_pending' }).state).toBe('blocked')
  })

  it('builds a surface journey with stale Web recovery while preserving OpenCode ownership', () => {
    const permission = openCodePermissionDecision({
      id: 'p-stale',
      sessionID: 'ses_stale_web',
      permission: 'bash',
      patterns: ['npm test'],
      metadata: {},
      always: [],
    })

    const journey = buildOperatorDecisionJourney(permission, {
      trustedChannelCount: 1,
      sessionRecovery: {
        status: 'unavailable',
        reason: 'session not found in OpenCode API',
        recoveryHint: 'Use /open ses_stale_web; then use TUI or Mission Control evidence.',
      },
    })

    expect(journey).toMatchObject({
      decisionId: 'p-stale',
      owner: 'opencode',
      state: 'requires_open_code',
      releaseClaim: 'local_operator_decision_surface_sync_only',
    })
    expect(journey.surfaceStates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        surface: 'opencode_web_tui',
        status: 'recovery_required',
        decisionState: 'requires_open_code',
        owner: 'opencode',
        safeNextAction: 'Use /open ses_stale_web; then use TUI or Mission Control evidence.',
      }),
      expect.objectContaining({
        surface: 'trusted_channel',
        status: 'aligned',
        decisionState: 'requires_open_code',
        owner: 'opencode',
        safeNextAction: expect.stringContaining('/approve p-stale once'),
      }),
      expect.objectContaining({
        surface: 'cli_mcp',
        status: 'aligned',
        decisionState: 'requires_open_code',
        owner: 'opencode',
      }),
      expect.objectContaining({
        surface: 'mission_control',
        status: 'aligned',
        decisionState: 'requires_open_code',
        owner: 'opencode',
      }),
    ]))
    expect(journey.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'opencode_reply', status: 'required' }),
      expect.objectContaining({ kind: 'gateway_notification', status: 'recorded_by_owner' }),
    ]))
    expect(journey.authority).toContain('OpenCode owns permission enforcement')
  })
})

function humanGate(overrides: Partial<HumanGateRecord>): HumanGateRecord {
  return {
    id: 'gate',
    type: 'task_start',
    status: 'pending',
    reason: 'Needs approval',
    requestedBy: 'test',
    requestedAt: '2026-06-24T09:00:00.000Z',
    updatedAt: '2026-06-24T09:00:00.000Z',
    timeoutAction: 'block',
    details: {},
    ...overrides,
  }
}

function completionProposal(overrides: Partial<RoadmapCompletionProposalRecord>): RoadmapCompletionProposalRecord {
  return {
    id: 'proposal',
    roadmapId: 'roadmap_1',
    evidence: ['tests'],
    unresolvedRisks: [],
    recommendation: 'ready',
    status: 'pending',
    createdAt: '2026-06-24T09:00:00.000Z',
    updatedAt: '2026-06-24T09:00:00.000Z',
    ...overrides,
  }
}
