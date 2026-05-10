import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CrewDefinitionDraft } from '../packages/shared/src/crews.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  clearCrewStoreCache,
  getCrewRun,
  listCoworkTraceEventsForRun,
  listCrewApprovalsForRun,
  listCrewArtifactsForRun,
  listCrewRunNodes,
  updateCrewRunNodeStatus,
  updateCrewRunStatus,
} from '../apps/desktop/src/main/crew-store.ts'
import { projectCrewRuntimeEvent } from '../apps/desktop/src/main/crew-runtime-projector.ts'
import { createCrewFromDraft, recordCrewOutcomeEvaluation, startCrewRun } from '../apps/desktop/src/main/crew-service.ts'

function uniqueUserDataDir(name: string) {
  return mkdtempSync(join(tmpdir(), `open-cowork-crew-projector-${name}-`))
}

function resetCrewStore(userDataDir: string) {
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearCrewStoreCache()
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

function draft(): CrewDefinitionDraft {
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
  }
}

function startRootedCrewRun() {
  const crew = createCrewFromDraft(draft())
  const detail = startCrewRun({
    crewId: crew.definition.id,
    title: 'Analyze the weekly market',
    workItemTitle: 'Weekly market research',
  })
  updateCrewRunStatus(detail.run.id, 'running', { rootSessionId: 'root-session' })
  const plan = listCrewRunNodes(detail.run.id).find((node) => node.kind === 'plan')
  assert.ok(plan)
  updateCrewRunNodeStatus(plan.id, 'running', { sessionId: 'root-session' })
  return detail.run.id
}

test('crew runtime projector maps OpenCode task runs onto configured crew nodes', () => withCrewStore('task-run', () => {
  const crew = createCrewFromDraft(draft())
  const detail = startCrewRun({
    crewId: crew.definition.id,
    title: 'Analyze the weekly market',
    workItemTitle: 'Weekly market research',
  })
  updateCrewRunStatus(detail.run.id, 'running', { rootSessionId: 'root-session' })
  const plan = listCrewRunNodes(detail.run.id).find((node) => node.kind === 'plan')
  assert.ok(plan)
  updateCrewRunNodeStatus(plan.id, 'running', { sessionId: 'root-session' })

  projectCrewRuntimeEvent({
    type: 'task_run',
    sessionId: 'root-session',
    data: {
      type: 'task_run',
      id: 'task-analyst',
      title: 'Analyze conversion metrics',
      agent: 'analyst',
      status: 'running',
      sourceSessionId: 'child-analyst',
      parentSessionId: 'root-session',
    },
  })

  let analyst = listCrewRunNodes(detail.run.id).find((node) => node.agentName === 'analyst')
  assert.equal(analyst?.status, 'running')
  assert.equal(analyst?.sessionId, 'child-analyst')

  projectCrewRuntimeEvent({
    type: 'task_run',
    sessionId: 'root-session',
    data: {
      type: 'task_run',
      id: 'task-analyst',
      title: 'Analyze conversion metrics',
      agent: 'analyst',
      status: 'complete',
      sourceSessionId: 'child-analyst',
      parentSessionId: 'root-session',
    },
  })

  analyst = listCrewRunNodes(detail.run.id).find((node) => node.agentName === 'analyst')
  assert.equal(analyst?.status, 'completed')
  const traces = listCoworkTraceEventsForRun(detail.run.id).filter((event) => event.payload?.type === 'crew_run.task_run')
  assert.equal(traces.length, 2)
  assert.equal(traces[0]?.nodeId, analyst?.id)
  assert.equal(traces[0]?.payload?.taskRunId, 'task-analyst')
}))

test('crew runtime projector traces tool calls without persisting raw tool payloads', () => withCrewStore('tool-call', () => {
  const crew = createCrewFromDraft(draft())
  const detail = startCrewRun({
    crewId: crew.definition.id,
    title: 'Analyze the weekly market',
  })
  updateCrewRunStatus(detail.run.id, 'running', { rootSessionId: 'root-session' })

  projectCrewRuntimeEvent({
    type: 'task_run',
    sessionId: 'root-session',
    data: {
      type: 'task_run',
      id: 'task-charts',
      title: 'Build charts',
      agent: 'charts',
      status: 'running',
      sourceSessionId: 'child-charts',
      parentSessionId: 'root-session',
    },
  })

  const toolEvent = {
    type: 'tool_call',
    sessionId: 'root-session',
    data: {
      type: 'tool_call',
      id: 'tool-1',
      name: 'chart.create',
      input: { rows: [{ date: '2026-05-01', sessions: 123 }] },
      status: 'completed',
      output: { html: '<div>chart</div>' },
      agent: 'charts',
      taskRunId: 'task-charts',
      sourceSessionId: 'child-charts',
      attachments: [{ mime: 'text/html', url: 'artifact://chart-1', filename: 'chart.html' }],
    },
  } as const
  projectCrewRuntimeEvent(toolEvent)
  projectCrewRuntimeEvent(toolEvent)

  const traces = listCoworkTraceEventsForRun(detail.run.id).filter((event) => event.payload?.type === 'crew_run.tool_call')
  assert.equal(traces.length, 1)
  assert.equal(traces[0]?.inputHash?.startsWith('sha256:'), true)
  assert.equal(traces[0]?.outputHash?.startsWith('sha256:'), true)
  assert.equal(Object.hasOwn(traces[0]?.payload || {}, 'input'), false)
  assert.equal(Object.hasOwn(traces[0]?.payload || {}, 'output'), false)
  assert.equal(traces[0]?.payload?.attachmentCount, 1)

  const artifacts = listCrewArtifactsForRun(detail.run.id)
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0]?.title, 'chart.html')
  assert.equal(artifacts[0]?.uri, 'artifact://chart-1')
}))

