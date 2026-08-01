import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  workspaceApiSupportContextForAuthority,
  type CoordinationBoardPayload,
  type CoordinationProjectInput,
  type WorkspaceApiSupport,
  type WorkspaceExecutionAuthority,
} from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { recordFeatureValueActivation, recordFeatureValueDiscovery } from '../../helpers/feature-value-telemetry'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { useWorkspaceSupportStore } from '../../stores/workspace-support'
import { ProjectsBoardPage } from './ProjectsBoardPage'

vi.mock('../../helpers/feature-value-telemetry', () => ({
  recordFeatureValueActivation: vi.fn(),
  recordFeatureValueDiscovery: vi.fn(),
}))

const board: CoordinationBoardPayload = {
  projects: [{
    id: 'project-1',
    kind: 'project',
    workspaceId: 'local',
    ownerAuthority: 'desktop_local',
    executionAuthority: 'desktop_local',
    stateOwner: 'desktop_local_store',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    title: 'Desktop parity launch',
    objective: 'Make the Projects route a real board instead of a thread table.',
    description: null,
    status: 'active',
    team: ['chief-of-staff', 'build'],
    sourceSessionId: 'session-project',
  }],
  tasks: [{
    id: 'task-1',
    kind: 'task',
    workspaceId: 'local',
    ownerAuthority: 'desktop_local',
    executionAuthority: 'desktop_local',
    stateOwner: 'desktop_local_store',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    projectId: 'project-1',
    parentTaskId: null,
    title: 'Wire desktop Projects board',
    spec: 'Render project cards, a five-column board, and a task drawer.',
    description: 'Replace the thread table route.',
    status: 'running',
    column: 'doing',
    priority: 'high',
    assigneeAgent: 'build',
    assignedRunId: null,
    assignedSessionId: 'session-work',
    artifactRefs: [],
  }],
}

const localSupport = useWorkspaceSupportStore.getState().supportByWorkspace[LOCAL_WORKSPACE_ID] || []

