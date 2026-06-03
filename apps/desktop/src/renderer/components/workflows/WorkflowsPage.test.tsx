import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoworkAPI, EffectiveAppSettings, WorkflowListPayload } from '@open-cowork/shared'
import { WorkflowsPage } from './WorkflowsPage'
import { useSessionStore } from '../../stores/session'
import { WORKSPACE_SUPPORT_APIS, unavailableWorkspaceSupport, useWorkspaceSupportStore } from '../../stores/workspace-support'

function payload(overrides: Partial<WorkflowListPayload> = {}): WorkflowListPayload {
  return {
    workflows: [{
      id: 'workflow-1',
      title: 'Inbox summary',
      instructions: 'Scan the inbox and email a concise workload summary.',
      agentName: 'build',
      skillNames: ['email-triage'],
      toolIds: ['gmail'],
      status: 'active',
      projectDirectory: null,
      draftSessionId: 'ses_draft',
      triggers: [
        { id: 'manual', type: 'manual', enabled: true },
        { id: 'webhook', type: 'webhook', enabled: true, webhookSecret: 'secret' },
      ],
      createdAt: '2026-05-14T08:00:00.000Z',
      updatedAt: '2026-05-14T08:00:00.000Z',
      nextRunAt: null,
      lastRunAt: null,
      latestRunId: null,
      latestRunStatus: null,
      latestRunSessionId: null,
      latestRunSummary: null,
      webhookUrl: 'http://127.0.0.1:47839/workflows/workflow-1',
    }],
    runs: [],
    ...overrides,
  }
}

function installApi(
  workflowPayload = payload(),
  runtimeConfigSource: EffectiveAppSettings['runtimeConfigSource'] = 'app',
) {
  let workflowUpdated: (() => void) | null = null
  const api = {
    settings: {
      get: vi.fn(async () => ({ runtimeConfigSource })),
    },
    workflows: {
      list: vi.fn(async () => workflowPayload),
      get: vi.fn(async () => null),
      startDraft: vi.fn(async () => ({
        id: 'ses_new',
        title: 'New workflow draft',
        directory: null,
        createdAt: '2026-05-14T08:00:00.000Z',
        updatedAt: '2026-05-14T08:00:00.000Z',
        kind: 'workflow_draft' as const,
        workflowId: null,
        runId: null,
        parentSessionId: null,
        changeSummary: null,
        revertedMessageId: null,
      })),
      runNow: vi.fn(async () => ({
        id: 'run-1',
        workflowId: 'workflow-1',
        sessionId: 'ses_run',
        triggerType: 'manual' as const,
        triggerPayload: null,
        status: 'running' as const,
        title: 'Run Inbox summary',
        summary: null,
        error: null,
        createdAt: '2026-05-14T08:00:00.000Z',
        startedAt: '2026-05-14T08:00:00.000Z',
        finishedAt: null,
      })),
      pause: vi.fn(async () => null),
      resume: vi.fn(async () => null),
      archive: vi.fn(async () => null),
      regenerateWebhookSecret: vi.fn(async () => null),
    },
    on: {
      workflowUpdated: vi.fn((handler: () => void) => {
        workflowUpdated = handler
        return () => {
          workflowUpdated = null
        }
      }),
    },
  } as unknown as CoworkAPI
  Object.defineProperty(window, 'coworkApi', {
    value: api,
    configurable: true,
  })
  return {
    api,
    triggerWorkflowUpdated: () => workflowUpdated?.(),
  }
}

