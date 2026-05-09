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
  executeCrewRunWithOpenCode,
  getCrewDetail,
  listCrewCatalog,
  startCrewRun,
  startCrewRunWithOpenCode,
  validateCrewDefinitionDraft,
} from '../apps/desktop/src/main/crew-service.ts'

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
    outcomeRubricId: 'rubric-default',
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
