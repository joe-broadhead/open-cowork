import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, SessionInfo } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { installRendererTestCoworkApi } from '../../test/setup'
import { loadSessionMessages } from '../../helpers/loadSessionMessages'
import { MessageBubble } from './MessageBubble'

vi.mock('../../helpers/loadSessionMessages', () => ({
  loadSessionMessages: vi.fn(async () => undefined),
}))

vi.mock('./MarkdownContent', () => ({
  MarkdownContent: ({ text, streaming }: { text: string; streaming?: boolean }) => (
    <article data-testid="markdown-content">
      {text}
      {streaming ? ' streaming' : ''}
    </article>
  ),
}))

vi.mock('./DiffViewer', () => ({
  DiffViewer: ({
    sessionId,
    messageId,
    onClose,
  }: {
    sessionId: string
    messageId: string
    onClose: () => void
  }) => (
    <aside data-testid="diff-viewer">
      Diff for {sessionId}/{messageId}
      <button type="button" onClick={onClose}>Close diff</button>
    </aside>
  ),
}))

const baseMessage: Message = {
  id: 'message-1',
  role: 'user',
  content: 'Review this chart',
  order: 1,
}

const forkedSession: SessionInfo = {
  id: 'forked-session',
  title: 'Forked thread',
  directory: '/tmp/project',
  createdAt: '2026-05-07T00:00:00.000Z',
  updatedAt: '2026-05-07T00:00:00.000Z',
}

function resetSessionStore() {
  useSessionStore.setState({
    sessions: [
      {
        id: 'session-1',
        title: 'Current thread',
        directory: '/tmp/project',
        createdAt: '2026-05-07T00:00:00.000Z',
        updatedAt: '2026-05-07T00:00:00.000Z',
      },
    ],
    currentSessionId: 'session-1',
    globalErrors: [],
    busySessions: new Set(),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
    sessionStateById: {},
    chartArtifactsBySession: {},
  })
}

