import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCoworkTraceEvent, type CoworkTraceEventInput, type CrewDefinitionDraft } from '../packages/shared/src/crews.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  clearCrewStoreCache,
  appendCoworkTraceEvent,
  createCrewRun,
  createEvalCase,
  createEvalSuite,
  listCrewRunNodes,
  recordOutcomeEvaluation,
} from '../apps/desktop/src/main/crew-store.ts'
import {
  clearOperationalQueueStoreCache,
  getOperationalQueueItemForRun,
} from '../apps/desktop/src/main/operational-queue-store.ts'
import {
  clearGovernanceAuditStoreCache,
  listGovernanceAuditEvents,
} from '../apps/desktop/src/main/governance-audit-store.ts'
import {
  createCrewFromDraft,
  certifyCrewVersion,
  evaluateCrewRunForRootSessionIdle,
  evaluateCrewRunWithOpenCode,
  executeCrewRunWithOpenCode,
  exportCrewRunTraceNdjson,
  getCrewDetail,
  getCrewRunDetail,
  listCrewCatalog,
  pauseCrew,
  recordCrewOutcomeEvaluation,
  retireCrew,
  startCrewRun,
  startCrewRunWithOpenCode,
  updateCrewFromDraft,
  validateCrewDefinitionDraft,
} from '../apps/desktop/src/main/crew-service.ts'
import type { CrewRuntimeExecutionDriver } from '../apps/desktop/src/main/crew-runtime-execution.ts'
import { projectCrewRuntimeEvent } from '../apps/desktop/src/main/crew-runtime-projector.ts'

function uniqueUserDataDir(name: string) {
  return mkdtempSync(join(tmpdir(), `open-cowork-crew-service-${name}-`))
}

function resetCrewStore(userDataDir: string) {
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearCrewStoreCache()
  clearOperationalQueueStoreCache()
  clearGovernanceAuditStoreCache()
}

function draft(overrides: Partial<CrewDefinitionDraft> = {}): CrewDefinitionDraft {
  return {
    name: 'Research Crew',
    description: 'Lead, specialists, and evaluator.',
    members: [
      { role: 'lead', agentName: 'research-lead', displayName: 'Research Lead' },
      { role: 'specialist', agentName: 'analyst', displayName: 'Analyst' },
      { role: 'specialist', agentName: 'charts', displayName: 'Charts' },
      { role: 'evaluator', agentName: 'evaluator', displayName: 'Evaluator' },
    ],
    workspaceProfileId: 'workspace-default',
    budgetCapUsd: 4,
    ...overrides,
  }
}

function traceInput(runId: string, id = 'certification-trace'): CoworkTraceEventInput {
  return {
    id,
    sequence: 1,
    runId,
    runKind: 'crew',
    source: 'cowork_worker',
    sourceEventId: null,
    correlationId: runId,
    causationId: null,
    sessionId: 'certification-session',
    parentSessionId: null,
    actor: { kind: 'agent', id: 'evaluator' },
    nodeId: null,
    artifactId: null,
    approvalId: null,
    policyDecisionId: null,
    inputHash: 'sha256:input',
    outputHash: 'sha256:output',
    payloadRef: null,
    payloadHash: 'sha256:payload',
    redactionState: 'none',
    tokenUsage: null,
    costUsd: null,
    payload: { type: 'certification.fixture' },
    createdAt: '2026-05-10T00:00:00.000Z',
  }
}