test('crew runtime projector records approvals idempotently and unblocks on resolution', () => withCrewStore('approval', () => {
  const crew = createCrewFromDraft(draft())
  const detail = startCrewRun({
    crewId: crew.definition.id,
    title: 'Analyze the weekly market',
  })
  updateCrewRunStatus(detail.run.id, 'running', { rootSessionId: 'root-session' })

  projectCrewRuntimeEvent({
    type: 'task_run',
    sessionId: 'root-session',
    data: {
      type: 'task_run',
      id: 'task-analyst',
      title: 'Analyze private files',
      agent: 'analyst',
      status: 'running',
      sourceSessionId: 'child-analyst',
      parentSessionId: 'root-session',
    },
  })

  const approvalEvent = {
    type: 'approval',
    sessionId: 'root-session',
    data: {
      type: 'approval',
      id: 'approval-1',
      taskRunId: 'task-analyst',
      tool: 'bash',
      input: { cmd: 'cat private.csv' },
      description: 'Analyst: bash',
      sourceSessionId: 'child-analyst',
    },
  } as const
  projectCrewRuntimeEvent(approvalEvent)
  projectCrewRuntimeEvent(approvalEvent)

  let approvals = listCrewApprovalsForRun(detail.run.id)
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0]?.status, 'requested')
  assert.equal(listCrewRunNodes(detail.run.id).find((node) => node.agentName === 'analyst')?.status, 'blocked')

  projectCrewRuntimeEvent({
    type: 'approval_resolved',
    sessionId: 'root-session',
    data: {
      type: 'approval_resolved',
      id: 'approval-1',
      status: 'approved',
    },
  })

  approvals = listCrewApprovalsForRun(detail.run.id)
  assert.equal(approvals[0]?.status, 'approved')
  assert.equal(listCrewRunNodes(detail.run.id).find((node) => node.agentName === 'analyst')?.status, 'running')
  assert.equal(listCoworkTraceEventsForRun(detail.run.id).filter((event) => event.payload?.type === 'crew_run.approval_requested').length, 1)
  assert.equal(listCoworkTraceEventsForRun(detail.run.id).filter((event) => event.payload?.type === 'crew_run.approval_resolved').length, 1)
}))

test('crew runtime projector keeps a denied approval blocked instead of reopening the run', () => withCrewStore('approval-denied', () => {
  const crew = createCrewFromDraft(draft())
  const detail = startCrewRun({
    crewId: crew.definition.id,
    title: 'Analyze the weekly market',
  })
  updateCrewRunStatus(detail.run.id, 'running', { rootSessionId: 'root-session' })

  projectCrewRuntimeEvent({
    type: 'task_run',
    sessionId: 'root-session',
    data: {
      type: 'task_run',
      id: 'task-analyst',
      title: 'Analyze private files',
      agent: 'analyst',
      status: 'running',
      sourceSessionId: 'child-analyst',
      parentSessionId: 'root-session',
    },
  })
  projectCrewRuntimeEvent({
    type: 'approval',
    sessionId: 'root-session',
    data: {
      type: 'approval',
      id: 'approval-denied',
      taskRunId: 'task-analyst',
      tool: 'bash',
      input: { cmd: 'cat private.csv' },
      description: 'Analyst: bash',
      sourceSessionId: 'child-analyst',
    },
  })
  projectCrewRuntimeEvent({
    type: 'approval_resolved',
    sessionId: 'root-session',
    data: {
      type: 'approval_resolved',
      id: 'approval-denied',
      status: 'denied',
    },
  })

  assert.equal(getCrewRun(detail.run.id)?.status, 'blocked')
  assert.equal(listCrewRunNodes(detail.run.id).find((node) => node.agentName === 'analyst')?.status, 'failed')
  assert.equal(listCrewApprovalsForRun(detail.run.id)[0]?.status, 'denied')
}))

