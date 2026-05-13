import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CrewDetail, CrewListPayload, CrewRunDetail } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { CrewsPage } from './CrewsPage'

vi.mock('../../helpers/i18n', () => ({
  t: (_key: string, fallback: string) => fallback,
}))

const crew = {
  schemaVersion: 1,
  id: 'crew-1',
  name: 'Operations Crew',
  description: 'A supervised operations team.',
  status: 'draft' as const,
  activeVersionId: 'version-1',
  createdAt: '2026-05-10T00:00:00.000Z',
  updatedAt: '2026-05-10T00:00:00.000Z',
}

const version = {
  schemaVersion: 1,
  id: 'version-1',
  crewId: crew.id,
  version: 1,
  members: [
    { schemaVersion: 1, id: 'lead', role: 'lead' as const, agentName: 'plan', displayName: 'Planner', description: 'Plans', required: true },
    { schemaVersion: 1, id: 'explore', role: 'specialist' as const, agentName: 'explore', displayName: 'Explorer', description: 'Explores', required: true },
    { schemaVersion: 1, id: 'build', role: 'specialist' as const, agentName: 'build', displayName: 'Builder', description: 'Builds', required: true },
    { schemaVersion: 1, id: 'eval', role: 'evaluator' as const, agentName: 'general', displayName: 'Evaluator', description: 'Evaluates', required: true },
  ],
  workspaceProfileId: null,
  outcomeRubricId: null,
  evalSuiteId: null,
  certificationStatus: 'not_required' as const,
  certifiedAt: null,
  budgetCapUsd: 4,
  workflow: ['plan' as const, 'delegate' as const, 'join' as const, 'evaluate' as const, 'deliver' as const],
  createdAt: '2026-05-10T00:00:00.000Z',
  createdBy: 'local-user',
}

const run = {
  schemaVersion: 1,
  id: 'run-1',
  crewId: crew.id,
  crewVersionId: version.id,
  workItemId: 'work-1',
  status: 'planning' as const,
  title: 'Starter team run',
  summary: null,
  rootSessionId: null,
  createdAt: '2026-05-10T00:01:00.000Z',
  startedAt: '2026-05-10T00:01:01.000Z',
  finishedAt: null,
}

const secondRun = {
  ...run,
  id: 'run-2',
  title: 'Second analysis run',
  status: 'completed' as const,
  createdAt: '2026-05-10T00:10:00.000Z',
  startedAt: '2026-05-10T00:10:01.000Z',
  finishedAt: '2026-05-10T00:12:00.000Z',
}

const detail: CrewDetail = {
  definition: crew,
  versions: [version],
  activeVersion: version,
  runs: [run],
}

const detailWithRuns: CrewDetail = {
  ...detail,
  runs: [run, secondRun],
}

const detailWithoutRuns: CrewDetail = {
  ...detail,
  runs: [],
}