function withCrewStore<T>(name: string, callback: () => T): T {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    resetCrewStore(userDataDir)
    return callback()
  } finally {
    clearCrewStoreCache()
    clearOperationalQueueStoreCache()
    clearGovernanceAuditStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

async function withCrewStoreAsync<T>(name: string, callback: () => Promise<T>): Promise<T> {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    resetCrewStore(userDataDir)
    return await callback()
  } finally {
    clearCrewStoreCache()
    clearOperationalQueueStoreCache()
    clearGovernanceAuditStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

test('crew service validates the minimum lovable crew shape', () => {
  assert.equal(validateCrewDefinitionDraft(draft()).length, 4)

  assert.throws(() => validateCrewDefinitionDraft(draft({
    members: [
      { role: 'lead', agentName: 'lead' },
      { role: 'specialist', agentName: 'analyst' },
      { role: 'evaluator', agentName: 'evaluator' },
    ],
  })), /at least two specialist/)
})

test('crew service creates a versioned crew catalog entry', () => withCrewStore('catalog', () => {
  const detail = createCrewFromDraft(draft())
  const catalog = listCrewCatalog()
  const reloaded = getCrewDetail(detail.definition.id)

  assert.equal(detail.definition.name, 'Research Crew')
  assert.equal(detail.activeVersion?.version, 1)
  assert.equal(detail.activeVersion?.members.length, 4)
  assert.equal(detail.activeVersion?.workflow.join(' > '), 'plan > delegate > join > evaluate > deliver')
  assert.equal(catalog.crews.length, 1)
  assert.equal(catalog.crews[0]?.definition.id, detail.definition.id)
  assert.equal(reloaded?.versions.length, 1)
}))

test('crew incident controls pause and retire crews before new runs start', () => withCrewStore('lifecycle-controls', () => {
  const created = createCrewFromDraft(draft())
  const paused = pauseCrew(created.definition.id)

  assert.equal(paused.definition.status, 'paused')
  assert.throws(() => startCrewRun({
    crewId: created.definition.id,
    title: 'Run while paused',
  }), /Crew is paused/)

  const retired = retireCrew(created.definition.id)
  assert.equal(retired.definition.status, 'retired')
  assert.throws(() => startCrewRun({
    crewId: created.definition.id,
    title: 'Run while retired',
  }), /Crew is retired/)
  assert.throws(() => pauseCrew(created.definition.id), /retired and cannot be reactivated/)

  const auditEvents = listGovernanceAuditEvents({ subjectKind: 'crew', subjectId: `crew:${encodeURIComponent(created.definition.id)}` })
  assert.deepEqual(auditEvents.map((event) => event.action), ['retire_crew', 'pause_crew'])
  assert.equal(auditEvents[0]?.beforeLifecycle, 'paused')
  assert.equal(auditEvents[0]?.afterLifecycle, 'retired')
  assert.equal(auditEvents[1]?.beforeLifecycle, 'draft')
  assert.equal(auditEvents[1]?.afterLifecycle, 'paused')
  assert.equal(auditEvents[0]?.metadata.crewName, 'Research Crew')
}))

test('crew service saves edits as new crew versions without rewriting run history', () => withCrewStore('version-edit', () => {
  const created = createCrewFromDraft(draft())
  const runDetail = startCrewRun({
    crewId: created.definition.id,
    title: 'Analyze the weekly market',
  })

  const updated = updateCrewFromDraft(created.definition.id, draft({
    name: 'Research Crew Plus',
    budgetCapUsd: 7,
    members: [
      { role: 'lead', agentName: 'research-lead', displayName: 'Research Lead' },
      { role: 'specialist', agentName: 'analyst', displayName: 'Analyst' },
      { role: 'specialist', agentName: 'charts', displayName: 'Charts' },
      { role: 'specialist', agentName: 'writer', displayName: 'Writer' },
      { role: 'evaluator', agentName: 'evaluator', displayName: 'Evaluator' },
    ],
  }))
  const preservedRun = getCrewRunDetail(runDetail.run.id)
  const reloaded = getCrewDetail(created.definition.id)

  assert.equal(updated.definition.name, 'Research Crew Plus')
  assert.equal(updated.activeVersion?.version, 2)
  assert.equal(updated.activeVersion?.budgetCapUsd, 7)
  assert.equal(updated.activeVersion?.members.length, 5)
  assert.equal(updated.versions[0]?.id, created.activeVersion?.id)
  assert.equal(updated.versions[0]?.budgetCapUsd, 4)
  assert.equal(preservedRun?.run.crewVersionId, created.activeVersion?.id)
  assert.equal(preservedRun?.version.version, 1)
  assert.equal(preservedRun?.version.members.length, 4)
  assert.equal(reloaded?.activeVersion?.id, updated.activeVersion?.id)
}))

test('crew service rejects unknown outcome rubric ids instead of silently downgrading', () => withCrewStore('unknown-rubric', () => {
  assert.throws(() => createCrewFromDraft(draft({ outcomeRubricId: 'missing-rubric' })), /Outcome rubric missing-rubric does not exist/)
}))

test('crew service blocks eval-suite crew versions until certification evidence passes', () => withCrewStore('certification-gate', () => {
  const suite = createEvalSuite({
    name: 'Sensitive research certification',
    description: 'Certification before a sensitive crew version can run.',
    status: 'active',
  })
  assert.ok(suite)
  const evalCase = createEvalCase({
    suiteId: suite!.id,
    name: 'Evidence-backed result',
    inputRef: 'fixture://research-certification',
    expectedOutcome: 'The evaluator passes a trace-backed research result.',
  })
  assert.ok(evalCase)

  const created = createCrewFromDraft(draft({ evalSuiteId: suite!.id }))
  const activeVersion = created.activeVersion
  assert.ok(activeVersion)
  assert.equal(activeVersion!.evalSuiteId, suite!.id)
  assert.equal(activeVersion!.certificationStatus, 'required')
  assert.throws(() => startCrewRun({
    crewId: created.definition.id,
    title: 'Run before certification',
  }), /requires eval certification/)

  const certificationRun = createCrewRun({
    crewId: created.definition.id,
    crewVersionId: activeVersion!.id,
    title: 'Certification fixture run',
  })
  assert.ok(certificationRun)
  appendCoworkTraceEvent(createCoworkTraceEvent(traceInput(certificationRun!.id)))
  const evaluation = recordOutcomeEvaluation({
    crewRunId: certificationRun!.id,
    evaluatorAgentName: 'evaluator',
    rubricId: activeVersion!.outcomeRubricId!,
    status: 'passed',
    score: 92,
    evidenceTraceEventIds: ['certification-trace'],
    recommendation: 'deliver',
  })
  assert.ok(evaluation)

  const certified = certifyCrewVersion({
    crewVersionId: activeVersion!.id,
    evidenceEvaluationIds: [evaluation!.id],
  })
  assert.equal(certified.activeVersion?.certificationStatus, 'certified')
  assert.ok(certified.activeVersion?.certifiedAt)

  const started = startCrewRun({
    crewId: created.definition.id,
    title: 'Run after certification',
  })
  assert.equal(started.run.crewVersionId, activeVersion!.id)
}))

test('crew service rejects eval-suite crew drafts until the suite is active and has cases', () => withCrewStore('certification-suite-shape', () => {
  const emptySuite = createEvalSuite({
    name: 'Empty certification',
    description: 'Not enough to activate a sensitive crew.',
    status: 'active',
  })
  assert.ok(emptySuite)
  assert.throws(() => createCrewFromDraft(draft({ evalSuiteId: emptySuite!.id })), /has no eval cases/)

  const draftSuite = createEvalSuite({
    name: 'Draft certification',
    description: 'Still under construction.',
    status: 'draft',
  })
  assert.ok(draftSuite)
  createEvalCase({
    suiteId: draftSuite!.id,
    name: 'Draft case',
    inputRef: 'fixture://draft',
    expectedOutcome: 'Draft suites cannot certify active crews.',
  })
  assert.throws(() => createCrewFromDraft(draft({ evalSuiteId: draftSuite!.id })), /is not active/)
}))

test('crew service starts an inspectable fixed branch-join run with traces', () => withCrewStore('run', () => {
  const crew = createCrewFromDraft(draft())
  const runDetail = startCrewRun({
    crewId: crew.definition.id,
    title: 'Analyze the weekly market',
    workItemTitle: 'Weekly market research',
    workItemDescription: 'Research and evaluate the market.',
  })

  assert.equal(runDetail.run.crewVersionId, crew.activeVersion?.id)
  assert.equal(runDetail.run.status, 'planning')
  assert.equal(runDetail.workItem?.title, 'Weekly market research')
  assert.equal(runDetail.workItem?.description, 'Research and evaluate the market.')
  assert.deepEqual(runDetail.nodes.map((node) => node.kind), [
    'plan',
    'delegate',
    'delegate',
    'join',
    'evaluate',
    'deliver',
  ])
  assert.deepEqual(runDetail.nodes.filter((node) => node.kind === 'delegate').map((node) => node.agentName), [
    'analyst',
    'charts',
  ])
  assert.equal(runDetail.traceEvents.length, 7)
  assert.equal(runDetail.traceEvents[0]?.payload?.type, 'crew_run.created')
  assert.deepEqual(runDetail.traceEvents.slice(1).map((event) => event.payload?.type), [
    'crew_run_node.queued',
    'crew_run_node.queued',
    'crew_run_node.queued',
    'crew_run_node.queued',
    'crew_run_node.queued',
    'crew_run_node.queued',
  ])
  assert.deepEqual(listCrewRunNodes(runDetail.run.id).map((node) => node.id), runDetail.nodes.map((node) => node.id))
}))

test('crew service records evaluator pass results as durable evals and trace events', () => withCrewStore('evaluation-pass', () => {
  const crew = createCrewFromDraft(draft())
  const runDetail = startCrewRun({
    crewId: crew.definition.id,
    title: 'Analyze the weekly market',
  })

  const evaluated = recordCrewOutcomeEvaluation({
    runId: runDetail.run.id,
    status: 'passed',
    score: 91,
    evidenceTraceEventIds: [runDetail.traceEvents[0]!.id],
    recommendation: 'deliver',
  })

  const evaluateNode = evaluated.nodes.find((node) => node.kind === 'evaluate')
  const deliverNode = evaluated.nodes.find((node) => node.kind === 'deliver')
  assert.equal(evaluated.run.status, 'completed')
  assert.match(evaluated.run.summary || '', /passed/)
  assert.equal(evaluateNode?.status, 'completed')
  assert.equal(deliverNode?.status, 'completed')
  assert.equal(evaluated.evaluations.length, 1)
  assert.equal(evaluated.evaluations[0]?.score, 91)
  assert.deepEqual(evaluated.evaluations[0]?.evidenceTraceEventIds, [runDetail.traceEvents[0]!.id])
  const evaluationTrace = evaluated.traceEvents.find((event) => event.payload?.type === 'crew_run.evaluation_recorded')
  const deliveryTrace = evaluated.traceEvents.at(-1)
  assert.equal(evaluationTrace?.source, 'cowork_eval')
  assert.equal(deliveryTrace?.source, 'cowork_worker')
  assert.equal(deliveryTrace?.nodeId, deliverNode?.id)
  assert.equal(deliveryTrace?.payload?.type, 'crew_run.delivered')
  assert.equal(deliveryTrace?.payload?.evaluationId, evaluated.evaluations[0]?.id)
}))

test('crew service exports run traces from the durable ledger as NDJSON', () => withCrewStore('trace-export', () => {
  const crew = createCrewFromDraft(draft())
  const runDetail = startCrewRun({
    crewId: crew.definition.id,
    title: 'Analyze the weekly market',
  })

  const exported = exportCrewRunTraceNdjson(runDetail.run.id)
  const rows = exported.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)

  assert.deepEqual(rows.map((row) => row.id), runDetail.traceEvents.map((event) => event.id))
  assert.deepEqual(rows.map((row) => row.sequence), runDetail.traceEvents.map((event) => event.sequence))
  assert.equal((rows[0]?.payload as Record<string, unknown> | undefined)?.type, 'crew_run.created')
  assert.throws(() => exportCrewRunTraceNdjson('missing-run'), /Crew run missing-run does not exist/)
}))

test('crew service blocks delivery when evaluator requests revision or escalation', () => withCrewStore('evaluation-block', () => {
  const crew = createCrewFromDraft(draft())
  const runDetail = startCrewRun({
    crewId: crew.definition.id,
    title: 'Analyze the weekly market',
  })

  const evaluated = recordCrewOutcomeEvaluation({
    runId: runDetail.run.id,
    evaluatorAgentName: 'evaluator',
    status: 'needs_revision',
    score: 64,
    evidenceTraceEventIds: [runDetail.traceEvents[0]!.id],
    recommendation: 'revise',
  })

  const evaluateNode = evaluated.nodes.find((node) => node.kind === 'evaluate')
  const deliverNode = evaluated.nodes.find((node) => node.kind === 'deliver')
  const revisionNode = evaluated.nodes.find((node) => node.kind === 'revision')
  assert.equal(evaluated.run.status, 'blocked')
  assert.match(evaluated.run.summary || '', /requested revise/)
  assert.equal(evaluateNode?.status, 'blocked')
  assert.equal(deliverNode?.status, 'queued')
  assert.equal(revisionNode?.status, 'blocked')
  assert.equal(revisionNode?.agentName, 'research-lead')
  assert.equal(revisionNode?.parentNodeId, evaluateNode?.id)
  assert.equal(evaluated.evaluations[0]?.recommendation, 'revise')
  assert.equal(evaluated.approvals.length, 0)
  assert.equal(evaluated.traceEvents.at(-1)?.payload?.type, 'crew_run.revision_requested')
  assert.equal(evaluated.traceEvents.at(-1)?.nodeId, revisionNode?.id)
  assert.equal(evaluated.traceEvents.at(-1)?.payload?.revisionAttempt, 1)
  assert.equal(evaluated.traceEvents.at(-1)?.payload?.maxRevisionAttempts, 1)
}))

test('crew service creates a human escalation approval when the evaluator requests a human', () => withCrewStore('evaluation-human', () => {
  const crew = createCrewFromDraft(draft())
  const runDetail = startCrewRun({
    crewId: crew.definition.id,
    title: 'Analyze the weekly market',
  })

  const evaluated = recordCrewOutcomeEvaluation({
    runId: runDetail.run.id,
    evaluatorAgentName: 'evaluator',
    status: 'needs_human',
    score: 42,
    evidenceTraceEventIds: [runDetail.traceEvents[0]!.id],
    recommendation: 'escalate',
    summary: 'The output needs an operator decision before delivery.',
  })

  const evaluateNode = evaluated.nodes.find((node) => node.kind === 'evaluate')
  assert.equal(evaluated.run.status, 'blocked')
  assert.equal(evaluated.approvals.length, 1)
  assert.equal(evaluated.approvals[0]?.status, 'requested')
  assert.equal(evaluated.approvals[0]?.nodeId, evaluateNode?.id)
  assert.match(evaluated.approvals[0]?.title || '', /Human review/)
  assert.match(evaluated.approvals[0]?.body || '', /operator decision/)
  assert.equal(evaluated.nodes.some((node) => node.kind === 'revision'), false)
  assert.equal(evaluated.traceEvents.at(-1)?.payload?.type, 'crew_run.human_escalation_requested')
  assert.equal(evaluated.traceEvents.at(-1)?.approvalId, evaluated.approvals[0]?.id)
  assert.equal(evaluated.traceEvents.at(-1)?.payload?.reason, 'evaluator_requested_human')
}))

test('crew service escalates to a human after the bounded revision budget is exhausted', () => withCrewStore('evaluation-revision-budget', () => {
  const crew = createCrewFromDraft(draft())
  const runDetail = startCrewRun({
    crewId: crew.definition.id,
    title: 'Analyze the weekly market',
  })

  const first = recordCrewOutcomeEvaluation({
    runId: runDetail.run.id,
    evaluatorAgentName: 'evaluator',
    status: 'needs_revision',
    score: 64,
    evidenceTraceEventIds: [runDetail.traceEvents[0]!.id],
    recommendation: 'revise',
  })
  const second = recordCrewOutcomeEvaluation({
    runId: runDetail.run.id,
    evaluatorAgentName: 'evaluator',
    status: 'needs_revision',
    score: 68,
    evidenceTraceEventIds: [runDetail.traceEvents[0]!.id],
    recommendation: 'revise',
    summary: 'Revision attempt did not satisfy the rubric.',
  })

  assert.equal(first.nodes.filter((node) => node.kind === 'revision').length, 1)
  assert.equal(second.nodes.filter((node) => node.kind === 'revision').length, 1)
  assert.equal(second.approvals.length, 1)
  assert.equal(second.approvals[0]?.status, 'requested')
  assert.match(second.approvals[0]?.body || '', /exhausted its revision budget/)
  assert.doesNotMatch(second.approvals[0]?.body || '', /requested human review/)
  assert.equal(second.traceEvents.at(-1)?.payload?.type, 'crew_run.human_escalation_requested')
  assert.equal(second.traceEvents.at(-1)?.payload?.reason, 'revision_budget_exhausted')
  assert.equal(second.traceEvents.at(-1)?.payload?.revisionAttempts, 1)
}))

test('crew service dispatches the lead run through an OpenCode execution driver', async () => {
  await withCrewStoreAsync('execute', async () => {
    const crew = createCrewFromDraft(draft({ workspaceProfileId: 'project-workspace' }))
    const prompts: Array<{ sessionId: string; agentName: string; prompt: string }> = []
    const runDetail = await startCrewRunWithOpenCode({
      crewId: crew.definition.id,
      title: 'Analyze the weekly market',
      workItemTitle: 'Weekly market research',
      workItemDescription: 'Research and evaluate the market.',
    }, {
      async createRootSession(input) {
        assert.equal(input.agentName, 'research-lead')
        assert.equal(input.title, 'Analyze the weekly market')
        return { id: 'root-session-1' }
      },
      async prompt(input) {
        prompts.push(input)
      },
      async evaluateOutcome() {
        throw new Error('not used')
      },
    })

    const planNode = runDetail.nodes.find((node) => node.kind === 'plan')
    const queueItem = getOperationalQueueItemForRun('crew', runDetail.run.id)
    assert.equal(runDetail.run.status, 'running')
    assert.equal(runDetail.run.rootSessionId, 'root-session-1')
    assert.equal(queueItem?.status, 'running')
    assert.equal(queueItem?.runKind, 'crew')
    assert.equal(queueItem?.workspaceProfileId, 'project-workspace')
    assert.equal(queueItem?.caps.maxCostUsd, 4)
    assert.deepEqual(queueItem?.queueKeys.includes(`crew:${crew.definition.id}`), true)
    assert.equal(planNode?.status, 'running')
    assert.equal(planNode?.sessionId, 'root-session-1')
    assert.equal(prompts.length, 1)
    assert.equal(prompts[0]?.agentName, 'research-lead')
    assert.match(prompts[0]?.prompt || '', /OpenCode-native task delegation/)
    assert.match(prompts[0]?.prompt || '', /Weekly market research/)
    assert.match(prompts[0]?.prompt || '', /Research and evaluate the market/)
    assert.match(prompts[0]?.prompt || '', /analyst/)
    assert.match(prompts[0]?.prompt || '', /charts/)
    assert.match(prompts[0]?.prompt || '', /evaluator/)
    assert.deepEqual(runDetail.traceEvents.map((event) => event.payload?.type).slice(-2), [
      'crew_run.session_created',
      'crew_run.prompt_submitted',
    ])
    assert.equal(runDetail.traceEvents.some((event) => event.payload?.type === 'crew_run.operational_queue_started'), true)
    assert.equal(runDetail.traceEvents.at(-1)?.inputHash?.startsWith('sha256:'), true)

    const completed = recordCrewOutcomeEvaluation({
      runId: runDetail.run.id,
      status: 'passed',
      score: 91,
      evidenceTraceEventIds: [runDetail.traceEvents[0]!.id],
      recommendation: 'deliver',
    })
    assert.equal(completed.run.status, 'completed')
    assert.equal(getOperationalQueueItemForRun('crew', runDetail.run.id)?.status, 'completed')
  })
})

test('crew service leaves conflicting write-capable runs queued instead of dispatching them concurrently', async () => {
  await withCrewStoreAsync('queue-conflict', async () => {
    const crew = createCrewFromDraft(draft({ workspaceProfileId: 'project-workspace' }))
    let createRootCalls = 0
    let firstEvidenceTraceId = ''
    const driver: CrewRuntimeExecutionDriver = {
      async createRootSession() {
        createRootCalls += 1
        return { id: `root-session-${createRootCalls}` }
      },
      async prompt() {},
      async evaluateOutcome() {
        return {
          sessionId: 'evaluator-session-queue',
          text: '',
          structured: {
            type: 'open_cowork.crew_outcome_evaluation',
            version: 1,
            status: 'passed',
            score: 90,
            recommendation: 'deliver',
            summary: 'Ready to unblock queued work.',
            evidenceTraceEventIds: [firstEvidenceTraceId],
          },
        }
      },
    }

    const first = await startCrewRunWithOpenCode({
      crewId: crew.definition.id,
      title: 'Analyze market A',
    }, driver)
    const second = await startCrewRunWithOpenCode({
      crewId: crew.definition.id,
      title: 'Analyze market B',
    }, driver)
    firstEvidenceTraceId = first.traceEvents[0]!.id

    assert.equal(createRootCalls, 1)
    assert.equal(first.run.status, 'running')
    assert.equal(second.run.status, 'queued')
    assert.equal(getOperationalQueueItemForRun('crew', first.run.id)?.status, 'running')
    assert.equal(getOperationalQueueItemForRun('crew', second.run.id)?.status, 'queued')
    assert.equal(second.traceEvents.at(-1)?.payload?.type, 'crew_run.operational_queue_waiting')

    await evaluateCrewRunWithOpenCode(first.run.id, driver)
    assert.equal(createRootCalls, 2)
    assert.equal(getOperationalQueueItemForRun('crew', first.run.id)?.status, 'completed')
    assert.equal(getOperationalQueueItemForRun('crew', second.run.id)?.status, 'running')
    assert.equal(getCrewRunDetail(second.run.id)?.run.status, 'running')
  })
})

test('crew service records execution dispatch failures in the durable run', async () => {
  await withCrewStoreAsync('execute-failure', async () => {
    const crew = createCrewFromDraft(draft())
    const initial = startCrewRun({
      crewId: crew.definition.id,
      title: 'Analyze the weekly market',
    })
    const failed = await executeCrewRunWithOpenCode(initial.run.id, {
      async createRootSession() {
        return { id: 'root-session-2' }
      },
      async prompt() {
        throw new Error('provider unavailable')
      },
      async evaluateOutcome() {
        throw new Error('not used')
      },
    })

    const planNode = failed.nodes.find((node) => node.kind === 'plan')
    const queueItem = getOperationalQueueItemForRun('crew', initial.run.id)
    assert.equal(failed.run.status, 'failed')
    assert.equal(failed.run.rootSessionId, 'root-session-2')
    assert.equal(queueItem, null)
    assert.match(failed.run.summary || '', /provider unavailable/)
    assert.equal(planNode?.status, 'failed')
    assert.equal(planNode?.sessionId, 'root-session-2')
    assert.equal(failed.traceEvents.at(-1)?.payload?.type, 'crew_run.execution_failed')
  })
})

test('crew service runs a structured evaluator session and records the outcome', async () => {
  await withCrewStoreAsync('evaluate-structured', async () => {
    const crew = createCrewFromDraft(draft())
    const runDetail = startCrewRun({
      crewId: crew.definition.id,
      title: 'Analyze the weekly market',
    })
    const evaluatorPrompts: Array<{ agentName: string; prompt: string; format: unknown }> = []
    const evaluated = await evaluateCrewRunWithOpenCode(runDetail.run.id, {
      async createRootSession() {
        throw new Error('not used')
      },
      async prompt() {
        throw new Error('not used')
      },
      async evaluateOutcome(input) {
        evaluatorPrompts.push(input)
        return {
          sessionId: 'evaluator-session-1',
          text: 'ignored fallback',
          structured: {
            type: 'open_cowork.crew_outcome_evaluation',
            version: 1,
            status: 'passed',
            score: 94,
            recommendation: 'deliver',
            summary: 'Ready to deliver.',
            evidenceTraceEventIds: [runDetail.traceEvents[0]!.id, 'hallucinated-trace-id'],
          },
        }
      },
    })

    const evaluateNode = evaluated.nodes.find((node) => node.kind === 'evaluate')
    const deliverNode = evaluated.nodes.find((node) => node.kind === 'deliver')
    assert.equal(evaluatorPrompts.length, 1)
    assert.equal(evaluatorPrompts[0]?.agentName, 'evaluator')
    assert.match(evaluatorPrompts[0]?.prompt || '', /trace evidence/i)
    assert.match(evaluatorPrompts[0]?.prompt || '', new RegExp(runDetail.traceEvents[0]!.id))
    assert.equal(evaluated.run.status, 'completed')
    assert.equal(evaluateNode?.status, 'completed')
    assert.equal(evaluateNode?.sessionId, 'evaluator-session-1')
    assert.equal(deliverNode?.status, 'completed')
    assert.equal(evaluated.evaluations.length, 1)
    assert.equal(evaluated.evaluations[0]?.score, 94)
    assert.deepEqual(evaluated.evaluations[0]?.evidenceTraceEventIds, [runDetail.traceEvents[0]!.id])
    assert.deepEqual(evaluated.traceEvents.map((event) => event.payload?.type).slice(-3), [
      'crew_run.evaluation_prompt_submitted',
      'crew_run.evaluation_recorded',
      'crew_run.delivered',
    ])
    const recorded = evaluated.traceEvents.find((event) => event.payload?.type === 'crew_run.evaluation_recorded')
    assert.equal(recorded?.sessionId, 'evaluator-session-1')
    assert.equal(recorded?.payload?.discardedEvidenceTraceEventCount, 1)
  })
})

test('crew service sends the most recent trace evidence to the evaluator prompt', async () => {
  await withCrewStoreAsync('evaluate-recent-trace', async () => {
    const crew = createCrewFromDraft(draft())
    const runDetail = startCrewRun({
      crewId: crew.definition.id,
      title: 'Analyze the weekly market',
    })
    for (let index = 0; index < 95; index += 1) {
      appendCoworkTraceEvent(createCoworkTraceEvent({
        ...traceInput(runDetail.run.id, `trace-extra-${index}`),
        sequence: 100 + index,
        payload: { type: 'crew_run.fixture', index },
        createdAt: `2026-05-10T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
      }))
    }

    let evaluatorPrompt = ''
    await evaluateCrewRunWithOpenCode(runDetail.run.id, {
      async createRootSession() {
        throw new Error('not used')
      },
      async prompt() {
        throw new Error('not used')
      },
      async evaluateOutcome(input) {
        evaluatorPrompt = input.prompt
        return {
          sessionId: 'evaluator-session-recent',
          text: '',
          structured: {
            type: 'open_cowork.crew_outcome_evaluation',
            version: 1,
            status: 'passed',
            score: 90,
            recommendation: 'deliver',
            summary: 'Recent evidence is sufficient.',
            evidenceTraceEventIds: ['trace-extra-94'],
          },
        }
      },
    })

    assert.doesNotMatch(evaluatorPrompt, /trace-extra-0/)
    assert.match(evaluatorPrompt, /trace-extra-94/)
  })
})

test('crew service auto-runs evaluation once when the root session reaches ready-for-evaluation', async () => {
  await withCrewStoreAsync('auto-evaluate', async () => {
    const crew = createCrewFromDraft(draft())
    const dispatched = await startCrewRunWithOpenCode({
      crewId: crew.definition.id,
      title: 'Analyze the weekly market',
    }, {
      async createRootSession() {
        return { id: 'root-session-auto' }
      },
      async prompt() {},
      async evaluateOutcome() {
        throw new Error('not used')
      },
    })

    projectCrewRuntimeEvent({
      type: 'done',
      sessionId: 'root-session-auto',
      data: { type: 'done' },
    })

    const ready = getCrewRunDetail(dispatched.run.id)
    assert.equal(ready?.run.status, 'evaluating')
    assert.equal(ready?.traceEvents.at(-1)?.payload?.type, 'crew_run.ready_for_evaluation')

    let evaluateCalls = 0
    const driver: CrewRuntimeExecutionDriver = {
      async createRootSession() {
        throw new Error('not used')
      },
      async prompt() {
        throw new Error('not used')
      },
      async evaluateOutcome() {
        evaluateCalls += 1
        const evidenceId = getCrewRunDetail(dispatched.run.id)?.traceEvents.find((event) => event.source !== 'cowork_eval')?.id
        assert.ok(evidenceId)
        return {
          sessionId: 'evaluator-session-auto',
          text: '',
          structured: {
            type: 'open_cowork.crew_outcome_evaluation',
            version: 1,
            status: 'passed',
            score: 88,
            recommendation: 'deliver',
            summary: 'Ready after automatic evaluation.',
            evidenceTraceEventIds: [evidenceId],
          },
        }
      },
    }

    const evaluated = await evaluateCrewRunForRootSessionIdle('root-session-auto', driver)
    assert.equal(evaluateCalls, 1)
    assert.equal(evaluated?.run.status, 'completed')
    assert.equal(evaluated?.evaluations[0]?.score, 88)
    assert.equal(evaluated?.traceEvents.at(-1)?.payload?.type, 'crew_run.delivered')

    const second = await evaluateCrewRunForRootSessionIdle('root-session-auto', driver)
    assert.equal(evaluateCalls, 1)
    assert.equal(second?.run.status, 'completed')
  })
})

test('crew service deduplicates concurrent manual and automatic evaluator runs', async () => {
  await withCrewStoreAsync('dedupe-evaluate', async () => {
    const crew = createCrewFromDraft(draft())
    const runDetail = startCrewRun({
      crewId: crew.definition.id,
      title: 'Analyze the weekly market',
    })
    let evaluateCalls = 0
    let releaseEvaluation: ((value: Awaited<ReturnType<CrewRuntimeExecutionDriver['evaluateOutcome']>>) => void) | null = null
    let firstEvaluation: Promise<Awaited<ReturnType<typeof evaluateCrewRunWithOpenCode>>> | null = null
    const evaluationStarted = new Promise<void>((resolve) => {
      const driver: CrewRuntimeExecutionDriver = {
        async createRootSession() {
          throw new Error('not used')
        },
        async prompt() {
          throw new Error('not used')
        },
        async evaluateOutcome() {
          evaluateCalls += 1
          resolve()
          return await new Promise((release) => {
            releaseEvaluation = release
          })
        },
      }
      firstEvaluation = evaluateCrewRunWithOpenCode(runDetail.run.id, driver)
    })
    await evaluationStarted

    const second = await evaluateCrewRunWithOpenCode(runDetail.run.id, {
      async createRootSession() {
        throw new Error('not used')
      },
      async prompt() {
        throw new Error('not used')
      },
      async evaluateOutcome() {
        evaluateCalls += 1
        throw new Error('duplicate evaluator should not run')
      },
    })
    assert.equal(evaluateCalls, 1)
    assert.equal(second.evaluations.length, 0)

    releaseEvaluation?.({
      sessionId: 'evaluator-session-dedupe',
      text: '',
      structured: {
        type: 'open_cowork.crew_outcome_evaluation',
        version: 1,
        status: 'passed',
        score: 91,
        recommendation: 'deliver',
        summary: 'Ready after one evaluator run.',
        evidenceTraceEventIds: [runDetail.traceEvents[0]!.id],
      },
    })
    const first = await firstEvaluation
    assert.equal(first?.evaluations.length, 1)
    assert.equal(first?.evaluations[0]?.score, 91)
  })
})

test('crew service blocks the run when evaluator output is invalid', async () => {
  await withCrewStoreAsync('evaluate-invalid', async () => {
    const crew = createCrewFromDraft(draft())
    const runDetail = startCrewRun({
      crewId: crew.definition.id,
      title: 'Analyze the weekly market',
    })
    const evaluated = await evaluateCrewRunWithOpenCode(runDetail.run.id, {
      async createRootSession() {
        throw new Error('not used')
      },
      async prompt() {
        throw new Error('not used')
      },
      async evaluateOutcome() {
        return {
          sessionId: 'evaluator-session-invalid',
          structured: { bad: true },
          text: 'not json',
        }
      },
    })

    const evaluateNode = evaluated.nodes.find((node) => node.kind === 'evaluate')
    assert.equal(evaluated.run.status, 'blocked')
    assert.match(evaluated.run.summary || '', /valid crew outcome evaluation/)
    assert.equal(evaluateNode?.status, 'failed')
    assert.equal(evaluateNode?.sessionId, 'evaluator-session-invalid')
    assert.equal(evaluated.evaluations.length, 0)
    assert.equal(evaluated.traceEvents.at(-1)?.payload?.type, 'crew_run.evaluation_failed')
  })
})
