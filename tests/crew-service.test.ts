import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CrewDefinitionDraft } from '../packages/shared/src/crews.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  clearCrewStoreCache,
  listCrewRunNodes,
} from '../apps/desktop/src/main/crew-store.ts'
import {
  createCrewFromDraft,
  evaluateCrewRunForRootSessionIdle,
  evaluateCrewRunWithOpenCode,
  executeCrewRunWithOpenCode,
  exportCrewRunTraceNdjson,
  getCrewDetail,
  getCrewRunDetail,
  listCrewCatalog,
  recordCrewOutcomeEvaluation,
  startCrewRun,
  startCrewRunWithOpenCode,
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

function withCrewStore<T>(name: string, callback: () => T): T {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    resetCrewStore(userDataDir)
    return callback()
  } finally {
    clearCrewStoreCache()
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

test('crew service rejects unknown outcome rubric ids instead of silently downgrading', () => withCrewStore('unknown-rubric', () => {
  assert.throws(() => createCrewFromDraft(draft({ outcomeRubricId: 'missing-rubric' })), /Outcome rubric missing-rubric does not exist/)
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
  assert.equal(evaluated.traceEvents.at(-1)?.source, 'cowork_eval')
  assert.equal(evaluated.traceEvents.at(-1)?.payload?.type, 'crew_run.evaluation_recorded')
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
  assert.equal(second.traceEvents.at(-1)?.payload?.type, 'crew_run.human_escalation_requested')
  assert.equal(second.traceEvents.at(-1)?.payload?.reason, 'revision_budget_exhausted')
  assert.equal(second.traceEvents.at(-1)?.payload?.revisionAttempts, 1)
}))

test('crew service dispatches the lead run through an OpenCode execution driver', async () => {
  await withCrewStoreAsync('execute', async () => {
    const crew = createCrewFromDraft(draft())
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
    assert.equal(runDetail.run.status, 'running')
    assert.equal(runDetail.run.rootSessionId, 'root-session-1')
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
    assert.equal(runDetail.traceEvents.at(-1)?.inputHash?.startsWith('sha256:'), true)
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
    assert.equal(failed.run.status, 'failed')
    assert.equal(failed.run.rootSessionId, 'root-session-2')
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
    assert.deepEqual(evaluated.traceEvents.map((event) => event.payload?.type).slice(-2), [
      'crew_run.evaluation_prompt_submitted',
      'crew_run.evaluation_recorded',
    ])
    assert.equal(evaluated.traceEvents.at(-1)?.sessionId, 'evaluator-session-1')
    assert.equal(evaluated.traceEvents.at(-1)?.payload?.discardedEvidenceTraceEventCount, 1)
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
    assert.equal(evaluated?.traceEvents.at(-1)?.payload?.type, 'crew_run.evaluation_recorded')

    const second = await evaluateCrewRunForRootSessionIdle('root-session-auto', driver)
    assert.equal(evaluateCalls, 1)
    assert.equal(second?.run.status, 'completed')
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
