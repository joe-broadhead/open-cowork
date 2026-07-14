import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoworkAPI, EffectiveAppSettings, WorkflowListPayload, WorkflowRun } from '@open-cowork/shared'
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
      steps: [{ id: 'step-1', title: 'Scan inbox', detail: 'Collect unread messages and summarize workload.' }],
    }],
    runs: [],
    ...overrides,
  }
}

function workflowRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    workflowId: 'workflow-1',
    sessionId: 'ses_run_exact',
    triggerType: 'manual',
    triggerPayload: null,
    status: 'completed',
    title: 'Run Inbox summary',
    summary: 'Processed the exact targeted run.',
    error: null,
    createdAt: '2026-05-14T08:00:00.000Z',
    startedAt: '2026-05-14T08:00:00.000Z',
    finishedAt: '2026-05-14T08:01:00.000Z',
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

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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

    await screen.findByText('No playbooks yet')
    await userEvent.click(screen.getAllByRole('button', { name: 'Add playbook' })[0]!)

    expect(api.workflows?.startDraft).toHaveBeenCalledTimes(1)
    expect(api.workflows?.startDraft).toHaveBeenCalledWith()
    await waitFor(() => expect(onOpenThread).toHaveBeenCalledWith('ses_new'))
  })

  it('blocks workflow setup when using machine OpenCode config', async () => {
    const { api } = installApi(payload({ workflows: [] }), 'machine')
    const onOpenThread = vi.fn()
    render(<WorkflowsPage onOpenThread={onOpenThread} />)

    await screen.findByText('No playbooks yet')
    const buttons = await screen.findAllByRole('button', { name: 'Add playbook' })
    await waitFor(() => expect(buttons[0]).toBeDisabled())

    expect(api.workflows?.startDraft).not.toHaveBeenCalled()
    expect(onOpenThread).not.toHaveBeenCalled()
    expect(screen.getAllByText(/requires the in-app OpenCode config source/i).length).toBeGreaterThan(0)
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

  it('shows a recoverable error instead of an empty state when workflow loading fails', async () => {
    const { api } = installApi()
    vi.mocked(api.workflows!.list).mockRejectedValueOnce(new Error('workflow store unavailable'))

    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText('Couldn’t load playbooks')).toBeInTheDocument()
    expect(screen.getByText('workflow store unavailable')).toBeInTheDocument()
    expect(screen.queryByText('No playbooks yet')).not.toBeInTheDocument()
  })

  it('keeps stale playbooks visible when a refresh fails', async () => {
    const { api, triggerWorkflowUpdated } = installApi()

    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText('Inbox summary')).toBeInTheDocument()
    vi.mocked(api.workflows!.list).mockRejectedValueOnce(new Error('refresh failed'))
    triggerWorkflowUpdated()

    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t refresh playbooks.')
    expect(screen.getByText('Inbox summary')).toBeInTheDocument()
  })

  it('does not let workflow refreshes cancel an in-flight settings load', async () => {
    const settingsRequest = createDeferred<EffectiveAppSettings>()
    const { api, triggerWorkflowUpdated } = installApi(payload({ workflows: [] }))
    vi.mocked(api.settings.get).mockImplementation(() => settingsRequest.promise)

    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText('No playbooks yet')).toBeInTheDocument()
    triggerWorkflowUpdated()
    await waitFor(() => expect(api.workflows?.list).toHaveBeenCalledTimes(2))

    settingsRequest.resolve({ runtimeConfigSource: 'machine' } as EffectiveAppSettings)
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Add playbook' })[0]).toBeDisabled())
  })

  it('highlights exact workflow-run targets and opens the exact run session', async () => {
    const exactRun = workflowRun()
    const workflowPayload = payload({
      workflows: [{
        ...payload().workflows[0]!,
        latestRunId: 'run-latest',
        latestRunStatus: 'running',
        latestRunSessionId: 'ses_run_latest',
        latestRunSummary: 'A different, newer run.',
      }],
      runs: [exactRun],
    })
    installApi(workflowPayload)
    const onOpenThread = vi.fn()
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined)
    const requestAnimationFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    const cancelAnimationFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    const onInitialTargetHandled = vi.fn()

    render(
      <WorkflowsPage
        onOpenThread={onOpenThread}
        initialTarget={{ workflowId: 'workflow-1', runId: 'run-1' }}
        onInitialTargetHandled={onInitialTargetHandled}
      />,
    )

    expect(await screen.findByText('Opened run run-1')).toBeInTheDocument()
    expect(screen.getByText('Processed the exact targeted run.')).toBeInTheDocument()
    expect(screen.getByLabelText('Targeted run run-1')).toHaveTextContent('completed')
    expect(screen.queryByRole('button', { name: 'Open latest run' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open this run' }))
    expect(onOpenThread).toHaveBeenCalledWith('ses_run_exact')
    expect(onOpenThread).not.toHaveBeenCalledWith('ses_run_latest')
    expect(screen.getByText('Inbox summary').closest('[data-workflow-id="workflow-1"]')).toHaveAttribute('data-open-cowork-target', 'true')
    expect(screen.getByText('Inbox summary').closest('[data-workflow-id="workflow-1"]')).toHaveAttribute('data-workflow-run-id', 'run-1')
    expect(onInitialTargetHandled).toHaveBeenCalledTimes(1)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' })

    scrollIntoView.mockRestore()
    requestAnimationFrame.mockRestore()
    cancelAnimationFrame.mockRestore()
  })

  it('uses a supplied exact run when the list payload does not include it', async () => {
    const exactRun = workflowRun({ id: 'run-from-link', sessionId: 'ses_from_link', summary: 'Resolved before opening the page.' })
    const onOpenThread = vi.fn()
    installApi()

    render(
      <WorkflowsPage
        onOpenThread={onOpenThread}
        initialTarget={{ workflowId: 'workflow-1', runId: exactRun.id, run: exactRun }}
      />,
    )

    expect(await screen.findByText('Resolved before opening the page.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open this run' }))
    expect(onOpenThread).toHaveBeenCalledWith('ses_from_link')
  })

  it('does not fall back to the latest or a similarly named run for an exact run target', async () => {
    installApi(payload({
      workflows: [{
        ...payload().workflows[0]!,
        latestRunId: 'run-10',
        latestRunStatus: 'completed',
        latestRunSessionId: 'ses_run_latest',
      }],
      runs: [workflowRun({ id: 'run-10', sessionId: 'ses_run_similar' })],
    }))

    render(
      <WorkflowsPage
        onOpenThread={vi.fn()}
        initialTarget={{ workflowId: 'workflow-1', runId: 'run-1' }}
      />,
    )

    expect(await screen.findByText('Run run-1 is not available in the current playbook data.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open this run' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open latest run' })).not.toBeInTheDocument()
  })

  it('shows archived playbooks separately and restores them with resume', async () => {
    const archivedWorkflow = {
      ...payload().workflows[0]!,
      id: 'workflow-archived',
      title: 'Archived inbox summary',
      status: 'archived' as const,
      webhookUrl: null,
    }
    const { api } = installApi(payload({
      workflows: [payload().workflows[0]!, archivedWorkflow],
    }))

    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText('Inbox summary')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Archived (1)' }))

    const archivedHeading = await screen.findByRole('heading', { name: 'Archived inbox summary' })
    const archivedCard = archivedHeading.closest('[data-workflow-id="workflow-archived"]')
    expect(archivedCard).not.toBeNull()
    expect(screen.queryByRole('heading', { name: 'Inbox summary' })).not.toBeInTheDocument()
    expect(within(archivedCard as HTMLElement).getByRole('button', { name: 'Restore' })).toBeInTheDocument()
    expect(within(archivedCard as HTMLElement).queryByRole('button', { name: 'Run' })).not.toBeInTheDocument()
    expect(within(archivedCard as HTMLElement).queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument()
    expect(within(archivedCard as HTMLElement).queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()

    await userEvent.click(within(archivedCard as HTMLElement).getByRole('button', { name: 'Restore' }))
    expect(api.workflows?.resume).toHaveBeenCalledWith('workflow-archived')
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

  it('ignores stale workflow list refreshes from a previous workspace', async () => {
    const firstWorkspaceList = createDeferred<WorkflowListPayload>()
    const secondWorkspaceList = createDeferred<WorkflowListPayload>()
    useSessionStore.setState({ activeWorkspaceId: 'cloud:first' })
    useWorkspaceSupportStore.setState({
      supportByWorkspace: {
        'cloud:first': WORKSPACE_SUPPORT_APIS.map((api) => ({
          api,
          status: api === 'workflows.list' || api === 'workflows.run' ? 'supported' : 'not_supported',
          verdict: {
            allowed: api === 'workflows.list' || api === 'workflows.run',
            reason: api.startsWith('workflows') ? null : 'Blocked by cloud policy.',
          },
        })),
        'cloud:second': WORKSPACE_SUPPORT_APIS.map((api) => ({
          api,
          status: api === 'workflows.list' || api === 'workflows.run' ? 'supported' : 'not_supported',
          verdict: {
            allowed: api === 'workflows.list' || api === 'workflows.run',
            reason: api.startsWith('workflows') ? null : 'Blocked by cloud policy.',
          },
        })),
      },
      loadedByWorkspace: {
        'cloud:first': true,
        'cloud:second': true,
      },
      loadingByWorkspace: {},
      errorByWorkspace: {},
    })
    const { api } = installApi(payload({ workflows: [] }))
    vi.mocked(api.workflows!.list)
      .mockImplementation((options?: { workspaceId?: string }) => {
        if (options?.workspaceId === 'cloud:first') return firstWorkspaceList.promise
        if (options?.workspaceId === 'cloud:second') return secondWorkspaceList.promise
        return Promise.resolve(payload({ workflows: [] }))
      })

    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    await waitFor(() => {
      expect(api.workflows?.list).toHaveBeenCalledWith({ workspaceId: 'cloud:first' })
    })

    useSessionStore.setState({ activeWorkspaceId: 'cloud:second' })
    await waitFor(() => {
      expect(api.workflows?.list).toHaveBeenCalledWith({ workspaceId: 'cloud:second' })
    })

    secondWorkspaceList.resolve(payload({
      workflows: [{
        ...payload().workflows[0]!,
        id: 'workflow-second',
        title: 'Second workspace workflow',
      }],
    }))
    expect(await screen.findByText('Second workspace workflow')).toBeInTheDocument()

    firstWorkspaceList.resolve(payload({
      workflows: [{
        ...payload().workflows[0]!,
        id: 'workflow-first',
        title: 'First workspace workflow',
      }],
    }))

    await waitFor(() => {
      expect(screen.getByText('Second workspace workflow')).toBeInTheDocument()
      expect(screen.queryByText('First workspace workflow')).not.toBeInTheDocument()
    })
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

    expect(await screen.findByText('No playbooks yet')).toBeInTheDocument()
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

  it('confirms webhook secret regeneration and warns that existing callers stop working', async () => {
    const { api } = installApi()
    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText('Inbox summary')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }))

    expect(api.workflows?.regenerateWebhookSecret).not.toHaveBeenCalled()
    expect(screen.getByRole('heading', { name: 'Regenerate this webhook secret?' })).toBeInTheDocument()
    expect(screen.getByText(/Existing callers will stop working until they use the new secret/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Regenerate secret' }))
    await waitFor(() => expect(api.workflows?.regenerateWebhookSecret).toHaveBeenCalledWith('workflow-1'))
  })
})
