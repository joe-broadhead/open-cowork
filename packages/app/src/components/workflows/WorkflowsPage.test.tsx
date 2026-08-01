import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoworkAPI, EffectiveAppSettings, WorkflowListPayload, WorkflowRun } from '@open-cowork/shared'
import { WorkflowsPage } from './WorkflowsPage'
import { useSessionStore } from '../../stores/session'
import { WORKSPACE_SUPPORT_APIS, unavailableWorkspaceSupport, useWorkspaceSupportStore } from '../../stores/workspace-support'
import { recordFeatureValueActivation, recordFeatureValueDiscovery } from '../../helpers/feature-value-telemetry'
import { toast } from '../ui/Toaster'

vi.mock('../ui/Toaster', () => ({ toast: vi.fn() }))
vi.mock('../../helpers/feature-value-telemetry', () => ({
  recordFeatureValueActivation: vi.fn(),
  recordFeatureValueDiscovery: vi.fn(),
}))

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
        { id: 'webhook', type: 'webhook', enabled: true },
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
      pause: vi.fn(async () => ({ ...workflowPayload.workflows[0]!, status: 'paused' as const, runs: [] })),
      resume: vi.fn(async () => ({ ...workflowPayload.workflows[0]!, status: 'active' as const, runs: [] })),
      archive: vi.fn(async () => ({ ...workflowPayload.workflows[0]!, status: 'archived' as const, runs: [] })),
      regenerateWebhookSecret: vi.fn(async () => ({
        workflow: {
          ...workflowPayload.workflows[0]!,
          runs: [],
        },
        webhookSecretReveal: {
          workflowId: workflowPayload.workflows[0]!.id,
          triggerId: 'webhook',
          secret: 'rotated-secret',
        },
      })),
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

function activateCloudWorkspace(workspaceId = 'cloud:test') {
  useSessionStore.setState({ activeWorkspaceId: workspaceId })
  useWorkspaceSupportStore.setState({
    supportByWorkspace: {
      [workspaceId]: WORKSPACE_SUPPORT_APIS.map((api) => ({
        api,
        status: api === 'workflows.list' || api === 'workflows.run' ? 'supported' : 'not_supported',
        verdict: {
          allowed: api === 'workflows.list' || api === 'workflows.run',
          reason: api.startsWith('workflows') ? null : 'Blocked by cloud policy.',
        },
      })),
    },
    loadedByWorkspace: { [workspaceId]: true },
    loadingByWorkspace: {},
    errorByWorkspace: {},
  })
}