describe('WorkflowsPage', () => {
  beforeEach(() => {
    useSessionStore.setState({ activeWorkspaceId: 'local' })
    useWorkspaceSupportStore.setState({
      supportByWorkspace: {},
      loadedByWorkspace: {},
      loadingByWorkspace: {},
      errorByWorkspace: {},
    })
  })

  it('starts workflow creation in a setup thread', async () => {
    const { api } = installApi(payload({ workflows: [] }))
    const onOpenThread = vi.fn()
    render(<WorkflowsPage onOpenThread={onOpenThread} />)

    await screen.findByText('No workflows yet')
    await userEvent.click(screen.getAllByRole('button', { name: 'Add workflow' })[0]!)

    expect(api.workflows?.startDraft).toHaveBeenCalledTimes(1)
    expect(api.workflows?.startDraft).toHaveBeenCalledWith()
    await waitFor(() => expect(onOpenThread).toHaveBeenCalledWith('ses_new'))
  })

  it('blocks workflow setup when using machine OpenCode config', async () => {
    const { api } = installApi(payload({ workflows: [] }), 'machine')
    const onOpenThread = vi.fn()
    render(<WorkflowsPage onOpenThread={onOpenThread} />)

    await screen.findByText('No workflows yet')
    const buttons = await screen.findAllByRole('button', { name: 'Add workflow' })
    await waitFor(() => expect(buttons[0]).toBeDisabled())

    expect(api.workflows?.startDraft).not.toHaveBeenCalled()
    expect(onOpenThread).not.toHaveBeenCalled()
    expect(screen.getByText(/requires the in-app OpenCode config source/i)).toBeInTheDocument()
  })

  it('renders saved workflows and opens runs from actions', async () => {
    const { api } = installApi()
    const onOpenThread = vi.fn()
    render(<WorkflowsPage onOpenThread={onOpenThread} />)

    expect(await screen.findByText('Inbox summary')).toBeInTheDocument()
    expect(screen.getByText('Webhook')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Run' }))

    expect(api.workflows?.runNow).toHaveBeenCalledWith('workflow-1')
    await waitFor(() => expect(onOpenThread).toHaveBeenCalledWith('ses_run'))
  })

  it('uses cloud workflow APIs and hides local webhook mutation controls', async () => {
    useSessionStore.setState({ activeWorkspaceId: 'cloud:test' })
    useWorkspaceSupportStore.setState({
      supportByWorkspace: {
        'cloud:test': WORKSPACE_SUPPORT_APIS.map((api) => ({
          api,
          status: api === 'workflows.list' || api === 'workflows.run' ? 'supported' : 'not_supported',
          verdict: {
            allowed: api === 'workflows.list' || api === 'workflows.run',
            reason: api.startsWith('workflows') ? null : 'Blocked by cloud policy.',
          },
        })),
      },
      loadedByWorkspace: { 'cloud:test': true },
      loadingByWorkspace: {},
      errorByWorkspace: {},
    })
    const { api } = installApi()
    const onOpenThread = vi.fn()

    render(<WorkflowsPage onOpenThread={onOpenThread} />)

    expect(await screen.findByText('Inbox summary')).toBeInTheDocument()
    expect(api.workflows?.list).toHaveBeenCalledWith({ workspaceId: 'cloud:test' })
    expect(screen.queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Run' }))

    expect(api.workflows?.runNow).toHaveBeenCalledWith('workflow-1', { workspaceId: 'cloud:test' })
    await waitFor(() => expect(onOpenThread).toHaveBeenCalledWith('ses_run'))
  })

  it('fails closed for cloud workflow access when workspace support cannot load', async () => {
    useSessionStore.setState({ activeWorkspaceId: 'cloud:test' })
    useWorkspaceSupportStore.setState({
      supportByWorkspace: { 'cloud:test': unavailableWorkspaceSupport('support failed') },
      loadedByWorkspace: { 'cloud:test': true },
      loadingByWorkspace: {},
      errorByWorkspace: { 'cloud:test': 'support failed' },
    })
    const { api } = installApi()

    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText('No workflows yet')).toBeInTheDocument()
    expect(screen.getByText('support failed')).toBeInTheDocument()
    expect(api.workflows?.list).not.toHaveBeenCalled()
    expect(api.workflows?.runNow).not.toHaveBeenCalled()
  })

  it('copies webhook invocation without putting the secret in the URL', async () => {
    installApi()
    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText('Inbox summary')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Copy curl' }))

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Authorization: Bearer secret'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('/workflows/workflow-1'))
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(expect.stringContaining('/workflows/workflow-1/secret'))
  })
})
