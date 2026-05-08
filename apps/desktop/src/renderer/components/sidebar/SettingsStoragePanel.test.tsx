import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SandboxStorageStats, UpdateInstallEvent, UpdateInstallStatus } from '@open-cowork/shared'
import { useSessionStore } from '../../stores/session'
import { installRendererTestCoworkApi } from '../../test/setup'
import { StoragePanel } from './SettingsStoragePanel'
import { resetSettingsUpdatesPanelStateForTests } from './SettingsUpdatesPanel'

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
  resetSettingsUpdatesPanelStateForTests()
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

  it('checks, downloads, and restarts signed updates from Settings', async () => {
    const user = userEvent.setup()
    let emitInstallEvent: ((event: UpdateInstallEvent) => void) | null = null
    let resolveDownload: ((status: UpdateInstallStatus) => void) | null = null
    const checkInstallable = vi.fn(async () => ({
      status: 'available' as const,
      currentVersion: '1.0.0',
      latestVersion: '1.0.1',
      manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
    }))
    const download = vi.fn(() => new Promise<UpdateInstallStatus>((resolve) => {
      resolveDownload = resolve
    }))
    const quitAndInstall = vi.fn(async () => ({
      status: 'installing' as const,
      currentVersion: '1.0.0',
      latestVersion: '1.0.1',
      manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
    }))
    installRendererTestCoworkApi({
      app: {
        metadata: vi.fn(async () => ({ version: '1.0.0', preview: false })),
        checkUpdates: vi.fn(async () => ({
          status: 'ok',
          currentVersion: '1.0.0',
          latestVersion: '1.0.1',
          hasUpdate: true,
          releaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases/tag/v1.0.1',
        })),
      },
      updates: {
        installCapability: vi.fn(async () => ({
          supported: true,
          currentVersion: '1.0.0',
          manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
        })),
        checkInstallable,
        download,
        quitAndInstall,
        onInstallEvent: vi.fn((callback: (event: UpdateInstallEvent) => void) => {
          emitInstallEvent = callback
          return () => { emitInstallEvent = null }
        }),
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

    expect(await screen.findByText('This signed macOS build can download and install signed updates from Settings.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Check for updates/ }))
    await waitFor(() => expect(checkInstallable).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('New version available: 1.0.1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Download update/ }))
    act(() => {
      emitInstallEvent?.({
        status: 'downloading',
        currentVersion: '1.0.0',
        latestVersion: '1.0.1',
        progress: {
          percent: 42,
          transferred: 420,
          total: 1000,
          bytesPerSecond: 50,
        },
        manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
      })
    })
    expect(screen.getByRole('progressbar', { name: /update download progress/i })).toHaveAttribute('aria-valuenow', '42')
    expect(screen.getAllByText('Downloading 42% · 420 B of 1000 B').length).toBeGreaterThan(0)

    act(() => {
      resolveDownload?.({
        status: 'downloaded',
        currentVersion: '1.0.0',
        latestVersion: '1.0.1',
        manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
      })
    })
    expect(await screen.findByText('Update ready to install')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Restart to install/ }))
    expect(quitAndInstall).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Restarting to install')).toBeInTheDocument()
  })

  it('preserves install state across Settings tab remounts', async () => {
    let emitInstallEvent: ((event: UpdateInstallEvent) => void) | null = null
    installRendererTestCoworkApi({
      updates: {
        installCapability: vi.fn(async () => ({
          supported: true,
          currentVersion: '1.0.0',
          manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
        })),
        onInstallEvent: vi.fn((callback: (event: UpdateInstallEvent) => void) => {
          emitInstallEvent = callback
          return () => { emitInstallEvent = null }
        }),
      },
    })

    const first = render(
      <StoragePanel
        stats={stats}
        runningCleanup={null}
        lastCleanup={null}
        onCleanup={vi.fn(async () => undefined)}
      />,
    )
    await screen.findByText('This signed macOS build can download and install signed updates from Settings.')

    first.unmount()
    act(() => {
      emitInstallEvent?.({
        status: 'downloaded',
        currentVersion: '1.0.0',
        latestVersion: '1.0.1',
        manualReleaseUrl: 'https://github.com/joe-broadhead/open-cowork/releases',
      })
    })

    render(
      <StoragePanel
        stats={stats}
        runningCleanup={null}
        lastCleanup={null}
        onCleanup={vi.fn(async () => undefined)}
      />,
    )

    expect(await screen.findByText('Update ready to install')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Restart to install/ })).toBeInTheDocument()
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