const runDetail: CrewRunDetail = {
  run,
  crew,
  version,
  workItem: null,
  nodes: [
    { schemaVersion: 1, id: 'node-plan', crewRunId: run.id, sequence: 1, kind: 'plan', status: 'running', agentName: 'plan', sessionId: 'session-root', parentNodeId: null, title: 'Plan work', startedAt: null, finishedAt: null },
    { schemaVersion: 1, id: 'node-delegate', crewRunId: run.id, sequence: 2, kind: 'delegate', status: 'blocked', agentName: 'explore', sessionId: 'session-child', parentNodeId: 'node-plan', title: 'Delegate to Explorer', startedAt: null, finishedAt: null },
    { schemaVersion: 1, id: 'node-join', crewRunId: run.id, sequence: 3, kind: 'join', status: 'queued', agentName: null, sessionId: null, parentNodeId: 'node-plan', title: 'Join specialist outputs', startedAt: null, finishedAt: null },
  ],
  artifacts: [{
    schemaVersion: 1,
    id: 'artifact-1',
    crewRunId: run.id,
    nodeId: 'node-delegate',
    title: 'Research notes',
    mime: 'text/markdown',
    uri: 'artifact://research-notes',
    hash: 'sha256:artifact',
    createdAt: '2026-05-10T00:02:00.000Z',
  }],
  approvals: [{
    schemaVersion: 1,
    id: 'approval-1',
    crewRunId: run.id,
    nodeId: 'node-delegate',
    status: 'requested',
    title: 'Approve external lookup',
    body: 'Explorer needs approval before continuing.',
    requestedAt: '2026-05-10T00:02:10.000Z',
    resolvedAt: null,
    resolvedBy: null,
  }],
  policyDecisions: [{
    schemaVersion: 1,
    id: 'policy-1',
    runId: run.id,
    runKind: 'crew',
    nodeId: 'node-delegate',
    status: 'approval_required',
    reason: 'External read needs review.',
    capabilityId: 'web',
    createdAt: '2026-05-10T00:02:05.000Z',
  }],
  evaluations: [{
    schemaVersion: 1,
    id: 'eval-1',
    crewRunId: run.id,
    evaluatorAgentName: 'general',
    rubricId: 'rubric-1',
    status: 'needs_revision',
    score: 72,
    evidenceTraceEventIds: ['trace-1'],
    recommendation: 'revise',
    createdAt: '2026-05-10T00:03:00.000Z',
  }],
  traceEvents: [
    {
      schemaVersion: 1,
      id: 'trace-1',
      sequence: 1,
      runId: run.id,
      runKind: 'crew',
      source: 'cowork_worker',
      sourceEventId: null,
      correlationId: run.id,
      causationId: null,
      sessionId: null,
      parentSessionId: null,
      actor: { kind: 'crew', id: crew.id },
      nodeId: null,
      artifactId: null,
      approvalId: null,
      policyDecisionId: null,
      inputHash: null,
      outputHash: null,
      payloadRef: null,
      payloadHash: null,
      redactionState: 'none',
      tokenUsage: null,
      costUsd: null,
      payload: { type: 'crew_run.created' },
      createdAt: '2026-05-10T00:01:00.000Z',
    },
    {
      schemaVersion: 1,
      id: 'trace-2',
      sequence: 2,
      runId: run.id,
      runKind: 'crew',
      source: 'opencode_event',
      sourceEventId: 'tool-1',
      correlationId: run.id,
      causationId: null,
      sessionId: 'session-child',
      parentSessionId: 'session-root',
      actor: { kind: 'agent', id: 'explore' },
      nodeId: 'node-delegate',
      artifactId: null,
      approvalId: null,
      policyDecisionId: null,
      inputHash: 'sha256:input',
      outputHash: 'sha256:output',
      payloadRef: null,
      payloadHash: null,
      redactionState: 'none',
      tokenUsage: { input: 10, output: 20, reasoning: 5, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.12,
      payload: { type: 'crew_run.tool_call', toolName: 'web_search', status: 'completed' },
      createdAt: '2026-05-10T00:02:00.000Z',
    },
  ],
}

function payload(): CrewListPayload {
  return {
    crews: [{ definition: crew, activeVersion: version, latestRun: run }],
  }
}

const traceNdjson = [
  '{"schemaVersion":1,"id":"trace-1","payload":{"type":"crew_run.created"}}',
  '{"schemaVersion":1,"id":"trace-2","payload":{"type":"crew_run.tool_call","toolName":"web_search"}}',
].join('\n')

describe('CrewsPage', () => {
  it('loads crew detail and renders operational run panels from trace state', async () => {
    installRendererTestCoworkApi({
      crews: {
        list: vi.fn(async () => payload()),
        get: vi.fn(async () => detail),
        runDetail: vi.fn(async () => runDetail),
        evaluate: vi.fn(async () => runDetail),
        exportTrace: vi.fn(async () => traceNdjson),
      },
    })

    render(<CrewsPage />)

    expect((await screen.findAllByText('Operations Crew')).length).toBeGreaterThan(0)
    expect(screen.getByText('Plan work')).toBeInTheDocument()
    expect(screen.getByText('Delegate to Explorer')).toBeInTheDocument()
    expect(screen.getByText('crew_run.created')).toBeInTheDocument()
    expect(screen.getByText('Authority')).toBeInTheDocument()
    expect(screen.getByText('Needs attention')).toBeInTheDocument()
    expect(screen.getAllByText('Approve external lookup').length).toBeGreaterThan(0)
    expect(screen.getByText('Research notes')).toBeInTheDocument()
    expect(screen.getByText('web_search')).toBeInTheDocument()
    expect(screen.getByText('Quality gate')).toBeInTheDocument()
  })

  it('creates the starter crew and runs the team', async () => {
    const user = userEvent.setup()
    const create = vi.fn(async () => detail)
    const runCrew = vi.fn(async () => runDetail)
    installRendererTestCoworkApi({
      crews: {
        list: vi.fn(async () => ({ crews: [] })),
        get: vi.fn(async () => detail),
        create,
        run: runCrew,
        runDetail: vi.fn(async () => null),
        evaluate: vi.fn(async () => runDetail),
        exportTrace: vi.fn(async () => traceNdjson),
      },
    })

    render(<CrewsPage />)

    await user.click(await screen.findByRole('button', { name: 'Create starter crew' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Operations Crew',
      members: expect.arrayContaining([
        expect.objectContaining({ role: 'lead', agentName: 'plan' }),
        expect.objectContaining({ role: 'evaluator', agentName: 'general' }),
      ]),
    })))

    await user.click(screen.getByRole('button', { name: 'Run team' }))
    await waitFor(() => expect(runCrew).toHaveBeenCalledWith(expect.objectContaining({
      crewId: crew.id,
      title: 'Starter team run',
    })))
  })

  it('saves crew edits through a new active version', async () => {
    const user = userEvent.setup()
    const updatedVersion = {
      ...version,
      id: 'version-2',
      version: 2,
      budgetCapUsd: 7,
      members: version.members.map((member) => (
        member.id === 'build' ? { ...member, displayName: 'Builder Pro' } : member
      )),
    }
    const updatedDetail: CrewDetail = {
      ...detail,
      versions: [version, updatedVersion],
      activeVersion: updatedVersion,
      definition: {
        ...detail.definition,
        activeVersionId: updatedVersion.id,
        updatedAt: '2026-05-10T00:05:00.000Z',
      },
    }
    const update = vi.fn(async () => updatedDetail)
    installRendererTestCoworkApi({
      crews: {
        list: vi.fn(async () => payload()),
        get: vi.fn(async () => detail),
        runDetail: vi.fn(async () => runDetail),
        update,
        evaluate: vi.fn(async () => runDetail),
        exportTrace: vi.fn(async () => traceNdjson),
      },
    })

    render(<CrewsPage />)

    await user.click(await screen.findByRole('button', { name: 'Edit crew' }))
    const budget = screen.getByLabelText('Budget cap')
    await user.clear(budget)
    await user.type(budget, '7')
    const builderName = screen.getByDisplayValue('Builder')
    await user.clear(builderName)
    await user.type(builderName, 'Builder Pro')
    await user.click(screen.getByRole('button', { name: 'Save new version' }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith(crew.id, expect.objectContaining({
      name: 'Operations Crew',
      budgetCapUsd: 7,
      members: expect.arrayContaining([
        expect.objectContaining({ role: 'lead', agentName: 'plan' }),
        expect.objectContaining({ role: 'specialist', agentName: 'build', displayName: 'Builder Pro' }),
        expect.objectContaining({ role: 'evaluator', agentName: 'general' }),
      ]),
    }))
  })

  it('exports trace events as deterministic NDJSON through the save dialog', async () => {
    const user = userEvent.setup()
    const saveText = vi.fn(async (_defaultFilename: string, _content: string) => '/tmp/crew-trace.ndjson')
    const exportTrace = vi.fn(async () => traceNdjson)
    installRendererTestCoworkApi({
      crews: {
        list: vi.fn(async () => payload()),
        get: vi.fn(async () => detail),
        runDetail: vi.fn(async () => runDetail),
        evaluate: vi.fn(async () => runDetail),
        exportTrace,
      },
      dialog: {
        saveText,
      },
    })

    render(<CrewsPage />)

    await user.click(await screen.findByRole('button', { name: 'Export trace' }))

    await waitFor(() => expect(saveText).toHaveBeenCalledTimes(1))
    expect(exportTrace).toHaveBeenCalledWith(run.id)
    expect(saveText.mock.calls[0]?.[0]).toBe('starter-team-run-trace.ndjson')
    expect(saveText.mock.calls[0]?.[1]).toContain('"id":"trace-1"')
    expect(saveText.mock.calls[0]?.[1]).toContain('"type":"crew_run.tool_call"')
  })

  it('bounds long trace export filenames before opening the save dialog', async () => {
    const user = userEvent.setup()
    const saveText = vi.fn(async (_defaultFilename: string, _content: string) => '/tmp/crew-trace.ndjson')
    installRendererTestCoworkApi({
      crews: {
        list: vi.fn(async () => payload()),
        get: vi.fn(async () => detail),
        runDetail: vi.fn(async () => ({
          ...runDetail,
          run: {
            ...runDetail.run,
            title: `${'Quarterly Operations Crew '.repeat(40)}final review`,
          },
        })),
        evaluate: vi.fn(async () => runDetail),
        exportTrace: vi.fn(async () => traceNdjson),
      },
      dialog: {
        saveText,
      },
    })

    render(<CrewsPage />)

    await user.click(await screen.findByRole('button', { name: 'Export trace' }))

    await waitFor(() => expect(saveText).toHaveBeenCalledTimes(1))
    const filename = saveText.mock.calls[0]?.[0] || ''
    expect(filename.endsWith('-trace.ndjson')).toBe(true)
    expect(filename.length).toBeLessThan(220)
  })

  it('does not let stale run-detail responses overwrite the selected run', async () => {
    const user = userEvent.setup()
    let resolveSecondRun!: (value: CrewRunDetail) => void
    const secondRunDeferred = new Promise<CrewRunDetail>((resolve) => {
      resolveSecondRun = resolve
    })
    const firstRunDetail = { ...runDetail, run }
    const secondRunDetail = { ...runDetail, run: secondRun }
    const runDetailMock = vi.fn(async (runId: string) => {
      if (runId === secondRun.id) return await secondRunDeferred
      return firstRunDetail
    })
    installRendererTestCoworkApi({
      crews: {
        list: vi.fn(async () => ({ crews: [{ definition: crew, activeVersion: version, latestRun: secondRun }] })),
        get: vi.fn(async () => detailWithRuns),
        runDetail: runDetailMock,
        evaluate: vi.fn(async () => runDetail),
        exportTrace: vi.fn(async () => traceNdjson),
      },
    })

    render(<CrewsPage />)

    await screen.findByRole('heading', { name: run.title })
    await user.click(screen.getByRole('button', { name: new RegExp(secondRun.title) }))
    await user.click(screen.getByRole('button', { name: new RegExp(run.title) }))
    resolveSecondRun(secondRunDetail)

    await waitFor(() => expect(runDetailMock).toHaveBeenCalledWith(secondRun.id))
    expect(screen.getByRole('heading', { name: run.title })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: secondRun.title })).not.toBeInTheDocument()
  })

  it('runs the evaluator for the selected crew run', async () => {
    const user = userEvent.setup()
    const evaluate = vi.fn(async () => ({
      ...runDetail,
      run: { ...runDetail.run, status: 'completed' as const },
    }))
    installRendererTestCoworkApi({
      crews: {
        list: vi.fn(async () => payload()),
        get: vi.fn(async () => detail),
        runDetail: vi.fn(async () => runDetail),
        evaluate,
        exportTrace: vi.fn(async () => traceNdjson),
      },
    })

    render(<CrewsPage />)

    await user.click(await screen.findByRole('button', { name: 'Run evaluator' }))

    await waitFor(() => expect(evaluate).toHaveBeenCalledWith(run.id))
  })

  it('deletes a crew with no run history through a destructive confirmation', async () => {
    const user = userEvent.setup()
    const list = vi.fn()
      .mockResolvedValueOnce({
        crews: [{ definition: crew, activeVersion: version, latestRun: null }],
      })
      .mockResolvedValueOnce({ crews: [] })
    const requestDestructive = vi.fn(async () => ({
      token: 'delete-token',
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    }))
    const deleteCrew = vi.fn(async () => true)
    installRendererTestCoworkApi({
      confirm: {
        requestDestructive,
      },
      crews: {
        list,
        get: vi.fn(async () => detailWithoutRuns),
        delete: deleteCrew,
        runDetail: vi.fn(async () => null),
      },
    })

    render(<CrewsPage />)

    await user.click(await screen.findByRole('button', { name: 'Delete crew' }))

    await waitFor(() => expect(deleteCrew).toHaveBeenCalledWith(crew.id, 'delete-token'))
    expect(requestDestructive).toHaveBeenCalledWith({ action: 'crew.delete', crewId: crew.id })
    expect(await screen.findByText('No crews yet. Create a starter crew to seed your first supervised team.')).toBeInTheDocument()
  })

  it('retires a crew with run history and disables new runs', async () => {
    const user = userEvent.setup()
    const retiredCrew = { ...crew, status: 'retired' as const }
    const retiredDetail: CrewDetail = {
      ...detail,
      definition: retiredCrew,
    }
    let currentDetail = detail
    const requestDestructive = vi.fn(async () => ({
      token: 'retire-token',
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    }))
    const retire = vi.fn(async () => {
      currentDetail = retiredDetail
      return retiredDetail
    })
    installRendererTestCoworkApi({
      confirm: {
        requestDestructive,
      },
      crews: {
        list: vi.fn(async () => payload()),
        get: vi.fn(async () => currentDetail),
        runDetail: vi.fn(async () => runDetail),
        retire,
        evaluate: vi.fn(async () => runDetail),
        exportTrace: vi.fn(async () => traceNdjson),
      },
    })

    render(<CrewsPage />)

    await user.click(await screen.findByRole('button', { name: 'Retire crew' }))

    await waitFor(() => expect(retire).toHaveBeenCalledWith(crew.id, 'retire-token'))
    expect(requestDestructive).toHaveBeenCalledWith({ action: 'crew.retire', crewId: crew.id })
    expect(await screen.findByRole('button', { name: 'Retired' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run team' })).toBeDisabled()
  })
})
