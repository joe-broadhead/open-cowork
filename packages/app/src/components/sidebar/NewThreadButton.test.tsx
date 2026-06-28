import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../../stores/session'
import { installRendererTestCoworkApi } from '../../test/setup'
import { NewThreadButton } from './NewThreadButton'

function resetSessionStore() {
  useSessionStore.setState({
    activeWorkspaceId: 'local',
    sessionsByWorkspace: { local: [] },
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

    await user.click(screen.getByRole('button', { name: 'New Chat' }))
    await user.click(screen.getByRole('button', { name: /Blank chat/ }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(undefined)
    })
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not create a new project chat. Please try again.')
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

    await user.click(screen.getByRole('button', { name: 'New Chat' }))
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

    await user.click(screen.getByRole('button', { name: 'New Chat' }))
    await user.click(screen.getByRole('button', { name: /Blank chat/ }))

    await waitFor(() => {
      expect(create).toHaveBeenCalledWith(undefined)
    })
    expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not create a new project chat. Please try again.')
    expect(screen.queryByRole('button', { name: /Blank chat/ })).not.toBeInTheDocument()
  })

  it('opens the cloud project-source flow instead of the local directory picker', async () => {
    const user = userEvent.setup()
    const selectDirectory = vi.fn(async () => '/tmp/project')
    const validate = vi.fn(async () => ({ allowed: true, reason: null }))
    const create = vi.fn(async () => ({
      id: 'cloud-session-1',
      title: 'Cloud session',
      directory: null,
      createdAt: '2026-05-27T10:00:00.000Z',
      updatedAt: '2026-05-27T10:00:00.000Z',
    }))
    installRendererTestCoworkApi({
      workspace: {
        support: vi.fn(async () => [
          {
            api: 'sessions.create',
            status: 'supported',
            verdict: { allowed: true, reason: null },
          },
          {
            api: 'localFiles',
            status: 'not_supported',
            verdict: {
              allowed: false,
              reason: 'Cloud workspaces do not implicitly upload local files.',
            },
          },
        ]),
      },
      dialog: {
        selectDirectory,
      },
      projectSource: {
        validate,
      },
      session: {
        create,
        activate: vi.fn(async () => undefined),
      },
    })
    useSessionStore.getState().setActiveWorkspace('cloud:acme')

    render(<NewThreadButton />)

    await user.click(screen.getByRole('button', { name: 'New Chat' }))

    expect(await screen.findByText('Cloud-safe action - start a synced cloud chat')).toBeTruthy()
    expect(screen.getByText('Cloud-safe action - choose Git or upload an explicit snapshot')).toBeTruthy()
    const projectButton = screen.getByRole('button', { name: /Open Project/ })
    await user.click(projectButton)
    expect(selectDirectory).not.toHaveBeenCalled()
    expect(await screen.findByText('Cloud project source')).toBeTruthy()

    await user.type(screen.getByPlaceholderText('https://github.com/org/repo.git'), 'https://github.com/acme/repo.git')
    await user.click(screen.getByRole('button', { name: 'Create project chat' }))

    await waitFor(() => {
      expect(validate).toHaveBeenCalledWith({
        workspaceId: 'cloud:acme',
        projectSource: {
          kind: 'git',
          repositoryUrl: 'https://github.com/acme/repo.git',
          ref: null,
          subdirectory: null,
          credentialRef: null,
        },
      })
      expect(create).toHaveBeenCalledWith(undefined, {
        workspaceId: 'cloud:acme',
        projectSource: {
          kind: 'git',
          repositoryUrl: 'https://github.com/acme/repo.git',
          ref: null,
          subdirectory: null,
          credentialRef: null,
        },
      })
    })
  })
})
