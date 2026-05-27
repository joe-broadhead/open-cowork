import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingQuestion } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { installRendererTestCoworkApi } from '../../test/setup'
import { SessionQuestionDock } from './SessionQuestionDock'

const baseRequest: PendingQuestion = {
  id: 'question-1',
  sessionId: 'session-1',
  questions: [
    {
      header: 'Choose a path',
      question: 'Which approach should the agent use?',
      options: [
        { label: 'Use the safe path', description: 'Keep the change narrow.' },
        { label: 'Go broader', description: 'Refactor adjacent code too.' },
      ],
    },
  ],
}

function installQuestionApi() {
  return installRendererTestCoworkApi({
    question: {
      reply: vi.fn(async () => undefined),
      reject: vi.fn(async () => undefined),
    },
  })
}

function resetSessionStore() {
  const currentView = useSessionStore.getState().currentView
  useSessionStore.setState({
    activeWorkspaceId: 'local',
    currentSessionId: 'session-1',
    currentView: {
      ...currentView,
      toolCalls: [
        {
          id: 'tool-call-1',
          name: 'Read file',
          input: { path: 'src/index.ts' },
          status: 'complete',
          order: 1,
        },
      ],
    },
    globalErrors: [],
    busySessions: new Set(),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetSessionStore()
  installQuestionApi()
})

describe('SessionQuestionDock', () => {
  it('answers multi-step questions with selected and custom answers', async () => {
    const user = userEvent.setup()
    const api = installQuestionApi()
    const request: PendingQuestion = {
      ...baseRequest,
      questions: [
        baseRequest.questions[0],
        {
          header: 'Choose checks',
          question: 'Which validation should run?',
          multiple: true,
          options: [
            { label: 'Run tests', description: 'Use the test suite.' },
            { label: 'Run lint', description: 'Use the linter.' },
          ],
        },
      ],
    }

    render(<SessionQuestionDock request={request} queueCount={2} />)

    expect(screen.getByText('2 pending')).toBeInTheDocument()
    expect(screen.getByText('1 / 2')).toBeInTheDocument()
    expect(screen.getByText('Choose a path')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Use the safe path/ }))
    await user.click(screen.getByRole('button', { name: 'Next' }))

    expect(screen.getByText('2 / 2')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Run tests/ }))
    await user.click(screen.getByLabelText('Custom answer'))
    await user.type(screen.getByPlaceholderText('Type your own answer'), 'Capture screenshots')
    await user.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => expect(api.question.reply).toHaveBeenCalledWith('session-1', 'question-1', [
      ['Use the safe path'],
      ['Run tests', 'Capture screenshots'],
    ], { workspaceId: 'local' }))
  })

  it('surfaces the scoped tool call and scrolls to it on request', async () => {
    const user = userEvent.setup()
    const scrollIntoView = vi.fn()
    const target = document.createElement('div')
    target.dataset.toolCallId = 'tool-call-1'
    Object.defineProperty(target, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    document.body.append(target)
    const request: PendingQuestion = {
      ...baseRequest,
      tool: {
        messageId: 'message-1',
        callId: 'tool-call-1',
      },
    }

    render(<SessionQuestionDock request={request} />)

    await user.click(screen.getByRole('button', { name: /About:/ }))
    expect(screen.getByText('Read file')).toBeInTheDocument()
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })
  })

  it('rejects the active question through the question IPC', async () => {
    const user = userEvent.setup()
    const api = installQuestionApi()

    render(<SessionQuestionDock request={baseRequest} />)

    await user.click(screen.getByRole('button', { name: 'Dismiss' }))

    await waitFor(() => expect(api.question.reject).toHaveBeenCalledWith('session-1', 'question-1', { workspaceId: 'local' }))
    expect(api.question.reply).not.toHaveBeenCalled()
  })

  it('does not submit replies when no session is active', async () => {
    const user = userEvent.setup()
    const api = installQuestionApi()
    useSessionStore.setState({ currentSessionId: null })

    render(<SessionQuestionDock request={baseRequest} />)

    await user.click(screen.getByRole('button', { name: /Use the safe path/ }))
    await user.click(screen.getByRole('button', { name: 'Submit' }))

    expect(api.question.reply).not.toHaveBeenCalled()
    expect(api.question.reject).not.toHaveBeenCalled()
  })

  it('resets local answers when a new request arrives', async () => {
    const user = userEvent.setup()
    const api = installQuestionApi()
    const nextRequest: PendingQuestion = {
      ...baseRequest,
      id: 'question-2',
      questions: [
        {
          header: 'Second question',
          question: 'What should happen next?',
          options: [
            { label: 'Continue', description: 'Proceed with the task.' },
            { label: 'Stop', description: 'Stop the task.' },
          ],
        },
      ],
    }

    const { rerender } = render(<SessionQuestionDock request={baseRequest} />)
    await user.click(screen.getByRole('button', { name: /Use the safe path/ }))

    rerender(<SessionQuestionDock request={nextRequest} />)
    await user.click(screen.getByRole('button', { name: /Continue/ }))
    await user.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => expect(api.question.reply).toHaveBeenCalledWith('session-1', 'question-2', [
      ['Continue'],
    ], { workspaceId: 'local' }))
  })
})