function setRemoteWorkspace(workspaceId: string, authority: WorkspaceExecutionAuthority) {
  const support: WorkspaceApiSupport[] = ['coordination.projects', 'coordination.tasks'].map((api) => ({
    api,
    status: 'supported',
    verdict: { allowed: true, reason: null },
    context: workspaceApiSupportContextForAuthority(authority),
  }))
  useSessionStore.setState({ activeWorkspaceId: workspaceId })
  useWorkspaceSupportStore.setState({
    supportByWorkspace: { [LOCAL_WORKSPACE_ID]: localSupport, [workspaceId]: support },
    loadedByWorkspace: { [LOCAL_WORKSPACE_ID]: true, [workspaceId]: true },
    loadingByWorkspace: {},
    errorByWorkspace: {},
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

describe('ProjectsBoardPage', () => {
  beforeEach(() => {
    Object.defineProperty(window, '__coworkBrowserRuntime', { configurable: true, value: undefined })
    vi.mocked(recordFeatureValueActivation).mockClear()
    vi.mocked(recordFeatureValueDiscovery).mockClear()
    useSessionStore.setState({ activeWorkspaceId: LOCAL_WORKSPACE_ID })
    useWorkspaceSupportStore.setState({
      supportByWorkspace: { [LOCAL_WORKSPACE_ID]: localSupport },
      loadedByWorkspace: { [LOCAL_WORKSPACE_ID]: true },
      loadingByWorkspace: {},
      errorByWorkspace: {},
    })
  })

  it('renders the coordination board and persists board actions through desktop IPC', async () => {
    const onOpenThread = vi.fn()
    const moveTask = vi.fn(async () => ({ ...board.tasks[0]!, column: 'done' as const }))
    const assignTask = vi.fn(async () => ({ ...board.tasks[0]!, assigneeAgent: 'chief-of-staff' }))
    const taskWorkTarget = vi.fn(async () => ({ id: 'session-work', title: 'Work session' }))
    // Seed the assignee/hand-off menus with the full coworker roster, including a
    // coworker (analyst-pro) absent from the board, mirroring the cloud app.
    const listAgents = vi.fn(async () => [{ name: 'analyst-pro' }])
    installRendererTestCoworkApi({
      coordination: {
        board: vi.fn(async () => board),
        moveTask,
        assignTask,
        taskWorkTarget,
      },
      agents: {
        list: listAgents,
      },
    })

    render(<ProjectsBoardPage onOpenThread={onOpenThread} />)

    await screen.findByRole('heading', { name: 'Projects' })
    expect(screen.getAllByText('Desktop parity launch')).not.toHaveLength(0)
    expect(screen.getAllByText('In progress')).not.toHaveLength(0)
    const taskButton = screen.getAllByRole('button')
      .find((button) => button.className.includes('studio-kanban-task-button'))
    expect(taskButton).toHaveTextContent('Wire desktop Projects board')
    expect(taskButton).toHaveTextContent('Running now')
    expect(within(taskButton as HTMLElement).queryByText('running', { exact: true })).not.toBeInTheDocument()

    fireEvent.click(taskButton as HTMLElement)
    const drawer = await screen.findByRole('dialog', { name: 'Task detail' })
    expect(within(drawer).getAllByText('Running now').length).toBeGreaterThan(0)
    expect(within(drawer).queryByText('running', { exact: true })).not.toBeInTheDocument()
    expect(within(drawer).getByText('Linked chat')).toBeInTheDocument()
    expect(within(drawer).queryByText('session-work')).not.toBeInTheDocument()
    const stageGroup = screen.getByRole('group', { name: /task stage/i })
    fireEvent.click(within(stageGroup).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(moveTask).toHaveBeenCalledWith('task-1', { column: 'done' }))
    expect(recordFeatureValueActivation).toHaveBeenLastCalledWith('projects')

    await waitFor(() => expect(listAgents).toHaveBeenCalled())
    expect(screen.getAllByLabelText(/Team: Cleo, Build/).length).toBeGreaterThan(0)
    expect(screen.queryByText('Chief Of Staff')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Coworker' }))
    // The roster coworker that is not on the board still appears in the menu.
    expect(screen.getByRole('menuitem', { name: 'Analyst Pro' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cleo' }))
    await waitFor(() => expect(assignTask).toHaveBeenCalledWith('task-1', { assigneeAgent: 'chief-of-staff' }))
    expect(recordFeatureValueActivation).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: 'Open the work' }))
    await waitFor(() => expect(taskWorkTarget).toHaveBeenCalledWith('task-1'))
    expect(onOpenThread).toHaveBeenCalledWith('session-work')
    expect(recordFeatureValueActivation).toHaveBeenCalledTimes(2)
  })

  it('supports the core task-card to detail to stage-change journey by keyboard', async () => {
    const user = userEvent.setup()
    const moveTask = vi.fn(async () => ({ ...board.tasks[0]!, column: 'done' as const }))
    installRendererTestCoworkApi({
      coordination: {
        board: vi.fn(async () => board),
        moveTask,
      },
      agents: { list: vi.fn(async () => []) },
    })

    render(<ProjectsBoardPage onOpenThread={vi.fn()} />)

    await screen.findByRole('heading', { name: 'Projects' })
    const taskButton = screen.getAllByRole('button')
      .find((button) => button.className.includes('studio-kanban-task-button'))
    expect(taskButton).toBeDefined()
    taskButton?.focus()
    expect(taskButton).toHaveFocus()
    await user.keyboard('{Enter}')

    const drawer = await screen.findByRole('dialog', { name: 'Task detail' })
    expect(within(drawer).getByRole('heading', { name: 'Wire desktop Projects board' })).toBeInTheDocument()
    const done = within(drawer).getByRole('button', { name: 'Done' })
    done.focus()
    expect(done).toHaveFocus()
    await user.keyboard(' ')

    await waitFor(() => expect(moveTask).toHaveBeenCalledWith('task-1', { column: 'done' }))
    expect(recordFeatureValueActivation).toHaveBeenCalledWith('projects')
  })

  it('persists a task move when a card is dragged between board columns', async () => {
    const moveTask = vi.fn(async () => ({ ...board.tasks[0]!, column: 'done' as const }))
    installRendererTestCoworkApi({
      coordination: {
        board: vi.fn(async () => board),
        moveTask,
      },
      agents: { list: vi.fn(async () => []) },
    })

    const { container } = render(<ProjectsBoardPage onOpenThread={vi.fn()} />)

    await screen.findByRole('heading', { name: 'Projects' })
    const taskButton = container.querySelector<HTMLElement>('.studio-kanban-task-button')
    const doneColumn = container.querySelector<HTMLElement>('.studio-kanban-column[data-column="done"]')
    expect(taskButton).not.toBeNull()
    expect(doneColumn).not.toBeNull()
    const dataTransfer = {
      effectAllowed: 'none',
      dropEffect: 'none',
      setData: vi.fn(),
      getData: vi.fn(() => 'task-1'),
    }

    fireEvent.dragStart(taskButton as HTMLElement, { dataTransfer })
    expect(dataTransfer.effectAllowed).toBe('move')
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'task-1')
    fireEvent.dragOver(doneColumn as HTMLElement, { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('move')
    fireEvent.drop(doneColumn as HTMLElement, { dataTransfer })

    await waitFor(() => expect(moveTask).toHaveBeenCalledWith('task-1', { column: 'done' }))
    expect(recordFeatureValueActivation).toHaveBeenCalledWith('projects')
  })

  it('has one create path, uses the Team roster without a fabricated default, and hides runtime IDs', async () => {
    const emptyBoard: CoordinationBoardPayload = { projects: [], tasks: [] }
    const createProject = vi.fn(async (input: CoordinationProjectInput) => ({
      ...board.projects[0]!,
      id: 'project-created',
      title: input.title,
      objective: input.objective,
      team: input.team || [],
    }))
    installRendererTestCoworkApi({
      coordination: {
        board: vi.fn(async () => emptyBoard),
        createProject,
      },
      agents: {
        list: vi.fn(async () => [{
          name: 'analyst-pro',
          enabled: true,
          valid: true,
        }]),
      },
    })

    render(<ProjectsBoardPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText('No projects yet')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'New project' })).toHaveLength(1)
    expect(screen.queryByText(/desktop_local|local ·/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    expect(screen.queryByDisplayValue('cleo')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: 'Analyst Pro' }))
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'Quarterly review' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() => expect(createProject).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Quarterly review',
      objective: 'Quarterly review',
      team: ['analyst-pro'],
    })))
    expect(recordFeatureValueActivation).toHaveBeenCalledWith('projects')
  })

  it('distinguishes a loading coworker roster from a genuinely empty roster', async () => {
    const customAgents = deferred<Array<{ name: string }>>()
    const builtInAgents = deferred<Array<{ name: string }>>()
    const runtimeAgents = deferred<Array<{ name: string }>>()
    installRendererTestCoworkApi({
      coordination: { board: vi.fn(async () => ({ projects: [], tasks: [] })) },
      agents: {
        list: vi.fn(() => customAgents.promise),
        runtime: vi.fn(() => runtimeAgents.promise),
      },
      app: { builtinAgents: vi.fn(() => builtInAgents.promise) },
    })

    render(<ProjectsBoardPage onOpenThread={vi.fn()} />)

    await screen.findByText('No projects yet')
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    expect(screen.getByText('Loading coworkers…')).toBeInTheDocument()
    expect(screen.queryByText(/No coworkers are available/)).not.toBeInTheDocument()

    await act(async () => {
      customAgents.resolve([{ name: 'analyst-pro' }])
      builtInAgents.resolve([])
      runtimeAgents.resolve([])
      await Promise.resolve()
    })
    expect(await screen.findByRole('button', { name: 'Analyst Pro' })).toBeInTheDocument()
  })

  it('shows truthful total and partial coworker roster failures', async () => {
    const listAgents = vi.fn(async () => { throw new Error('custom roster unavailable') })
    const listBuiltIns = vi.fn(async () => { throw new Error('built-in roster unavailable') })
    const listRuntime = vi.fn(async () => { throw new Error('runtime roster unavailable') })
    installRendererTestCoworkApi({
      coordination: { board: vi.fn(async () => ({ projects: [], tasks: [] })) },
      agents: { list: listAgents, runtime: listRuntime },
      app: { builtinAgents: listBuiltIns },
    })

    const { unmount } = render(<ProjectsBoardPage onOpenThread={vi.fn()} />)
    await screen.findByText('No projects yet')
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    expect(await screen.findByText('Couldn’t load coworkers. Retry the roster before assigning a team.')).toBeInTheDocument()
    expect(screen.queryByText(/No coworkers are available/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry coworkers' }))
    await waitFor(() => expect(listAgents).toHaveBeenCalledTimes(2))
    unmount()

    installRendererTestCoworkApi({
      coordination: { board: vi.fn(async () => ({ projects: [], tasks: [] })) },
      agents: {
        list: vi.fn(async () => [{ name: 'analyst-pro' }]),
        runtime: vi.fn(async () => { throw new Error('runtime roster unavailable') }),
      },
      app: { builtinAgents: vi.fn(async () => { throw new Error('built-in roster unavailable') }) },
    })
    render(<ProjectsBoardPage onOpenThread={vi.fn()} />)
    await screen.findByText('No projects yet')
    fireEvent.click(screen.getByRole('button', { name: 'New project' }))
    expect(await screen.findByText('Some coworkers could not be loaded. Available coworkers are still shown.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Analyst Pro' })).toBeInTheDocument()
  })

  it('renders explicit board loading and total-error states', async () => {
    const boardRequest = deferred<CoordinationBoardPayload>()
    installRendererTestCoworkApi({
      coordination: { board: vi.fn(() => boardRequest.promise) },
      agents: { list: vi.fn(async () => []), runtime: vi.fn(async () => []) },
      app: { builtinAgents: vi.fn(async () => []) },
    })
    const { unmount } = render(<ProjectsBoardPage onOpenThread={vi.fn()} />)
    expect(await screen.findByText('Loading projects')).toBeInTheDocument()
    await act(async () => boardRequest.resolve({ projects: [], tasks: [] }))
    expect(await screen.findByText('No projects yet')).toBeInTheDocument()
    unmount()

    installRendererTestCoworkApi({
      coordination: { board: vi.fn(async () => { throw new Error('board unavailable') }) },
      agents: { list: vi.fn(async () => []), runtime: vi.fn(async () => []) },
      app: { builtinAgents: vi.fn(async () => []) },
    })
    render(<ProjectsBoardPage onOpenThread={vi.fn()} />)
    expect(await screen.findByText('Couldn’t load projects')).toBeInTheDocument()
    expect(screen.getByText('board unavailable')).toBeInTheDocument()
  })

  it('keeps archived projects available as a separate coherent state', async () => {
    installRendererTestCoworkApi({
      coordination: {
        board: vi.fn(async () => ({
          projects: [
            ...board.projects,
            { ...board.projects[0]!, id: 'project-archived', title: 'Previous launch', status: 'archived' as const },
          ],
          tasks: board.tasks,
        })),
      },
      agents: { list: vi.fn(async () => []) },
    })

    render(<ProjectsBoardPage onOpenThread={vi.fn()} />)

    expect((await screen.findAllByText('Desktop parity launch')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Previous launch')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Archived (1)' }))
    expect((await screen.findAllByText('Previous launch')).length).toBeGreaterThan(0)
    expect(screen.queryAllByText('Desktop parity launch')).toHaveLength(0)
    expect(screen.getAllByRole('button', { name: 'New project' })).toHaveLength(1)
  })

  it('returns to active projects when a refresh empties the selected archive', async () => {
    let coordinationUpdated: (() => void) | null = null
    const archivedProject = {
      ...board.projects[0]!,
      id: 'project-archived',
      title: 'Previous launch',
      status: 'archived' as const,
    }
    const boardSnapshot = vi.fn()
      .mockResolvedValueOnce({
        projects: [...board.projects, archivedProject],
        tasks: board.tasks,
      })
      .mockResolvedValue({
        projects: [...board.projects, { ...archivedProject, status: 'active' as const }],
        tasks: board.tasks,
      })
    installRendererTestCoworkApi({
      coordination: { board: boardSnapshot },
      agents: { list: vi.fn(async () => []) },
      on: {
        coordinationUpdated: vi.fn((callback: () => void) => {
          coordinationUpdated = callback
          return () => { coordinationUpdated = null }
        }),
      },
    })

    render(<ProjectsBoardPage onOpenThread={vi.fn()} />)

    expect((await screen.findAllByText('Desktop parity launch')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Archived (1)' }))
    expect((await screen.findAllByText('Previous launch')).length).toBeGreaterThan(0)

    act(() => coordinationUpdated?.())

    await waitFor(() => expect(boardSnapshot).toHaveBeenCalledTimes(2))
    expect((await screen.findAllByText('Previous launch')).length).toBeGreaterThan(0)
    expect(screen.queryByText('No archived projects')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Archived \(/ })).not.toBeInTheDocument()
  })

  it('presents every stored project status as product copy instead of a raw enum', async () => {
    installRendererTestCoworkApi({
      coordination: {
        board: vi.fn(async () => ({
          projects: [
            { ...board.projects[0]!, id: 'project-active', title: 'Active project', status: 'active' as const },
            { ...board.projects[0]!, id: 'project-paused', title: 'Paused project', status: 'paused' as const },
            { ...board.projects[0]!, id: 'project-completed', title: 'Completed project', status: 'completed' as const },
            { ...board.projects[0]!, id: 'project-archived', title: 'Archived project', status: 'archived' as const },
          ],
          tasks: [],
        })),
      },
      agents: { list: vi.fn(async () => []) },
    })

    render(<ProjectsBoardPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText('Active')).toBeInTheDocument()
    expect(screen.getByText('Paused')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.queryByText('active', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText('paused', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText('completed', { exact: true })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Archived (1)' }))
    expect(await screen.findByText('Archived')).toBeInTheDocument()
    expect(screen.queryByText('archived', { exact: true })).not.toBeInTheDocument()
  })

  it('does not report or track a null mutation result as success', async () => {
    const moveTask = vi.fn(async () => null)
    installRendererTestCoworkApi({
      coordination: {
        board: vi.fn(async () => board),
        moveTask,
      },
      agents: { list: vi.fn(async () => []) },
    })

    render(<ProjectsBoardPage onOpenThread={vi.fn()} />)

    await screen.findByRole('heading', { name: 'Projects' })
    const taskButton = screen.getAllByRole('button')
      .find((button) => button.className.includes('studio-kanban-task-button'))
    fireEvent.click(taskButton as HTMLElement)
    fireEvent.click(within(screen.getByRole('group', { name: /task stage/i })).getByRole('button', { name: 'Done' }))

    await waitFor(() => expect(moveTask).toHaveBeenCalledWith('task-1', { column: 'done' }))
    expect(await screen.findByText('The project action did not change anything. Refresh and try again.')).toBeInTheDocument()
    expect(recordFeatureValueActivation).not.toHaveBeenCalled()
  })

  it.each([
    ['Cloud', 'cloud:test', 'cloud_worker'],
    ['Paired', 'paired-desktop:device-1', 'desktop_paired'],
  ] as const)('does not expose Desktop Local project state in a supported %s workspace', async (_label, workspaceId, authority) => {
    setRemoteWorkspace(workspaceId, authority)
    const api = installRendererTestCoworkApi({
      coordination: { board: vi.fn(async () => board) },
    })

    render(<ProjectsBoardPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText('Projects board unavailable here')).toBeInTheDocument()
    expect(screen.getByText(/Switch to Local to plan objectives and tasks/)).toBeInTheDocument()
    expect(screen.getByText('The desktop Projects board requires an active Local workspace with coordination enabled.')).toBeInTheDocument()
    expect(api.coordination.board).not.toHaveBeenCalled()
    expect(api.agents.list).not.toHaveBeenCalled()
    expect(api.app.builtinAgents).not.toHaveBeenCalled()
    expect(api.agents.runtime).not.toHaveBeenCalled()
    expect(api.on.coordinationUpdated).not.toHaveBeenCalled()
    expect(recordFeatureValueDiscovery).not.toHaveBeenCalledWith('projects')
  })

  it('uses the workspace-scoped coordination adapter in Cloud Web', async () => {
    Object.defineProperty(window, '__coworkBrowserRuntime', { configurable: true, value: true })
    setRemoteWorkspace('cloud:web', 'cloud_worker')
    const boardSnapshot = vi.fn(async () => board)
    const api = installRendererTestCoworkApi({
      coordination: { board: boardSnapshot },
      agents: { list: vi.fn(async () => []) },
    })

    render(<ProjectsBoardPage onOpenThread={vi.fn()} />)

    expect((await screen.findAllByText('Desktop parity launch')).length).toBeGreaterThan(0)
    expect(boardSnapshot).toHaveBeenCalledTimes(1)
    expect(api.on.coordinationUpdated).toHaveBeenCalled()
    expect(screen.getByText('Cloud workspace')).toBeInTheDocument()
    expect(screen.queryByText('Local workspace')).not.toBeInTheDocument()
    expect(screen.queryByText('Projects board unavailable here')).not.toBeInTheDocument()
    expect(recordFeatureValueDiscovery).toHaveBeenCalledWith('projects')
  })

  it('hides the previous Cloud board and ignores stale loads after switching workspaces', async () => {
    Object.defineProperty(window, '__coworkBrowserRuntime', { configurable: true, value: true })
    const firstWorkspaceId = 'cloud:first'
    const secondWorkspaceId = 'cloud:second'
    const cloudSupport: WorkspaceApiSupport[] = ['coordination.projects', 'coordination.tasks'].map((api) => ({
      api,
      status: 'supported',
      verdict: { allowed: true, reason: null },
      context: workspaceApiSupportContextForAuthority('cloud_worker'),
    }))
    useSessionStore.setState({ activeWorkspaceId: firstWorkspaceId })
    useWorkspaceSupportStore.setState({
      supportByWorkspace: {
        [LOCAL_WORKSPACE_ID]: localSupport,
        [firstWorkspaceId]: cloudSupport,
        [secondWorkspaceId]: cloudSupport,
      },
      loadedByWorkspace: {
        [LOCAL_WORKSPACE_ID]: true,
        [firstWorkspaceId]: true,
        [secondWorkspaceId]: true,
      },
      loadingByWorkspace: {},
      errorByWorkspace: {},
    })
    const staleFirstRefresh = deferred<CoordinationBoardPayload>()
    const secondLoad = deferred<CoordinationBoardPayload>()
    const firstBoard: CoordinationBoardPayload = {
      projects: [{ ...board.projects[0]!, id: 'project-first', title: 'First workspace objective' }],
      tasks: [],
    }
    const secondBoard: CoordinationBoardPayload = {
      projects: [{ ...board.projects[0]!, id: 'project-second', title: 'Second workspace objective' }],
      tasks: [],
    }
    const boardSnapshot = vi.fn()
      .mockResolvedValueOnce(firstBoard)
      .mockReturnValueOnce(staleFirstRefresh.promise)
      .mockReturnValueOnce(secondLoad.promise)
    installRendererTestCoworkApi({
      coordination: { board: boardSnapshot },
      agents: { list: vi.fn(async () => []) },
    })

    render(<ProjectsBoardPage onOpenThread={vi.fn()} />)

    expect((await screen.findAllByText('First workspace objective')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(boardSnapshot).toHaveBeenCalledTimes(2))

    act(() => useSessionStore.setState({ activeWorkspaceId: secondWorkspaceId }))

    await waitFor(() => expect(boardSnapshot).toHaveBeenCalledTimes(3))
    expect(screen.queryAllByText('First workspace objective')).toHaveLength(0)

    await act(async () => {
      secondLoad.resolve(secondBoard)
      await secondLoad.promise
    })
    expect((await screen.findAllByText('Second workspace objective')).length).toBeGreaterThan(0)

    await act(async () => {
      staleFirstRefresh.resolve(firstBoard)
      await staleFirstRefresh.promise
    })
    expect(screen.getAllByText('Second workspace objective').length).toBeGreaterThan(0)
    expect(screen.queryAllByText('First workspace objective')).toHaveLength(0)
  })

  it('stays restricted while a non-local workspace policy is loading', async () => {
    const workspaceId = 'cloud:pending-policy'
    useSessionStore.setState({ activeWorkspaceId: workspaceId })
    useWorkspaceSupportStore.setState({
      supportByWorkspace: { [LOCAL_WORKSPACE_ID]: localSupport },
      loadedByWorkspace: { [LOCAL_WORKSPACE_ID]: true },
      loadingByWorkspace: { [workspaceId]: true },
      errorByWorkspace: {},
    })
    const api = installRendererTestCoworkApi({
      workspace: { support: vi.fn(() => new Promise<never>(() => undefined)) },
      coordination: { board: vi.fn(async () => board) },
    })

    render(<ProjectsBoardPage onOpenThread={vi.fn()} />)

    expect(await screen.findByText('Projects board unavailable here')).toBeInTheDocument()
    expect(api.workspace.support).toHaveBeenCalledWith(workspaceId)
    expect(api.coordination.board).not.toHaveBeenCalled()
    expect(api.agents.list).not.toHaveBeenCalled()
    expect(api.on.coordinationUpdated).not.toHaveBeenCalled()
  })
})
