import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COWORK_CREW_SCHEMA_VERSION,
  COWORK_EVAL_SCHEMA_VERSION,
  createCoworkTraceEvent,
  type CrewMember,
  type CoworkTraceEventInput,
  type OutcomeRubricCriterion,
} from '../packages/shared/src/crews.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  CREW_STORE_SCHEMA_VERSION,
  appendCoworkTraceEvent,
  clearCrewStoreCache,
  createCoworkWorkItem,
  createCrewApproval,
  createCrewArtifact,
  createCrewDefinition,
  createEvalCase,
  createEvalSuite,
  createOutcomeRubric,
  createCrewRun,
  createCrewRunNode,
  createCrewVersion,
  deleteCrewDefinitionIfUnused,
  exportCoworkTraceEventsForRun,
  getCrewDb,
  listCoworkWorkItems,
  listCrewApprovalsForRun,
  listCrewArtifactsForRun,
  listCrewDefinitions,
  listCrewRunNodes,
  listCrewRuns,
  listCrewVersions,
  listCoworkTraceEventsForRun,
  listEvalCasesForSuite,
  listEvalSuites,
  listOutcomeEvaluationsForRun,
  listOutcomeRubrics,
  listPolicyDecisionsForRun,
  recordOutcomeEvaluation,
  recordPolicyDecision,
  resolveCrewApproval,
  updateCoworkWorkItemStatus,
  updateCrewRunNodeStatus,
  updateCrewRunStatus,
} from '../apps/desktop/src/main/crew-store.ts'

function uniqueUserDataDir(name: string) {
  return mkdtempSync(join(tmpdir(), `open-cowork-crew-${name}-`))
}

function resetCrewStore(userDataDir: string) {
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearCrewStoreCache()
}

