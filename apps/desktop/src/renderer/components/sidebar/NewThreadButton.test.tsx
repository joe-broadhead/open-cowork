import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../../stores/session'
import { installRendererTestCoworkApi } from '../../test/setup'
import { NewThreadButton } from './NewThreadButton'

function resetSessionStore() {
  useSessionStore.setState({
    sessions: [],
    currentSessionId: null,
    globalErrors: [],
    busySessions: new Set(),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
    sessionStateById: {},
    chartArtifactsBySession: {},
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetSessionStore()
})

describe('NewThreadButton', () => {
  it('surfaces session creation failures through the chat error channel and diagnostics', async () => {
    const user = userEvent.setup()
    const create = vi.fn(async () => {
      throw new Error('runtime unavailable')
    })
    const reportRendererError = vi.fn()
    const api = installRendererTestCoworkApi({
      diagnostics: {
        reportRendererError,
      },
      session: {
        create,
        activate: vi.fn(async () => undefined),
      },
    })

    render(<NewThreadButton />)

    await user.click(screen.getByRole('button', { name: 'New Thread' }))
    await user.click(screen.getByRole('button', { name: /Blank thread/ }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(undefined)
    })
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not create a new thread. Please try again.')
    expect(api.diagnostics.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('runtime unavailable'),
      view: 'new-thread',
    }))
  })

  it('surfaces project picker failures through the chat error channel and diagnostics', async () => {
    const user = userEvent.setup()
    const selectDirectory = vi.fn(async () => {
      throw new Error('dialog unavailable')
    })
    const reportRendererError = vi.fn()
    const api = installRendererTestCoworkApi({
      diagnostics: {
        reportRendererError,
      },
      dialog: {
        selectDirectory,
      },
      session: {
        create: vi.fn(async () => {
          throw new Error('should not create')
        }),
        activate: vi.fn(async () => undefined),
      },
    })

    render(<NewThreadButton />)

    await user.click(screen.getByRole('button', { name: 'New Thread' }))
    await user.click(screen.getByRole('button', { name: /Open Project/ }))

    await waitFor(() => {
      expect(selectDirectory).toHaveBeenCalled()
    })
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not open the project picker. Please try again.')
    expect(api.diagnostics.reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('dialog unavailable'),
      view: 'new-thread',
    }))
  })

  it('keeps the recovery path intact when diagnostics reporting fails', async () => {
    const user = userEvent.setup()
    const create = vi.fn(async () => {
      throw new Error('runtime unavailable')
    })
    installRendererTestCoworkApi({
      diagnostics: {
        reportRendererError: vi.fn(() => {
          throw new Error('diagnostics unavailable')
        }),
      },
      session: {
        create,
        activate: vi.fn(async () => undefined),
      },
    })

    render(<NewThreadButton />)

    await user.click(screen.getByRole('button', { name: 'New Thread' }))
    await user.click(screen.getByRole('button', { name: /Blank thread/ }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(undefined)
    })
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not create a new thread. Please try again.')
    expect(screen.queryByRole('button', { name: /Blank thread/ })).not.toBeInTheDocument()
  })
})
