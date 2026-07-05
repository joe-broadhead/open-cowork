import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CoordinationBoardPayload } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../../test/setup'
import { ProjectsBoardPage } from './ProjectsBoardPage'

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

describe('ProjectsBoardPage', () => {
  it('renders the coordination board and persists board actions through desktop IPC', async () => {
    const onOpenThread = vi.fn()
    const moveTask = vi.fn(async () => null)
    const assignTask = vi.fn(async () => null)
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

    fireEvent.click(taskButton as HTMLElement)
    const stageGroup = screen.getByRole('group', { name: /task stage/i })
    fireEvent.click(within(stageGroup).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(moveTask).toHaveBeenCalledWith('task-1', { column: 'done' }))

    await waitFor(() => expect(listAgents).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Coworker' }))
    // The roster coworker that is not on the board still appears in the menu.
    expect(screen.getByRole('menuitem', { name: 'Analyst Pro' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Chief Of Staff' }))
    await waitFor(() => expect(assignTask).toHaveBeenCalledWith('task-1', { assigneeAgent: 'chief-of-staff' }))

    fireEvent.click(screen.getByRole('button', { name: 'Open the work' }))
    await waitFor(() => expect(taskWorkTarget).toHaveBeenCalledWith('task-1'))
    expect(onOpenThread).toHaveBeenCalledWith('session-work')
  })
})