function traceInput(overrides: Partial<CoworkTraceEventInput> = {}): CoworkTraceEventInput {
  return {
    id: 'trace-1',
    sequence: 1,
    runId: 'run-1',
    runKind: 'crew',
    source: 'cowork_worker',
    sourceEventId: null,
    correlationId: 'corr-1',
    causationId: null,
    sessionId: 'session-1',
    parentSessionId: null,
    actor: { kind: 'agent', id: 'lead' },
    nodeId: 'node-1',
    artifactId: null,
    approvalId: null,
    policyDecisionId: null,
    inputHash: 'sha256:input',
    outputHash: 'sha256:output',
    payloadRef: null,
    payloadHash: 'sha256:payload',
    redactionState: 'none',
    tokenUsage: {
      input: 10,
      output: 20,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    costUsd: 0.02,
    payload: { message: 'visible' },
    createdAt: '2026-05-10T00:00:00.000Z',
    ...overrides,
  }
}

function member(id: string, role: CrewMember['role'], agentName: string): CrewMember {
  return {
    schemaVersion: COWORK_CREW_SCHEMA_VERSION,
    id,
    role,
    agentName,
    displayName: agentName,
    description: `${agentName} member`,
    required: true,
  }
}

function criterion(id: string, label: string): OutcomeRubricCriterion {
  return {
    schemaVersion: COWORK_EVAL_SCHEMA_VERSION,
    id,
    label,
    description: `${label} criterion`,
    weight: 1,
    passingScore: 80,
  }
}

test('crew store versions crew definitions without rewriting previous versions', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('versions')

  try {
    resetCrewStore(userDataDir)

    const crew = createCrewDefinition({
      name: 'Research Crew',
      description: 'Lead, specialists, and evaluator.',
    })
    assert.ok(crew)
    const v1 = createCrewVersion({
      crewId: crew!.id,
      members: [
        member('lead', 'lead', 'lead-agent'),
        member('analyst', 'specialist', 'analyst-agent'),
        member('evaluator', 'evaluator', 'eval-agent'),
      ],
      workspaceProfileId: 'workspace-default',
      outcomeRubricId: 'rubric-research',
      budgetCapUsd: 5,
      createdBy: 'user-1',
    })
    const v2 = createCrewVersion({
      crewId: crew!.id,
      members: [
        member('lead', 'lead', 'lead-agent'),
        member('analyst', 'specialist', 'analyst-agent'),
        member('charts', 'specialist', 'charts-agent'),
        member('evaluator', 'evaluator', 'eval-agent'),
      ],
      workspaceProfileId: 'workspace-default',
      outcomeRubricId: 'rubric-research',
      budgetCapUsd: 8,
      createdBy: 'user-1',
    })

    assert.ok(v1)
    assert.ok(v2)
    const refreshed = listCrewDefinitions()[0]
    const versions = listCrewVersions(crew!.id)

    assert.equal(refreshed?.activeVersionId, v2!.id)
    assert.equal(versions.length, 2)
    assert.equal(versions[0]?.version, 1)
    assert.equal(versions[0]?.members.length, 3)
    assert.equal(versions[0]?.budgetCapUsd, 5)
    assert.equal(versions[1]?.version, 2)
    assert.equal(versions[1]?.members.length, 4)
    assert.equal(versions[1]?.budgetCapUsd, 8)
  } finally {
    clearCrewStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('crew store deletes unused crew definitions and versions', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('delete-unused')

  try {
    resetCrewStore(userDataDir)

    const crew = createCrewDefinition({
      name: 'Draft Crew',
      description: 'A crew that has not run yet.',
    })
    assert.ok(crew)
    const version = createCrewVersion({
      crewId: crew!.id,
      members: [
        member('lead', 'lead', 'lead-agent'),
        member('analyst', 'specialist', 'analyst-agent'),
        member('charts', 'specialist', 'charts-agent'),
        member('evaluator', 'evaluator', 'eval-agent'),
      ],
    })
    assert.ok(version)

    assert.equal(deleteCrewDefinitionIfUnused(crew!.id), true)
    assert.equal(listCrewDefinitions().length, 0)
    assert.equal(listCrewVersions(crew!.id).length, 0)
  } finally {
    clearCrewStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('crew store refuses to delete crews with run history', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('delete-with-runs')

  try {
    resetCrewStore(userDataDir)

    const crew = createCrewDefinition({
      name: 'Historical Crew',
      description: 'A crew with traceable run history.',
    })
    assert.ok(crew)
    const version = createCrewVersion({
      crewId: crew!.id,
      members: [
        member('lead', 'lead', 'lead-agent'),
        member('analyst', 'specialist', 'analyst-agent'),
        member('charts', 'specialist', 'charts-agent'),
        member('evaluator', 'evaluator', 'eval-agent'),
      ],
    })
    assert.ok(version)
    const run = createCrewRun({
      crewId: crew!.id,
      crewVersionId: version!.id,
      title: 'Analyze the market',
    })
    assert.ok(run)

    assert.throws(
      () => deleteCrewDefinitionIfUnused(crew!.id),
      /run history/,
    )
    assert.equal(listCrewDefinitions().length, 1)
    assert.equal(listCrewRuns(crew!.id).length, 1)
  } finally {
    clearCrewStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('crew runs link to exact crew versions and preserve node timeline state', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('runs')

  try {
    resetCrewStore(userDataDir)

    const crew = createCrewDefinition({
      name: 'Research Crew',
      description: 'Lead, specialists, and evaluator.',
    })
    assert.ok(crew)
    const v1 = createCrewVersion({
      crewId: crew!.id,
      members: [
        member('lead', 'lead', 'lead-agent'),
        member('analyst', 'specialist', 'analyst-agent'),
        member('evaluator', 'evaluator', 'eval-agent'),
      ],
    })
    assert.ok(v1)
    const run = createCrewRun({
      crewId: crew!.id,
      crewVersionId: v1!.id,
      title: 'Analyze the market',
      workItemId: 'work-item-1',
    })
    assert.ok(run)
    assert.equal(run!.crewVersionId, v1!.id)
    assert.equal(run!.status, 'queued')

    const plan = createCrewRunNode({
      crewRunId: run!.id,
      kind: 'plan',
      title: 'Plan work',
      agentName: 'lead-agent',
      status: 'running',
      sessionId: 'root-session',
    })
    const delegate = createCrewRunNode({
      crewRunId: run!.id,
      kind: 'delegate',
      title: 'Analyze numbers',
      agentName: 'analyst-agent',
      parentNodeId: plan!.id,
    })
    assert.ok(plan)
    assert.ok(delegate)

    const running = updateCrewRunStatus(run!.id, 'running', { rootSessionId: 'root-session' })
    assert.equal(running?.startedAt !== null, true)
    assert.equal(running?.rootSessionId, 'root-session')

    const completedPlan = updateCrewRunNodeStatus(plan!.id, 'completed')
    const runningDelegate = updateCrewRunNodeStatus(delegate!.id, 'running', { sessionId: 'child-session' })
    const completed = updateCrewRunStatus(run!.id, 'completed', { summary: 'Market analysis complete.' })
    const runs = listCrewRuns(crew!.id)
    const nodes = listCrewRunNodes(run!.id)

    assert.equal(completedPlan?.status, 'completed')
    assert.equal(completedPlan?.finishedAt !== null, true)
    assert.equal(runningDelegate?.status, 'running')
    assert.equal(runningDelegate?.sessionId, 'child-session')
    assert.equal(completed?.status, 'completed')
    assert.equal(completed?.summary, 'Market analysis complete.')
    assert.equal(completed?.finishedAt !== null, true)
    assert.deepEqual(runs.map((entry) => entry.id), [run!.id])
    assert.deepEqual(nodes.map((node) => node.id), [plan!.id, delegate!.id])
  } finally {
    clearCrewStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('crew runs reject crew versions from another crew', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('version-ownership')

  try {
    resetCrewStore(userDataDir)

    const crewA = createCrewDefinition({ name: 'Crew A', description: 'A' })
    const crewB = createCrewDefinition({ name: 'Crew B', description: 'B' })
    assert.ok(crewA)
    assert.ok(crewB)
    const versionA = createCrewVersion({
      crewId: crewA!.id,
      members: [member('lead', 'lead', 'lead-agent')],
    })
    assert.ok(versionA)

    assert.throws(() => createCrewRun({
      crewId: crewB!.id,
      crewVersionId: versionA!.id,
      title: 'Wrong crew',
    }), /does not belong/)
  } finally {
    clearCrewStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('crew store persists work items, artifacts, approvals, and policy decisions', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('operations')

  try {
    resetCrewStore(userDataDir)

    const workItem = createCoworkWorkItem({
      title: 'Research market',
      description: 'Find current market evidence.',
      source: 'manual',
    })
    assert.ok(workItem)
    const completedWorkItem = updateCoworkWorkItemStatus(workItem!.id, 'running')
    assert.equal(completedWorkItem?.status, 'running')
    assert.deepEqual(listCoworkWorkItems().map((item) => item.id), [workItem!.id])

    const crew = createCrewDefinition({ name: 'Research Crew', description: 'Research team.' })
    assert.ok(crew)
    const version = createCrewVersion({
      crewId: crew!.id,
      members: [member('lead', 'lead', 'lead-agent')],
    })
    assert.ok(version)
    const run = createCrewRun({
      crewId: crew!.id,
      crewVersionId: version!.id,
      workItemId: workItem!.id,
      title: 'Market research run',
    })
    assert.ok(run)
    const node = createCrewRunNode({
      crewRunId: run!.id,
      kind: 'delegate',
      title: 'Collect evidence',
      agentName: 'lead-agent',
    })
    assert.ok(node)

    const artifact = createCrewArtifact({
      crewRunId: run!.id,
      nodeId: node!.id,
      title: 'Evidence brief',
      mime: 'text/markdown',
      uri: 'artifact://evidence-brief',
      hash: 'sha256:brief',
    })
    const approval = createCrewApproval({
      crewRunId: run!.id,
      nodeId: node!.id,
      title: 'Approve external summary',
      body: 'Review the summary before delivery.',
    })
    const resolved = resolveCrewApproval(approval!.id, 'approved', 'user-1')
    const decision = recordPolicyDecision({
      runId: run!.id,
      runKind: 'crew',
      nodeId: node!.id,
      status: 'approval_required',
      reason: 'External delivery requires explicit approval.',
      capabilityId: 'delivery:external',
    })

    assert.equal(artifact?.schemaVersion, COWORK_CREW_SCHEMA_VERSION)
    assert.deepEqual(listCrewArtifactsForRun(run!.id).map((entry) => entry.id), [artifact!.id])
    assert.equal(resolved?.status, 'approved')
    assert.equal(resolved?.resolvedBy, 'user-1')
    assert.deepEqual(listCrewApprovalsForRun(run!.id).map((entry) => entry.id), [approval!.id])
    assert.equal(decision?.status, 'approval_required')
    assert.deepEqual(listPolicyDecisionsForRun('crew', run!.id).map((entry) => entry.id), [decision!.id])
  } finally {
    clearCrewStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('crew store persists eval suites, cases, rubrics, and outcome evaluations', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('evals')

  try {
    resetCrewStore(userDataDir)

    const crew = createCrewDefinition({ name: 'Research Crew', description: 'Research team.' })
    assert.ok(crew)
    const version = createCrewVersion({
      crewId: crew!.id,
      members: [
        member('lead', 'lead', 'lead-agent'),
        member('evaluator', 'evaluator', 'eval-agent'),
      ],
    })
    assert.ok(version)
    const run = createCrewRun({
      crewId: crew!.id,
      crewVersionId: version!.id,
      title: 'Evaluate output',
    })
    assert.ok(run)
    const rubric = createOutcomeRubric({
      name: 'Evidence quality',
      description: 'Major claims need trace evidence.',
      criteria: [criterion('evidence', 'Evidence')],
      passingScore: 80,
    })
    const suite = createEvalSuite({
      name: 'Research certification',
      description: 'Checks research crew output before activation.',
      status: 'active',
    })
    assert.ok(rubric)
    assert.ok(suite)
    const evalCase = createEvalCase({
      suiteId: suite!.id,
      name: 'Cited evidence',
      inputRef: 'artifact://fixture',
      expectedOutcome: 'Every important claim cites evidence.',
    })
    appendCoworkTraceEvent(createCoworkTraceEvent(traceInput({
      id: 'trace-evidence',
      runId: run!.id,
      nodeId: null,
      payloadRef: 'artifact://fixture',
    })))
    const evaluation = recordOutcomeEvaluation({
      crewRunId: run!.id,
      evaluatorAgentName: 'eval-agent',
      rubricId: rubric!.id,
      status: 'passed',
      score: 91,
      evidenceTraceEventIds: ['trace-evidence'],
      recommendation: 'deliver',
    })

    assert.equal(rubric?.schemaVersion, COWORK_EVAL_SCHEMA_VERSION)
    assert.deepEqual(listOutcomeRubrics().map((entry) => entry.id), [rubric!.id])
    assert.deepEqual(listEvalSuites().map((entry) => entry.id), [suite!.id])
    assert.deepEqual(listEvalCasesForSuite(suite!.id).map((entry) => entry.id), [evalCase!.id])
    assert.equal(evaluation?.status, 'passed')
    assert.deepEqual(evaluation?.evidenceTraceEventIds, ['trace-evidence'])
    assert.deepEqual(listOutcomeEvaluationsForRun(run!.id).map((entry) => entry.id), [evaluation!.id])
  } finally {
    clearCrewStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('crew store rejects outcome evaluations without same-run trace evidence', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('eval-evidence-ownership')

  try {
    resetCrewStore(userDataDir)

    const crew = createCrewDefinition({ name: 'Research Crew', description: 'Research team.' })
    assert.ok(crew)
    const version = createCrewVersion({
      crewId: crew!.id,
      members: [
        member('lead', 'lead', 'lead-agent'),
        member('evaluator', 'evaluator', 'eval-agent'),
      ],
    })
    assert.ok(version)
    const runA = createCrewRun({ crewId: crew!.id, crewVersionId: version!.id, title: 'Run A' })
    const runB = createCrewRun({ crewId: crew!.id, crewVersionId: version!.id, title: 'Run B' })
    assert.ok(runA)
    assert.ok(runB)
    const rubric = createOutcomeRubric({
      name: 'Evidence quality',
      description: 'Major claims need trace evidence.',
      criteria: [criterion('evidence', 'Evidence')],
      passingScore: 80,
    })
    assert.ok(rubric)
    appendCoworkTraceEvent(createCoworkTraceEvent(traceInput({
      id: 'trace-run-b',
      runId: runB!.id,
      nodeId: null,
    })))

    assert.throws(() => recordOutcomeEvaluation({
      crewRunId: runA!.id,
      evaluatorAgentName: 'eval-agent',
      rubricId: rubric!.id,
      status: 'passed',
      score: 95,
      evidenceTraceEventIds: ['trace-run-b'],
      recommendation: 'deliver',
    }), /does not belong/)
    assert.throws(() => recordOutcomeEvaluation({
      crewRunId: runA!.id,
      evaluatorAgentName: 'eval-agent',
      rubricId: rubric!.id,
      status: 'passed',
      score: 101,
      evidenceTraceEventIds: ['trace-run-b'],
      recommendation: 'deliver',
    }), /score from 0 to 100/)
  } finally {
    clearCrewStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('crew store rejects artifacts for nodes from another run', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('artifact-node-ownership')

  try {
    resetCrewStore(userDataDir)

    const crew = createCrewDefinition({ name: 'Research Crew', description: 'Research team.' })
    assert.ok(crew)
    const version = createCrewVersion({
      crewId: crew!.id,
      members: [member('lead', 'lead', 'lead-agent')],
    })
    assert.ok(version)
    const runA = createCrewRun({ crewId: crew!.id, crewVersionId: version!.id, title: 'Run A' })
    const runB = createCrewRun({ crewId: crew!.id, crewVersionId: version!.id, title: 'Run B' })
    assert.ok(runA)
    assert.ok(runB)
    const nodeA = createCrewRunNode({ crewRunId: runA!.id, kind: 'plan', title: 'Plan A' })
    assert.ok(nodeA)

    assert.throws(() => createCrewArtifact({
      crewRunId: runB!.id,
      nodeId: nodeA!.id,
      title: 'Wrong run artifact',
      mime: 'text/plain',
      uri: 'artifact://wrong-run',
    }), /does not belong/)
  } finally {
    clearCrewStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('crew store records schema version and persists trace events', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('schema')

  try {
    resetCrewStore(userDataDir)
    appendCoworkTraceEvent(createCoworkTraceEvent(traceInput()))

    const meta = getCrewDb().prepare('select value from crew_meta where key = ?')
      .get('schema_version') as { value?: string } | undefined
    const traces = listCoworkTraceEventsForRun('run-1')

    assert.equal(meta?.value, String(CREW_STORE_SCHEMA_VERSION))
    assert.equal(traces.length, 1)
    assert.equal(traces[0]?.schemaVersion, 1)
    assert.equal(traces[0]?.actor.id, 'lead')
    assert.deepEqual(traces[0]?.payload, { message: 'visible' })
  } finally {
    clearCrewStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('crew store migrates v1 crew versions to certification-aware schema', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('migrate-v1-certification')

  try {
    const oldDb = new DatabaseSync(join(userDataDir, 'crew.sqlite'))
    oldDb.exec(`
      create table crew_meta (
        key text primary key,
        value text not null
      );
      insert into crew_meta (key, value) values ('schema_version', '1');
      create table crew_versions (
        id text primary key,
        schema_version integer not null,
        crew_id text not null,
        version integer not null,
        members_json text not null,
        workspace_profile_id text,
        outcome_rubric_id text,
        budget_cap_usd real,
        workflow_json text not null,
        created_at text not null,
        created_by text,
        unique (crew_id, version)
      );
    `)
    oldDb.close()

    resetCrewStore(userDataDir)
    const columns = (getCrewDb().prepare('pragma table_info(crew_versions)').all() as Array<{ name?: string }>)
      .map((column) => column.name)
    const meta = getCrewDb().prepare('select value from crew_meta where key = ?')
      .get('schema_version') as { value?: string } | undefined

    assert.equal(meta?.value, String(CREW_STORE_SCHEMA_VERSION))
    assert.equal(columns.includes('eval_suite_id'), true)
    assert.equal(columns.includes('certification_status'), true)
    assert.equal(columns.includes('certified_at'), true)
  } finally {
    clearCrewStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('crew store exports run trace events as deterministic redacted NDJSON', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('export')

  try {
    resetCrewStore(userDataDir)
    appendCoworkTraceEvent(createCoworkTraceEvent(traceInput({
      id: 'trace-c',
      sequence: 2,
      payload: { message: 'third' },
      createdAt: '2026-05-10T00:00:02.000Z',
    })))
    appendCoworkTraceEvent(createCoworkTraceEvent(traceInput({
      id: 'trace-b',
      sequence: 1,
      payload: { secret: 'hide me' },
      payloadRef: 'artifact://payload-b',
      redactionState: 'redacted',
      createdAt: '2026-05-10T00:00:01.000Z',
    })))
    appendCoworkTraceEvent(createCoworkTraceEvent(traceInput({
      id: 'trace-a',
      sequence: 1,
      payload: { message: 'first' },
      createdAt: '2026-05-10T00:00:00.000Z',
    })))

    const listed = listCoworkTraceEventsForRun('run-1')
    const exported = exportCoworkTraceEventsForRun('run-1')
    const rows = exported.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)

    assert.deepEqual(listed.map((event) => event.id), ['trace-a', 'trace-b', 'trace-c'])
    assert.deepEqual(rows.map((row) => row.id), ['trace-a', 'trace-b', 'trace-c'])
    assert.deepEqual(rows[0]?.payload, { message: 'first' })
    assert.equal(rows[1]?.payload, null)
    assert.equal(rows[1]?.payloadRef, 'artifact://payload-b')
    assert.deepEqual(rows[2]?.payload, { message: 'third' })
  } finally {
    clearCrewStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

test('crew store rejects unsupported trace schema versions', () => {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir('version')

  try {
    resetCrewStore(userDataDir)
    const event = {
      ...createCoworkTraceEvent(traceInput()),
      schemaVersion: 999,
    }

    assert.throws(() => appendCoworkTraceEvent(event), /Unsupported trace event schema version 999/)
  } finally {
    clearCrewStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
