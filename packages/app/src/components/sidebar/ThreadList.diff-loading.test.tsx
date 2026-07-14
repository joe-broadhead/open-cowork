import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionInfo, SessionView } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { installRendererTestCoworkApi } from '../../test/setup'

// Keep the production lazy import pending so this test exercises the exact
// interval before the DiffViewer chunk has resolved.
vi.mock('../chat/DiffViewer', () => new Promise<never>(() => {}))

import { ThreadList } from './ThreadList'

vi.mock('../../helpers/switchToSession', () => ({
  switchToSession: vi.fn(async () => undefined),
}))

const sessions: SessionInfo[] = [{
  id: 'session-1',
  title: 'Current thread',
  directory: '/tmp/project',
  createdAt: '2026-05-08T00:00:00.000Z',
  updatedAt: '2026-05-08T00:00:00.000Z',
}]

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
    sessionTokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
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
  installRendererTestCoworkApi()
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

describe('ThreadList changes viewer loading shell', () => {
  it('remains modal, traps focus, closes on Escape, and restores the thread row', async () => {
    const user = userEvent.setup()
    const { container } = render(<ThreadList />)
    const row = screen.getByRole('button', { name: /Current thread/ })

    row.focus()
    fireEvent.keyDown(row, { key: 'ContextMenu' })
    await user.click(screen.getByRole('menuitem', { name: 'View Changes' }))

    const dialog = await screen.findByRole('dialog', { name: 'Changes' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(container.querySelector('.ui-dialog-backdrop')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading changes...')

    const closeButton = screen.getByRole('button', { name: 'Close dialog' })
    await waitFor(() => expect(closeButton).toHaveFocus())
    await user.tab()
    expect(closeButton).toHaveFocus()

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Changes' })).not.toBeInTheDocument()
      expect(row).toHaveFocus()
    })
  })
})
