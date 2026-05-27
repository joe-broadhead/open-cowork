import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo, SessionView } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { ThreadList } from './ThreadList'

vi.mock('../../helpers/loadSessionMessages', () => ({
  loadSessionMessages: vi.fn(async () => undefined),
}))

const sessions: SessionInfo[] = [
  {
    id: 'session-1',
    title: 'Current thread',
    directory: '/tmp/project',
    createdAt: '2026-05-08T00:00:00.000Z',
    updatedAt: '2026-05-08T00:00:00.000Z',
  },
]

const sessionTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

function emptySessionView(): SessionView {
  return {
    messages: [],
    toolCalls: [],
    taskRuns: [],
    compactions: [],
    pendingApprovals: [],
    pendingQuestions: [],
    errors: [],
    todos: [],
    executionPlan: [],
    sessionCost: 0,
    sessionTokens,
    lastInputTokens: 0,
    contextState: 'idle',
    compactionCount: 0,
    lastCompactedAt: null,
    activeAgent: null,
    lastItemWasTool: false,
    revision: 0,
    lastEventAt: 0,
    isGenerating: false,
    isAwaitingPermission: false,
    isAwaitingQuestion: false,
  }
}

beforeEach(() => {
  useSessionStore.setState({
    activeWorkspaceId: 'local',
    sessionsByWorkspace: { local: sessions },
    sessions,
    currentSessionId: 'session-1',
    currentView: emptySessionView(),
    globalErrors: [],
    busySessions: new Set(),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
    sessionStateById: {},
    chartArtifactsBySession: {},
  })
})

describe('ThreadList', () => {
  it('opens an accessible thread action menu from the keyboard context-menu command', async () => {
    render(<ThreadList />)

    const row = screen.getByRole('button', { name: /Current thread/ })
    expect(row).toHaveAttribute('aria-haspopup', 'menu')
    expect(row).toHaveAttribute('aria-expanded', 'false')

    fireEvent.keyDown(row, { key: 'ContextMenu' })

    expect(row).toHaveAttribute('aria-expanded', 'true')
    let menu = screen.getByRole('menu', { name: 'Thread actions' })
    expect(menu).toBeInTheDocument()
    const renameItem = screen.getByRole('menuitem', { name: 'Rename' })
    const exportItem = screen.getByRole('menuitem', { name: 'Export Markdown' })
    expect(renameItem).toBeInTheDocument()
    expect(exportItem).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Share Link' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'View Changes' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()

    await waitFor(() => expect(renameItem).toHaveFocus())

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(exportItem).toHaveFocus()

    fireEvent.keyDown(menu, { key: 'Tab' })
    expect(screen.queryByRole('menu', { name: 'Thread actions' })).not.toBeInTheDocument()
    expect(row).toHaveAttribute('aria-expanded', 'false')

    fireEvent.keyDown(row, { key: 'ContextMenu' })
    menu = screen.getByRole('menu', { name: 'Thread actions' })
    await waitFor(() => expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus())

    fireEvent.keyDown(menu, { key: 'Escape' })
    await waitFor(() => expect(row).toHaveFocus())
    expect(row).toHaveAttribute('aria-expanded', 'false')
  })

  it('hides local-only thread action menus in cloud workspaces', () => {
    useSessionStore.setState({
      activeWorkspaceId: 'cloud:acme',
      sessionsByWorkspace: { 'cloud:acme': sessions },
      sessions,
      currentSessionId: 'session-1',
    })

    render(<ThreadList />)

    const row = screen.getByRole('button', { name: /Current thread/ })
    expect(row).not.toHaveAttribute('aria-haspopup')
    expect(row).not.toHaveAttribute('aria-expanded')

    fireEvent.keyDown(row, { key: 'ContextMenu' })
    fireEvent.contextMenu(row)

    expect(screen.queryByRole('menu', { name: 'Thread actions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument()
  })
})
