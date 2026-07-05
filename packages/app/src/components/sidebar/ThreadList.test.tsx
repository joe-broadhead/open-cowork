import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo, SessionView } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { installRendererTestCoworkApi } from '../../test/setup'
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
  it('shows a guiding empty state when there are no conversations', () => {
    useSessionStore.setState({
      sessions: [],
      sessionsByWorkspace: { local: [] },
      currentSessionId: null,
    })

    render(<ThreadList />)

    expect(screen.getByText('No conversations yet')).toBeInTheDocument()
    expect(screen.getByText('Start one from Home to see it tracked here.')).toBeInTheDocument()
  })

  it('groups chats by project and keeps sandbox chats separate', () => {
    const groupedSessions: SessionInfo[] = [
      {
        id: 'client-main',
        title: 'Client launch',
        directory: '/Users/joe/Work/client-app',
        createdAt: '2026-05-08T00:00:00.000Z',
        updatedAt: '2026-05-08T00:00:00.000Z',
      },
      {
        id: 'client-follow-up',
        title: 'Client follow-up',
        directory: '/Users/joe/Work/client-app',
        createdAt: '2026-05-09T00:00:00.000Z',
        updatedAt: '2026-05-09T00:00:00.000Z',
      },
      {
        id: 'api-chat',
        title: 'API review',
        directory: '/Users/joe/Work/server-api',
        createdAt: '2026-05-10T00:00:00.000Z',
        updatedAt: '2026-05-10T00:00:00.000Z',
      },
      {
        id: 'sandbox-chat',
        title: 'Loose chat',
        directory: '/Users/joe/Open Cowork Sandbox/thread-2026-06-14-abc123',
        createdAt: '2026-05-11T00:00:00.000Z',
        updatedAt: '2026-05-11T00:00:00.000Z',
      },
    ]
    useSessionStore.setState({
      sessions: groupedSessions,
      sessionsByWorkspace: { local: groupedSessions },
      currentSessionId: 'client-main',
    })

    const { container } = render(<ThreadList />)

    const groupHeaders = Array.from(container.querySelectorAll('.thread-group-header'))
      .map((header) => header.textContent || '')

    expect(groupHeaders).toHaveLength(3)
    expect(groupHeaders.some((text) => text.includes('client-app') && text.includes('2'))).toBe(true)
    expect(groupHeaders.some((text) => text.includes('server-api') && text.includes('1'))).toBe(true)
    expect(groupHeaders.some((text) => text.includes('Sandbox') && text.includes('1'))).toBe(true)
    expect(screen.getByRole('button', { name: /Client launch/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Loose chat/ })).toBeInTheDocument()
  })

  it('groups remote cloud chats by project source instead of sandbox', () => {
    const cloudSessions: SessionInfo[] = [
      {
        id: 'cloud-api-main',
        title: 'API cloud chat',
        directory: null,
        createdAt: '2026-05-08T00:00:00.000Z',
        updatedAt: '2026-05-08T00:00:00.000Z',
        projectSource: { kind: 'git', repositoryUrl: 'https://github.com/acme/api.git' },
      },
      {
        id: 'cloud-chat-only',
        title: 'Cloud chat only',
        directory: null,
        createdAt: '2026-05-09T00:00:00.000Z',
        updatedAt: '2026-05-09T00:00:00.000Z',
      },
    ]
    useSessionStore.setState({
      activeWorkspaceId: 'cloud-workspace',
      sessions: cloudSessions,
      sessionsByWorkspace: { 'cloud-workspace': cloudSessions },
      currentSessionId: 'cloud-api-main',
    })

    const { container } = render(<ThreadList />)

    const groupHeaders = Array.from(container.querySelectorAll('.thread-group-header'))
      .map((header) => header.textContent || '')

    expect(groupHeaders.some((text) => text.includes('api') && text.includes('1'))).toBe(true)
    expect(groupHeaders.some((text) => text.includes('Chat-only') && text.includes('1'))).toBe(true)
    expect(groupHeaders.some((text) => text.includes('Sandbox'))).toBe(false)
  })

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

  it('requires an explicit Copy to Cloud preview before uploading local thread state', async () => {
    const workspaceList = vi.fn(async () => [{
      id: 'local',
      kind: 'local' as const,
      label: 'Local',
      status: 'online' as const,
      active: true,
      lastSyncedAt: null,
    }, {
      id: 'cloud:acme',
      kind: 'cloud' as const,
      label: 'Acme Cloud',
      status: 'online' as const,
      active: false,
      lastSyncedAt: null,
    }])
    const workspaceActivate = vi.fn(async () => ({
      id: 'cloud:acme',
      kind: 'cloud' as const,
      label: 'Acme Cloud',
      status: 'online' as const,
      active: true,
      lastSyncedAt: null,
    }))
    const importInventory = vi.fn(async () => ({
      source: { kind: 'local-session' as const, fingerprint: 'sha256:session-1', title: 'Current thread' },
      title: 'Current thread',
      counts: { messages: 3, artifacts: 2, attachments: 1, projectSource: 4, excluded: 2 },
      defaults: {
        includeMessages: true,
        includeArtifacts: false,
        includeAttachments: false,
        includeProjectSource: false,
      },
      warnings: [{ code: 'redacted-values', severity: 'warning' as const, message: 'Secret-like values were redacted before upload.' }],
      excluded: [{ kind: 'project-source', count: 4, reason: 'Local project source and host paths are excluded in v1.' }],
    }))
    const copyToCloud = vi.fn(async () => ({
      workspaceId: 'cloud:acme',
      sessionId: 'cloud-session-1',
      title: 'Current thread',
      importedAt: '2026-01-01T00:00:00.000Z',
      itemCounts: { messages: 3, artifacts: 2, attachments: 1, projectSource: 0, excluded: 2 },
    }))
    const listSessions = vi.fn(async () => [{
      id: 'cloud-session-1',
      title: 'Current thread',
      directory: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }])

    installRendererTestCoworkApi({
      workspace: {
        list: workspaceList,
        activate: workspaceActivate,
      },
      session: {
        importInventory,
        copyToCloud,
        list: listSessions,
      },
    })

    render(<ThreadList />)

    const row = screen.getByRole('button', { name: /Current thread/ })
    fireEvent.keyDown(row, { key: 'ContextMenu' })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy to Cloud...' }))

    const dialog = await screen.findByRole('dialog', { name: 'Copy to Cloud...' })
    expect(dialog).toHaveTextContent('Creates a new cloud thread. The local thread stays unchanged.')
    expect(importInventory).toHaveBeenCalledWith('session-1')
    expect(workspaceList).toHaveBeenCalled()

    expect(screen.getByRole('button', { name: /Cloud workspace/ })).toHaveTextContent('Acme Cloud')
    expect(dialog).toHaveTextContent('Messages')
    expect(dialog).toHaveTextContent('3')
    expect(dialog).toHaveTextContent('Artifacts')
    expect(dialog).toHaveTextContent('2')
    expect(dialog).toHaveTextContent('Attachments')
    expect(dialog).toHaveTextContent('1')
    expect(dialog).toHaveTextContent('Excluded')
    expect(dialog).toHaveTextContent('2')
    expect(dialog).toHaveTextContent('Secret-like values were redacted before upload.')
    expect(dialog).toHaveTextContent('Local project source and host paths are excluded in v1.')
    expect(screen.getByLabelText('Local project source and host paths are excluded in v1')).toBeDisabled()

    fireEvent.click(screen.getByLabelText('Copy data attachments already present in the thread'))
    fireEvent.click(screen.getByLabelText('Upload selected Cowork artifacts to cloud object storage'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy to Cloud' }))

    await waitFor(() => expect(copyToCloud).toHaveBeenCalledWith('session-1', {
      targetWorkspaceId: 'cloud:acme',
      selection: {
        includeMessages: true,
        includeArtifacts: true,
        includeAttachments: true,
        includeProjectSource: false,
      },
    }))
    expect(workspaceActivate).toHaveBeenCalledWith('cloud:acme')
    expect(listSessions).toHaveBeenCalledWith({ workspaceId: 'cloud:acme' })
    expect(useSessionStore.getState().activeWorkspaceId).toBe('cloud:acme')
    expect(useSessionStore.getState().currentSessionId).toBe('cloud-session-1')
  })
})
