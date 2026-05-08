import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SandboxStorageStats } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { installRendererTestCoworkApi } from '../../test/setup'
import { StoragePanel } from './SettingsStoragePanel'

const stats: SandboxStorageStats = {
  root: '/tmp/open-cowork-test',
  totalBytes: 0,
  workspaceCount: 0,
  referencedWorkspaceCount: 0,
  unreferencedWorkspaceCount: 0,
  staleWorkspaceCount: 0,
  staleThresholdDays: 14,
}

beforeEach(() => {
  vi.clearAllMocks()
  useSessionStore.setState({
    globalErrors: [],
    busySessions: new Set(),
    awaitingPermissionSessions: new Set(),
    awaitingQuestionSessions: new Set(),
    sessionStateById: {},
    chartArtifactsBySession: {},
  })
})

describe('StoragePanel', () => {
  it('shows the manual update fallback when signed install is unsupported', async () => {
    installRendererTestCoworkApi({
      updates: {
        installCapability: vi.fn(async () => ({
          supported: false,
          reason: 'unsigned',
          currentVersion: '0.0.0',
          manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
        })),
      },
    })

    render(
      <StoragePanel
        stats={stats}
        runningCleanup={null}
        lastCleanup={null}
        onCleanup={vi.fn(async () => undefined)}
      />,
    )

    expect(await screen.findByText('This build is not signed for in-app update installation, so updates stay manual.')).toBeInTheDocument()
  })

  it('surfaces diagnostics export failures through the chat error channel and diagnostics', async () => {
    const user = userEvent.setup()
    const reportRendererError = vi.fn()
    installRendererTestCoworkApi({
      app: {
        checkUpdates: vi.fn(async () => ({
          status: 'current',
          currentVersion: '0.0.0',
          latestVersion: '0.0.0',
          releaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases/tag/v0.0.0',
          hasUpdate: false,
        })),
        exportDiagnostics: vi.fn(async () => {
          throw new Error('diagnostics unavailable')
        }),
      },
      diagnostics: {
        reportRendererError,
      },
    })

    render(
      <StoragePanel
        stats={stats}
        runningCleanup={null}
        lastCleanup={null}
        onCleanup={vi.fn(async () => undefined)}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Copy diagnostics to clipboard/ }))

    await waitFor(() => {
      expect(useSessionStore.getState().globalErrors[0]?.message).toBe('Could not export diagnostics. Please try again.')
    })
    expect(reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('diagnostics unavailable'),
      view: 'settings-storage',
    }))
    expect(screen.getByText('Could not build diagnostics — try again')).toBeInTheDocument()
  })
})