test('crew runtime projector keeps a ten-agent run inspectable from product graph state', () => withCrewStore('ten-agent', () => {
  const runId = startRootedCrewRun()
  for (let index = 0; index < 10; index += 1) {
    projectCrewRuntimeEvent({
      type: 'task_run',
      sessionId: 'root-session',
      data: {
        type: 'task_run',
        id: `task-${index}`,
        title: `Specialist branch ${index}`,
        agent: `specialist-${index}`,
        status: 'running',
        sourceSessionId: `child-${index}`,
        parentSessionId: 'root-session',
      },
    })
  }

  const dynamicNodes = listCrewRunNodes(runId).filter((node) => node.agentName?.startsWith('specialist-'))
  assert.equal(dynamicNodes.length, 10)
  assert.equal(dynamicNodes.every((node) => node.status === 'running' && node.sessionId?.startsWith('child-')), true)
  assert.equal(listCoworkTraceEventsForRun(runId).filter((event) => event.payload?.type === 'crew_run.task_run').length, 10)
}))

test('crew runtime projector moves root done events into evaluation until an outcome exists', () => withCrewStore('done-needs-eval', () => {
  const crew = createCrewFromDraft(draft())
  const detail = startCrewRun({
    crewId: crew.definition.id,
    title: 'Analyze the weekly market',
  })
  updateCrewRunStatus(detail.run.id, 'running', { rootSessionId: 'root-session' })

  projectCrewRuntimeEvent({
    type: 'done',
    sessionId: 'root-session',
    data: { type: 'done' },
  })

  const nodes = listCrewRunNodes(detail.run.id)
  assert.equal(nodes.find((node) => node.kind === 'plan')?.status, 'completed')
  assert.equal(nodes.find((node) => node.kind === 'join')?.status, 'completed')
  assert.equal(nodes.find((node) => node.kind === 'evaluate')?.status, 'running')
  assert.equal(nodes.find((node) => node.kind === 'deliver')?.status, 'queued')
  assert.equal(nodes.filter((node) => node.kind === 'delegate').every((node) => node.status === 'skipped'), true)
  assert.equal(getCrewRun(detail.run.id)?.status, 'evaluating')
  assert.equal(listCoworkTraceEventsForRun(detail.run.id).at(-1)?.payload?.type, 'crew_run.ready_for_evaluation')
}))

test('crew runtime projector can complete the crew run after a passing evaluator outcome', () => withCrewStore('done-after-eval', () => {
  const crew = createCrewFromDraft(draft())
  const detail = startCrewRun({
    crewId: crew.definition.id,
    title: 'Analyze the weekly market',
  })
  updateCrewRunStatus(detail.run.id, 'running', { rootSessionId: 'root-session' })
  recordCrewOutcomeEvaluation({
    runId: detail.run.id,
    status: 'passed',
    score: 90,
    evidenceTraceEventIds: [detail.traceEvents[0]!.id],
    recommendation: 'deliver',
  })

  projectCrewRuntimeEvent({
    type: 'done',
    sessionId: 'root-session',
    data: { type: 'done' },
  })

  const nodes = listCrewRunNodes(detail.run.id)
  assert.equal(nodes.find((node) => node.kind === 'evaluate')?.status, 'completed')
  assert.equal(nodes.find((node) => node.kind === 'deliver')?.status, 'completed')
  assert.equal(getCrewRun(detail.run.id)?.status, 'completed')
  assert.equal(listCoworkTraceEventsForRun(detail.run.id).at(-1)?.payload?.type, 'crew_run.completed')
}))

test('crew runtime projector treats child-session errors as blockers instead of root run crashes', () => withCrewStore('branch-error', () => {
  const runId = startRootedCrewRun()
  projectCrewRuntimeEvent({
    type: 'task_run',
    sessionId: 'root-session',
    data: {
      type: 'task_run',
      id: 'task-analyst',
      title: 'Analyze source data',
      agent: 'analyst',
      status: 'running',
      sourceSessionId: 'child-analyst',
      parentSessionId: 'root-session',
    },
  })

  projectCrewRuntimeEvent({
    type: 'error',
    sessionId: 'root-session',
    data: {
      type: 'error',
      message: 'CSV parse failed',
      taskRunId: 'task-analyst',
      sourceSessionId: 'child-analyst',
    },
  })

  assert.equal(getCrewRun(runId)?.status, 'blocked')
  assert.equal(listCrewRunNodes(runId).find((node) => node.agentName === 'analyst')?.status, 'failed')
  assert.equal(listCoworkTraceEventsForRun(runId).at(-1)?.payload?.type, 'crew_run.branch_failed')

  projectCrewRuntimeEvent({
    type: 'task_run',
    sessionId: 'root-session',
    data: {
      type: 'task_run',
      id: 'task-charts',
      title: 'Build charts',
      agent: 'charts',
      status: 'complete',
      sourceSessionId: 'child-charts',
      parentSessionId: 'root-session',
    },
  })

  assert.equal(getCrewRun(runId)?.status, 'blocked')
}))