describe('WorkflowsPage', () => {
  beforeEach(() => {
    vi.mocked(recordFeatureValueActivation).mockClear()
    vi.mocked(recordFeatureValueDiscovery).mockClear()
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
    expect(recordFeatureValueDiscovery).toHaveBeenCalledWith('playbooks')
    expect(screen.getAllByRole('heading', { name: 'Playbooks' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Add playbook' })).toHaveLength(1)
    expect(screen.queryByRole('button', { name: /Active \(/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Archived \(/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add playbook' }))

    expect(api.workflows?.startDraft).toHaveBeenCalledTimes(1)
    expect(api.workflows?.startDraft).toHaveBeenCalledWith()
    await waitFor(() => expect(onOpenThread).toHaveBeenCalledWith('ses_new'))
    expect(recordFeatureValueActivation).toHaveBeenCalledWith('playbooks')
  })

  it('blocks workflow setup when using machine OpenCode config', async () => {
    const { api } = installApi(payload({ workflows: [] }), 'machine')
    const onOpenThread = vi.fn()
    render(<WorkflowsPage onOpenThread={onOpenThread} />)

    await screen.findByText('No playbooks yet')
    const buttons = await screen.findAllByRole('button', { name: 'Add playbook' })
    expect(buttons).toHaveLength(1)
    await waitFor(() => expect(buttons[0]).toBeDisabled())

    expect(api.workflows?.startDraft).not.toHaveBeenCalled()
    expect(onOpenThread).not.toHaveBeenCalled()
    expect(recordFeatureValueActivation).not.toHaveBeenCalled()
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
    expect(recordFeatureValueActivation).toHaveBeenCalledWith('playbooks')
  })

  it('does not track a failed playbook run as an activation', async () => {
    const { api } = installApi()
    const secret = 'action-secret-must-not-render'
    vi.mocked(api.workflows!.runNow).mockRejectedValueOnce(
      new Error(`run unavailable; Authorization: Bearer ${secret}`),
    )
    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    await screen.findByText('Inbox summary')
    await userEvent.click(screen.getByRole('button', { name: 'Run' }))

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      tone: 'error',
      message: expect.stringMatching(/run unavailable.*redacted/i),
    }))
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(secret)
    expect(recordFeatureValueActivation).not.toHaveBeenCalled()
  })

  it('does not claim or track a playbook run when creation returns null', async () => {
    const { api } = installApi()
    const onOpenThread = vi.fn()
    vi.mocked(api.workflows!.runNow).mockResolvedValueOnce(null)
    render(<WorkflowsPage onOpenThread={onOpenThread} />)

    await screen.findByText('Inbox summary')
    await userEvent.click(screen.getByRole('button', { name: 'Run' }))

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      tone: 'error',
      message: 'The playbook change could not be confirmed. Reload and try again.',
    }))
    expect(toast).not.toHaveBeenCalledWith({ tone: 'success', message: 'Playbook run started.' })
    expect(recordFeatureValueActivation).not.toHaveBeenCalled()
    expect(onOpenThread).not.toHaveBeenCalled()
  })

  it('shows a recoverable error instead of an empty state when workflow loading fails', async () => {
    const { api } = installApi()
    const secret = 'load-secret-must-not-render'
    vi.mocked(api.workflows!.list).mockRejectedValueOnce(
      new Error(`workflow store unavailable; Authorization: Bearer ${secret}`),
    )

    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText('Couldn’t load playbooks')).toBeInTheDocument()
    expect(screen.getByText(/workflow store unavailable.*redacted/i)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(secret)
    expect(screen.queryByText('No playbooks yet')).not.toBeInTheDocument()
  })

  it('redacts a failed latest-run summary before rendering it', async () => {
    const secret = 'latest-secret-must-not-render'
    installApi(payload({
      workflows: [{
        ...payload().workflows[0]!,
        latestRunStatus: 'failed',
        latestRunSummary: `command failed; Authorization: Bearer ${secret}`,
      }],
    }))

    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText(/command failed.*redacted/i)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(secret)
  })

  it('redacts secret-bearing playbook commands and step copy before rendering them', async () => {
    const secret = 'workflow-secret-sentinel'
    installApi(payload({
      workflows: [{
        ...payload().workflows[0]!,
        title: `Inbox summary Authorization: Bearer ${secret}`,
        instructions: `Run curl with Authorization: Bearer ${secret}`,
        steps: [{
          id: 'step-secret',
          title: `Call endpoint Authorization: Bearer ${secret}`,
          detail: `Retry with Authorization: Bearer ${secret}`,
        }],
      }],
    }))

    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    expect(await screen.findByRole('heading', { name: /Inbox summary.*redacted/i })).toBeInTheDocument()
    expect(screen.getByText(/Run curl with.*redacted/i)).toBeInTheDocument()
    expect(screen.getByText(/Call endpoint.*redacted/i)).toBeInTheDocument()
    expect(screen.getByText(/Retry with.*redacted/i)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(secret)
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

  it('redacts a targeted run failure before rendering it', async () => {
    const secret = 'target-secret-must-not-render'
    installApi(payload({
      runs: [workflowRun({
        status: 'failed',
        summary: null,
        error: `command failed; Authorization: Bearer ${secret}`,
      })],
    }))

    render(
      <WorkflowsPage
        onOpenThread={vi.fn()}
        initialTarget={{ workflowId: 'workflow-1', runId: 'run-1' }}
      />,
    )

    expect(await screen.findByText(/command failed.*redacted/i)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(secret)
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
      triggers: [{ id: 'manual', type: 'manual' as const, enabled: true }],
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

  it('does not claim an archived playbook was restored when resume returns null', async () => {
    const archivedWorkflow = {
      ...payload().workflows[0]!,
      id: 'workflow-archived',
      title: 'Archived inbox summary',
      status: 'archived' as const,
      webhookUrl: null,
      triggers: [{ id: 'manual', type: 'manual' as const, enabled: true }],
    }
    const { api } = installApi(payload({ workflows: [archivedWorkflow] }))
    vi.mocked(api.workflows!.resume).mockResolvedValueOnce(null)

    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Archived (1)' }))
    const archivedCard = (await screen.findByRole('heading', { name: 'Archived inbox summary' }))
      .closest('[data-workflow-id="workflow-archived"]')
    expect(archivedCard).not.toBeNull()
    await userEvent.click(within(archivedCard as HTMLElement).getByRole('button', { name: 'Restore' }))

    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      tone: 'error',
      message: 'The playbook change could not be confirmed. Reload and try again.',
    }))
    expect(toast).not.toHaveBeenCalledWith({ tone: 'success', message: 'Playbook restored.' })
  })

  it('creates, copies, and restores an archived local webhook playbook as one truthful transition', async () => {
    const archivedWorkflow = {
      ...payload().workflows[0]!,
      id: 'workflow-archived',
      title: 'Archived inbox summary',
      status: 'archived' as const,
      webhookUrl: 'http://127.0.0.1:47839/workflows/workflow-archived',
    }
    const archivedPayload = payload({ workflows: [archivedWorkflow] })
    const { api } = installApi(archivedPayload)
    vi.mocked(api.workflows!.list)
      .mockResolvedValueOnce(archivedPayload)
      .mockResolvedValue(payload({
        workflows: [{ ...archivedWorkflow, status: 'active' }],
      }))
    vi.mocked(api.workflows!.resume).mockRejectedValueOnce(
      new Error('Regenerate the workflow webhook secret before restoring this playbook.'),
    )

    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Archived (1)' }))
    const archivedHeading = await screen.findByRole('heading', { name: 'Archived inbox summary' })
    const archivedCard = archivedHeading.closest('[data-workflow-id="workflow-archived"]')
    expect(archivedCard).not.toBeNull()
    expect(within(archivedCard as HTMLElement).getByText(/Create and copy a replacement secret before restoring/i)).toBeInTheDocument()
    expect(within(archivedCard as HTMLElement).getByRole('button', { name: 'Create replacement' })).toBeInTheDocument()

    await userEvent.click(within(archivedCard as HTMLElement).getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith({
      tone: 'error',
      message: 'Regenerate the workflow webhook secret before restoring this playbook.',
    }))
    expect(api.workflows?.resume).toHaveBeenCalledWith('workflow-archived')
    expect(toast).not.toHaveBeenCalledWith({ tone: 'success', message: 'Playbook restored.' })

    await userEvent.click(within(archivedCard as HTMLElement).getByRole('button', { name: 'Create replacement' }))
    expect(screen.getByRole('heading', { name: 'Create a replacement webhook secret?' })).toBeInTheDocument()
    expect(screen.getByText(/copy the one-time curl command, and restore the playbook/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Create, copy, and restore' }))

    await waitFor(() => expect(api.workflows?.regenerateWebhookSecret).toHaveBeenCalledWith('workflow-archived'))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Authorization: Bearer rotated-secret'))
    await waitFor(() => expect(api.workflows?.resume).toHaveBeenCalledTimes(2))
    expect(toast).toHaveBeenCalledWith({ tone: 'success', message: 'Playbook restored.' })
    expect(await screen.findByText('No archived playbooks')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Archived inbox summary' })).not.toBeInTheDocument()
  })

  it('reports a copied credential truthfully and redacts a failed archived restore', async () => {
    const secret = 'fixture-secret'
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      const archivedWorkflow = {
        ...payload().workflows[0]!,
        id: 'workflow-archived',
        title: 'Archived inbox summary',
        status: 'archived' as const,
        webhookUrl: 'http://127.0.0.1:47839/workflows/workflow-archived',
      }
      const archivedPayload = payload({ workflows: [archivedWorkflow] })
      const { api } = installApi(archivedPayload)
      vi.mocked(api.workflows!.regenerateWebhookSecret).mockResolvedValueOnce({
        workflow: { ...archivedWorkflow, runs: [] },
        webhookSecretReveal: {
          workflowId: archivedWorkflow.id,
          triggerId: 'webhook',
          secret,
        },
      })
      vi.mocked(api.workflows!.resume).mockRejectedValueOnce(
        new Error(`restore failed after copying ${secret}`),
      )

      render(<WorkflowsPage onOpenThread={vi.fn()} />)

      await userEvent.click(await screen.findByRole('button', { name: 'Archived (1)' }))
      const archivedCard = (await screen.findByRole('heading', { name: 'Archived inbox summary' }))
        .closest('[data-workflow-id="workflow-archived"]')
      expect(archivedCard).not.toBeNull()
      await userEvent.click(within(archivedCard as HTMLElement).getByRole('button', { name: 'Create replacement' }))
      await userEvent.click(screen.getByRole('button', { name: 'Create, copy, and restore' }))

      await waitFor(() => expect(api.workflows?.regenerateWebhookSecret).toHaveBeenCalledWith('workflow-archived'))
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining(secret))
      await waitFor(() => expect(api.workflows?.resume).toHaveBeenCalledWith('workflow-archived'))
      await waitFor(() => expect(toast).toHaveBeenCalledWith({
        tone: 'error',
        message: expect.stringMatching(/new webhook credential was copied.*restore could not be confirmed/i),
      }))
      await waitFor(() => expect(api.workflows?.list).toHaveBeenCalledTimes(2))

      const toastCalls = JSON.stringify(vi.mocked(toast).mock.calls)
      expect(document.body.textContent).not.toContain(secret)
      expect(toastCalls).not.toContain(secret)
      expect(toastCalls).not.toContain('No credential was shown or retained')
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secret)
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secret)
      expect(JSON.stringify(logSpy.mock.calls)).not.toContain(secret)
      expect(screen.getByRole('heading', { name: 'Archived inbox summary' })).toBeInTheDocument()
    } finally {
      errorSpy.mockRestore()
      warnSpy.mockRestore()
      logSpy.mockRestore()
    }
  })

  it('uses cloud workflow APIs and rotates webhook credentials through the active workspace', async () => {
    activateCloudWorkspace()
    const cloudPayload = payload({
      workflows: [{
        ...payload().workflows[0]!,
        webhookUrl: 'https://cowork.example.test/webhooks/workflows/workflow-1',
      }],
    })
    const { api } = installApi(cloudPayload)
    const onOpenThread = vi.fn()

    render(<WorkflowsPage onOpenThread={onOpenThread} />)

    expect(await screen.findByText('Inbox summary')).toBeInTheDocument()
    expect(api.workflows?.list).toHaveBeenCalledWith({ workspaceId: 'cloud:test' })
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate secret' }))
    await waitFor(() => expect(api.workflows?.regenerateWebhookSecret).toHaveBeenCalledWith(
      'workflow-1',
      { workspaceId: 'cloud:test' },
    ))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining(
      "https://cowork.example.test/webhooks/workflows/workflow-1",
    ))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining(
      'x-open-cowork-signature: sha256=$signature',
    ))
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(expect.stringContaining(
      'Authorization: Bearer rotated-secret',
    ))

    await userEvent.click(screen.getByRole('button', { name: 'Run' }))

    expect(api.workflows?.runNow).toHaveBeenCalledWith('workflow-1', { workspaceId: 'cloud:test' })
    await waitFor(() => expect(onOpenThread).toHaveBeenCalledWith('ses_run'))
  })

  it('creates, copies, and restores archived cloud webhook playbooks through the active workspace', async () => {
    activateCloudWorkspace()
    const archivedWorkflow = {
      ...payload().workflows[0]!,
      id: 'workflow-archived',
      title: 'Archived cloud webhook',
      status: 'archived' as const,
      webhookUrl: 'https://cowork.example.test/webhooks/workflows/workflow-archived',
    }
    const archivedPayload = payload({ workflows: [archivedWorkflow] })
    const { api } = installApi(archivedPayload)
    vi.mocked(api.workflows!.list)
      .mockResolvedValueOnce(archivedPayload)
      .mockResolvedValue(payload({
        workflows: [{ ...archivedWorkflow, status: 'active' }],
      }))

    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    await userEvent.click(await screen.findByRole('button', { name: 'Archived (1)' }))
    const archivedCard = (await screen.findByRole('heading', { name: 'Archived cloud webhook' }))
      .closest('[data-workflow-id="workflow-archived"]')
    expect(archivedCard).not.toBeNull()
    expect(within(archivedCard as HTMLElement).getByText(/Create and copy a replacement secret before restoring/i)).toBeInTheDocument()

    await userEvent.click(within(archivedCard as HTMLElement).getByRole('button', { name: 'Create replacement' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create, copy, and restore' }))

    await waitFor(() => expect(api.workflows?.regenerateWebhookSecret).toHaveBeenCalledWith(
      'workflow-archived',
      { workspaceId: 'cloud:test' },
    ))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining(
      "https://cowork.example.test/webhooks/workflows/workflow-archived",
    ))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining(
      'x-open-cowork-timestamp: $timestamp',
    ))

    await waitFor(() => expect(api.workflows?.resume).toHaveBeenCalledWith(
      'workflow-archived',
      { workspaceId: 'cloud:test' },
    ))
    expect(await screen.findByText('No archived playbooks')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Archived cloud webhook' })).not.toBeInTheDocument()
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
    expect(recordFeatureValueDiscovery).not.toHaveBeenCalledWith('playbooks')
  })

  it('copies only the redacted webhook URL from ordinary workflow details', async () => {
    installApi()
    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText('Inbox summary')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Copy URL' }))

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('http://127.0.0.1:47839/workflows/workflow-1')
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
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('Authorization: Bearer rotated-secret'))
  })

  it('does not render or retain a rotated secret when clipboard access fails', async () => {
    const secret = 'rotated-secret'
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error(`clipboard denied: ${secret}`))
    installApi()
    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText('Inbox summary')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate secret' }))

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      tone: 'error',
      message: expect.stringMatching(/clipboard access failed/i),
    })))
    expect(document.body.textContent).not.toContain(secret)
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(secret)
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secret)
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(secret)
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('does not echo secret-bearing reveal errors into DOM, toasts, logs, or clipboard', async () => {
    const secretCommand = 'curl -H "Authorization: Bearer never-render-this"'
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { api } = installApi()
    vi.mocked(api.workflows!.regenerateWebhookSecret).mockRejectedValueOnce(new Error(secretCommand))
    render(<WorkflowsPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText('Inbox summary')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate' }))
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate secret' }))

    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      tone: 'error',
      message: expect.stringMatching(/No credential was shown or retained/i),
    })))
    expect(document.body.textContent).not.toContain(secretCommand)
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(secretCommand)
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(secretCommand)
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secretCommand)
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(secretCommand)
    expect(navigator.clipboard.writeText).not.toHaveBeenCalledWith(expect.stringContaining('never-render-this'))
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })
})