function installMessageApi(options: {
  forkResult?: SessionInfo | null
  revertResult?: boolean
} = {}) {
  return installRendererTestCoworkApi({
    session: {
      fork: vi.fn(async () => ('forkResult' in options ? options.forkResult : forkedSession)),
      revert: vi.fn(async () => ('revertResult' in options ? options.revertResult : true)),
    },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetSessionStore()
  installMessageApi()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('MessageBubble', () => {
  it('renders user text, image attachments, and file attachments', () => {
    render(
      <MessageBubble
        message={{
          ...baseMessage,
          attachments: [
            {
              mime: 'image/png',
              url: 'data:image/png;base64,abc',
              filename: 'chart.png',
            },
            {
              mime: 'text/plain',
              url: 'data:text/plain;base64,abc',
              filename: 'notes.txt',
            },
          ],
        }}
      />,
    )

    expect(screen.getByText('Review this chart')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: 'User message' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'chart.png' })).toHaveAttribute('src', 'data:image/png;base64,abc')
    expect(screen.getByText('notes.txt')).toBeInTheDocument()
  })

  it('summarizes attachment-only user turns without showing the sentinel content', () => {
    render(
      <MessageBubble
        message={{
          ...baseMessage,
          content: '',
          attachments: [
            {
              mime: 'application/pdf',
              url: 'data:application/pdf;base64,abc',
              filename: 'brief.pdf',
            },
          ],
        }}
      />,
    )

    expect(screen.getByText('Sent 1 attachment')).toBeInTheDocument()
    expect(screen.getByText('brief.pdf')).toBeInTheDocument()
  })

  it('renders assistant markdown and supports branch, revert, and diff actions', async () => {
    const user = userEvent.setup()
    const api = installMessageApi()
    const assistantMessage: Message = {
      id: 'assistant-message',
      role: 'assistant',
      content: 'Done with changes',
      order: 2,
    }

    render(<MessageBubble message={assistantMessage} streaming />)

    expect(screen.getByRole('article', { name: 'Assistant message' })).toBeInTheDocument()
    expect(screen.getByTestId('markdown-content')).toHaveTextContent('Done with changes streaming')

    await user.click(screen.getByRole('button', { name: 'Copy message' }))
    await waitFor(() => expect(window.coworkApi.clipboard.writeText).toHaveBeenCalledWith('Done with changes'))

    await user.click(screen.getByRole('button', { name: 'Branch here' }))
    await waitFor(() => expect(api.session.fork).toHaveBeenCalledWith('session-1', 'assistant-message'))
    expect(loadSessionMessages).toHaveBeenCalledWith('forked-session')
    expect(useSessionStore.getState().sessions[0]?.id).toBe('forked-session')

    await user.click(screen.getByRole('button', { name: 'View diff' }))
    expect(screen.getByTestId('diff-viewer')).toHaveTextContent('Diff for session-1/assistant-message')
    await user.click(screen.getByRole('button', { name: 'Close diff' }))
    expect(screen.queryByTestId('diff-viewer')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Revert to here' }))
    expect(window.confirm).toHaveBeenCalledWith('Revert the session to this message? Later turns will be hidden until you un-revert.')
    await waitFor(() => expect(api.session.revert).toHaveBeenCalledWith('session-1', 'assistant-message'))
  })

  it('hides message actions when the visible bubble is only part of an SDK message', () => {
    render(
      <MessageBubble
        message={{
          id: 'assistant-message',
          role: 'assistant',
          content: 'Partial answer before a tool call.',
          order: 2,
        }}
        actionsEnabled={false}
      />,
    )

    expect(screen.getByTestId('markdown-content')).toHaveTextContent('Partial answer before a tool call.')
    expect(screen.queryByRole('button', { name: 'Copy message' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Branch here' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revert to here' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'View diff' })).not.toBeInTheDocument()
  })

  it('keeps assistant reasoning behind a thinking disclosure', async () => {
    const user = userEvent.setup()
    const assistantMessage: Message = {
      id: 'assistant-message',
      role: 'assistant',
      content: 'Final answer',
      reasoning: [{ id: 'reasoning-1', content: 'Internal comparison table', order: 1 }],
      order: 2,
    }

    render(<MessageBubble message={assistantMessage} />)

    expect(screen.getByTestId('markdown-content')).toHaveTextContent('Final answer')
    expect(screen.queryByText('Internal comparison table')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Thinking/i }))
    expect(screen.getByText('Internal comparison table')).toBeInTheDocument()
  })

  it('keeps live assistant reasoning compact by default and available after streaming stops', async () => {
    const user = userEvent.setup()
    const assistantMessage: Message = {
      id: 'assistant-message',
      role: 'assistant',
      content: '',
      reasoning: [{ id: 'reasoning-1', content: 'Comparing the source rows', order: 1 }],
      order: 2,
    }

    const { rerender } = render(<MessageBubble message={assistantMessage} streaming />)

    expect(screen.getByRole('button', { name: /Thinking/i })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/Comparing the source rows/)).not.toBeInTheDocument()

    rerender(<MessageBubble message={{ ...assistantMessage, content: 'Final answer' }} />)

    expect(screen.getByRole('button', { name: /Thinking/i })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/Comparing the source rows/)).not.toBeInTheDocument()
    expect(screen.getAllByTestId('markdown-content').some((node) => node.textContent?.includes('Final answer'))).toBe(true)

    await user.click(screen.getByRole('button', { name: /Thinking/i }))
    expect(screen.getByText(/Comparing the source rows/)).toBeInTheDocument()
  })

  it('hides actions for live placeholder messages and records failed branch attempts', async () => {
    const user = userEvent.setup()
    const api = installMessageApi({ forkResult: null })
    const message: Message = {
      id: 'message-2',
      role: 'user',
      content: 'Can you branch from here?',
      order: 1,
    }

    const { rerender } = render(<MessageBubble message={{ ...message, id: 'message-2:user:live' }} />)
    expect(screen.queryByRole('button', { name: 'Branch here' })).not.toBeInTheDocument()

    rerender(<MessageBubble message={message} />)
    await user.click(screen.getByRole('button', { name: 'Branch here' }))

    await waitFor(() => expect(api.session.fork).toHaveBeenCalledWith('session-1', 'message-2'))
    await waitFor(() => {
      expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not branch from this message. Please try again.')
    })
  })
})
