import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Sidebar } from './Sidebar'
import { installRendererTestCoworkApi } from '../../test/setup'
import { useSessionStore } from '../../stores/session'
import { LOCAL_WORKSPACE_ID } from '../../stores/session-workspace-keys'
import { useWorkspaceSupportStore } from '../../stores/workspace-support'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('Sidebar', () => {
  beforeEach(() => {
    useSessionStore.setState(useSessionStore.getInitialState(), true)
    useWorkspaceSupportStore.setState({
      supportByWorkspace: {},
      loadedByWorkspace: {},
      loadingByWorkspace: {},
      errorByWorkspace: {},
    })
  })

  it('ignores stale workspace activation responses', async () => {
    const slowActivation = deferred<{
      id: string
      kind: 'cloud'
      label: string
      status: 'online'
      active: boolean
      baseUrl: string
      lastSyncedAt: null
    }>()
    let activeWorkspaceId = 'local'
    const workspace = (id: string) => ({
      id,
      kind: id === 'local' ? 'local' as const : 'cloud' as const,
      label: id === 'local' ? 'Local' : id === 'cloud:slow' ? 'Slow Cloud' : 'Fast Cloud',
      status: 'online' as const,
      active: activeWorkspaceId === id,
      ...(id === 'local' ? {} : { baseUrl: `https://${id.replace(':', '-')}.test` }),
      lastSyncedAt: null,
    })
    const sessionList = vi.fn(async (options?: { workspaceId?: string }) => (
      options?.workspaceId === 'cloud:fast'
        ? [{
            id: 'fast-session',
            title: 'Fast session',
            createdAt: '2026-05-27T10:00:00.000Z',
            updatedAt: '2026-05-27T10:00:00.000Z',
          }]
        : [{
            id: 'slow-session',
            title: 'Slow session',
            createdAt: '2026-05-27T10:00:00.000Z',
            updatedAt: '2026-05-27T10:00:00.000Z',
          }]
    ))
    const activate = vi.fn(async (workspaceId: string) => {
      if (workspaceId === 'cloud:slow') {
        const activated = await slowActivation.promise
        activeWorkspaceId = workspaceId
        return activated
      }
      activeWorkspaceId = workspaceId
      return workspace(workspaceId)
    })
    installRendererTestCoworkApi({
      workspace: {
        list: vi.fn(async () => [workspace('local'), workspace('cloud:slow'), workspace('cloud:fast')]),
        activate,
        support: vi.fn(async () => [{
          api: 'sessions.list',
          status: 'supported',
          verdict: { allowed: true, reason: null },
        }]),
      },
      session: {
        list: sessionList,
      },
    })

    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /Local.*Online.*Local workspace - private on this device/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Slow Cloud.*Online/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Local.*Online.*Local workspace - private on this device/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Fast Cloud.*Online/i }))

    await waitFor(() => {
      expect(useSessionStore.getState().activeWorkspaceId).toBe('cloud:fast')
      expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['fast-session'])
    })

    slowActivation.resolve({
      id: 'cloud:slow',
      kind: 'cloud',
      label: 'Slow Cloud',
      status: 'online',
      active: true,
      baseUrl: 'https://cloud-slow.test',
      lastSyncedAt: null,
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useSessionStore.getState().activeWorkspaceId).toBe('cloud:fast')
    expect(useSessionStore.getState().sessions.map((session) => session.id)).toEqual(['fast-session'])
    expect(sessionList).not.toHaveBeenCalledWith({ workspaceId: 'cloud:slow' })
  })

  it('keeps the Studio sidebar layout when no branding config is provided', () => {
    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'New Chat' })).toBeTruthy()
    expect(screen.getByText('Projects')).toBeTruthy()
    expect(screen.getByText('Approvals')).toBeTruthy()
    expect(screen.getByText('Team')).toBeTruthy()
    expect(screen.getByText('Playbooks')).toBeTruthy()
    expect(screen.getByText('Channels')).toBeTruthy()
    expect(screen.getByText('Tools & Skills')).toBeTruthy()
    expect(screen.getByText('Artifacts')).toBeTruthy()
    expect(screen.getByText('Diagnostics')).toBeTruthy()
    expect(screen.queryByText('Acme AI')).toBeNull()
  })

  it('collapses and reopens the Manage navigation group', () => {
    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Team' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Playbooks' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Manage/ }))

    expect(screen.queryByRole('button', { name: 'Team' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Playbooks' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Manage/ }))

    expect(screen.getByRole('button', { name: 'Team' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Playbooks' })).toBeTruthy()
  })

  it('renders a compact rail without unmounting navigation actions', () => {
    const onExpandSidebar = vi.fn()
    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        collapsed
        onExpandSidebar={onExpandSidebar}
      />,
    )

    expect(screen.getByRole('complementary', { name: 'Sidebar navigation' })).toHaveAttribute('data-sidebar-collapsed', 'true')
    expect(screen.getByRole('button', { name: 'New Chat' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Manage' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'Team' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Diagnostics' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings' }).parentElement).toHaveClass('flex-col')
    expect(screen.queryByText('Recent work')).toBeNull()
    expect(screen.queryByText('Tool Status')).toBeNull()
    expect(screen.queryByText('New Chat')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Search projects and chats/ }))
    expect(onExpandSidebar).toHaveBeenCalledTimes(1)
  })

  it('does not re-expand the compact rail for an already handled search request', () => {
    const onExpandSidebar = vi.fn()
    const { rerender } = render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        searchRequestNonce={1}
        onExpandSidebar={onExpandSidebar}
      />,
    )

    expect(onExpandSidebar).not.toHaveBeenCalled()

    rerender(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        searchRequestNonce={1}
        collapsed
        onExpandSidebar={onExpandSidebar}
      />,
    )

    expect(onExpandSidebar).not.toHaveBeenCalled()

    rerender(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        searchRequestNonce={2}
        collapsed
        onExpandSidebar={onExpandSidebar}
      />,
    )

    expect(onExpandSidebar).toHaveBeenCalledTimes(1)
  })

  it('shows a live approvals alert count in the Studio nav', () => {
    const baseView = useSessionStore.getInitialState().currentView
    const sessions = [{ id: 'active-session', title: 'Active chat', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]
    useSessionStore.setState({
      activeWorkspaceId: LOCAL_WORKSPACE_ID,
      sessions,
      sessionsByWorkspace: { [LOCAL_WORKSPACE_ID]: sessions },
      currentSessionId: 'active-session',
    })
    useSessionStore.getState().setSessionView('active-session', {
      ...baseView,
      pendingApprovals: [{
        id: 'approval-1',
        sessionId: 'active-session',
        tool: 'bash',
        input: {},
        description: 'Run command',
        order: 1,
      }],
      pendingQuestions: [{
        id: 'question-1',
        sessionId: 'active-session',
        questions: [{ header: 'Confirm', question: 'Continue?', options: [] }],
      }],
    }, LOCAL_WORKSPACE_ID)

    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
      />,
    )

    const approvalsButton = screen.getByRole('button', { name: /Approvals.*2/i })
    expect(approvalsButton).toBeTruthy()
    expect(screen.getByLabelText('2 pending approvals and questions')).toBeTruthy()
  })

  it('navigates to the Health Center from the secondary diagnostics entry', () => {
    const onViewChange = vi.fn()
    render(
      <Sidebar
        currentView="home"
        onViewChange={onViewChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }))
    expect(onViewChange).toHaveBeenCalledWith('health')
  })

  it('renders the workspace switcher and activates a selected workspace', async () => {
    installRendererTestCoworkApi({
      workspace: {
        list: vi.fn()
          .mockResolvedValueOnce([
            {
              id: 'local',
              kind: 'local',
              label: 'Local',
              status: 'online',
              active: true,
              lastSyncedAt: null,
            },
            {
              id: 'cloud:acme',
              kind: 'cloud',
              label: 'Acme Cloud',
              status: 'disabled',
              active: false,
              baseUrl: 'https://cloud.acme.test',
              lastSyncedAt: null,
            },
          ])
          .mockResolvedValueOnce([
            {
              id: 'local',
              kind: 'local',
              label: 'Local',
              status: 'online',
              active: false,
              lastSyncedAt: null,
            },
            {
              id: 'cloud:acme',
              kind: 'cloud',
              label: 'Acme Cloud',
              status: 'disabled',
              active: true,
              baseUrl: 'https://cloud.acme.test',
              lastSyncedAt: null,
            },
          ]),
        activate: vi.fn(async () => ({
          id: 'cloud:acme',
          kind: 'cloud',
          label: 'Acme Cloud',
          status: 'disabled',
          active: true,
          baseUrl: 'https://cloud.acme.test',
          lastSyncedAt: null,
        })),
      },
    })

    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
      />,
    )

    const switcher = await screen.findByRole('button', { name: /Local.*Online.*Local workspace - private on this device/i })
    fireEvent.click(switcher)
    fireEvent.click(await screen.findByRole('menuitem', { name: /Acme Cloud.*Policy disabled/i }))

    await waitFor(() => {
      expect(window.coworkApi.workspace.activate).toHaveBeenCalledWith('cloud:acme')
    })
  })

  it('starts login when selecting an auth-required cloud workspace', async () => {
    const sessionList = vi.fn(async () => [])
    installRendererTestCoworkApi({
      workspace: {
        list: vi.fn()
          .mockResolvedValueOnce([
            {
              id: 'local',
              kind: 'local',
              label: 'Local',
              status: 'online',
              active: true,
              lastSyncedAt: null,
            },
            {
              id: 'cloud:acme',
              kind: 'cloud',
              label: 'Acme Cloud',
              status: 'auth_required',
              active: false,
              baseUrl: 'https://cloud.acme.test',
              lastSyncedAt: null,
            },
          ])
          .mockResolvedValueOnce([
            {
              id: 'local',
              kind: 'local',
              label: 'Local',
              status: 'online',
              active: false,
              lastSyncedAt: null,
            },
            {
              id: 'cloud:acme',
              kind: 'cloud',
              label: 'Acme Cloud',
              status: 'online',
              active: true,
              baseUrl: 'https://cloud.acme.test',
              lastSyncedAt: '2026-05-27T10:00:00.000Z',
            },
          ]),
        activate: vi.fn(async () => ({
          id: 'cloud:acme',
          kind: 'cloud',
          label: 'Acme Cloud',
          status: 'online',
          active: true,
          baseUrl: 'https://cloud.acme.test',
          lastSyncedAt: '2026-05-27T10:00:00.000Z',
        })),
        login: vi.fn(async () => ({
          id: 'cloud:acme',
          kind: 'cloud',
          label: 'Acme Cloud',
          status: 'online',
          active: true,
          baseUrl: 'https://cloud.acme.test',
          lastSyncedAt: '2026-05-27T10:00:00.000Z',
        })),
        support: vi.fn(async (workspaceId?: string) => workspaceId === 'cloud:acme'
          ? [{
              api: 'sessions.list',
              status: 'supported',
              verdict: { allowed: true, reason: null },
            }]
          : []),
      },
      session: {
        list: sessionList,
      },
    })

    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /Local.*Online.*Local workspace - private on this device/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Acme Cloud.*Auth required/i }))

    await waitFor(() => {
      expect(window.coworkApi.workspace.login).toHaveBeenCalledWith('cloud:acme')
      expect(sessionList).toHaveBeenCalledWith({ workspaceId: 'cloud:acme' })
    })
  })

  it('restores the previous workspace when cloud login fails', async () => {
    const sessionList = vi.fn(async () => [])
    const activate = vi.fn(async (workspaceId: string) => ({
      id: workspaceId,
      kind: workspaceId === 'local' ? 'local' : 'cloud',
      label: workspaceId === 'local' ? 'Local' : 'Acme Cloud',
      status: workspaceId === 'local' ? 'online' : 'auth_required',
      active: true,
      ...(workspaceId === 'local' ? {} : { baseUrl: 'https://cloud.acme.test' }),
      lastSyncedAt: null,
    }))
    installRendererTestCoworkApi({
      workspace: {
        list: vi.fn()
          .mockResolvedValueOnce([
            {
              id: 'local',
              kind: 'local',
              label: 'Local',
              status: 'online',
              active: true,
              lastSyncedAt: null,
            },
            {
              id: 'cloud:acme',
              kind: 'cloud',
              label: 'Acme Cloud',
              status: 'auth_required',
              active: false,
              baseUrl: 'https://cloud.acme.test',
              lastSyncedAt: null,
            },
          ])
          .mockResolvedValueOnce([
            {
              id: 'local',
              kind: 'local',
              label: 'Local',
              status: 'online',
              active: true,
              lastSyncedAt: null,
            },
            {
              id: 'cloud:acme',
              kind: 'cloud',
              label: 'Acme Cloud',
              status: 'auth_required',
              active: false,
              baseUrl: 'https://cloud.acme.test',
              lastSyncedAt: null,
            },
          ]),
        activate,
        login: vi.fn(async () => {
          throw new Error('Login cancelled')
        }),
      },
      session: {
        list: sessionList,
      },
    })

    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /Local.*Online.*Local workspace - private on this device/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Acme Cloud.*Auth required/i }))

    await waitFor(() => {
      expect(window.coworkApi.workspace.login).toHaveBeenCalledWith('cloud:acme')
      expect(activate).toHaveBeenCalledWith('local')
    })
    expect(activate).not.toHaveBeenCalledWith('cloud:acme')
    expect(sessionList).toHaveBeenCalledWith({ workspaceId: 'local' })
  })

  it('explains policy-disabled cloud workspaces with workspace support verdicts', async () => {
    const support = vi.fn(async (workspaceId?: string) => workspaceId === 'cloud:acme'
      ? [{
          api: 'sessions.prompt',
          status: 'blocked_by_policy',
          verdict: {
            allowed: false,
            reason: 'Cloud chat is disabled by this workspace policy.',
          },
        }]
      : [])
    installRendererTestCoworkApi({
      workspace: {
        list: vi.fn(async () => [
          {
            id: 'local',
            kind: 'local',
            label: 'Local',
            status: 'online',
            active: false,
            lastSyncedAt: null,
          },
          {
            id: 'cloud:acme',
            kind: 'cloud',
            label: 'Acme Cloud',
            status: 'disabled',
            active: true,
            baseUrl: 'https://cloud.acme.test',
            lastSyncedAt: null,
          },
        ]),
        support,
      },
    })

    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
      />,
    )

    expect(await screen.findByRole('button', {
      name: /Acme Cloud.*Policy disabled.*Cloud chat is disabled by this workspace policy/i,
    })).toBeTruthy()
    expect(support).toHaveBeenCalledWith('cloud:acme')
  })

  it('represents Gateway workspaces without routing them through Cloud session loading', async () => {
    const sessionList = vi.fn(async () => [])
    const support = vi.fn(async (workspaceId?: string) => workspaceId === 'gateway:private'
      ? [{
          api: 'sessions.list',
          status: 'deferred',
          verdict: {
            allowed: false,
            reason: 'Desktop Gateway sessions are deferred until the Standalone Gateway API is available.',
          },
          context: {
            authority: 'gateway_standalone',
            runtimeAuthority: 'gateway_standalone',
            surface: 'gateway_standalone',
            durableStateOwner: 'gateway_control_plane',
            ownership: {
              sessions: 'gateway_control_plane',
              events: 'gateway_control_plane',
              projections: 'gateway_control_plane',
              workflows: 'gateway_control_plane',
              artifacts: 'gateway_control_plane',
              settings: 'gateway_control_plane',
              credentials: 'gateway_control_plane',
              approvals: 'gateway_control_plane',
              questions: 'gateway_control_plane',
              audit: 'gateway_control_plane',
            },
            onlineState: 'online',
            mutation: 'deferred',
            artifacts: { metadata: 'deferred', body: 'gateway_artifact_store', reveal: 'none' },
            approvals: 'gateway_standalone',
            questions: 'gateway_standalone',
            workflows: 'deferred',
            pathExposure: 'redacted_remote',
            pairingState: 'not_applicable',
          },
        }]
      : [])
    installRendererTestCoworkApi({
      workspace: {
        list: vi.fn()
          .mockResolvedValueOnce([
            {
              id: 'local',
              kind: 'local',
              authority: 'desktop_local',
              label: 'Local',
              status: 'online',
              active: true,
              lastSyncedAt: null,
            },
            {
              id: 'gateway:private',
              kind: 'gateway',
              authority: 'gateway_standalone',
              label: 'Private Gateway',
              status: 'online',
              active: false,
              baseUrl: 'https://gateway.example.test',
              lastSyncedAt: null,
            },
          ])
          .mockResolvedValueOnce([
            {
              id: 'local',
              kind: 'local',
              authority: 'desktop_local',
              label: 'Local',
              status: 'online',
              active: false,
              lastSyncedAt: null,
            },
            {
              id: 'gateway:private',
              kind: 'gateway',
              authority: 'gateway_standalone',
              label: 'Private Gateway',
              status: 'online',
              active: true,
              baseUrl: 'https://gateway.example.test',
              lastSyncedAt: null,
            },
          ]),
        activate: vi.fn(async () => ({
          id: 'gateway:private',
          kind: 'gateway',
          authority: 'gateway_standalone',
          label: 'Private Gateway',
          status: 'online',
          active: true,
          baseUrl: 'https://gateway.example.test',
          lastSyncedAt: null,
        })),
        support,
      },
      session: {
        list: sessionList,
      },
    })

    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /Local.*Online.*Local workspace - private on this device/i }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Private Gateway.*Online.*Standalone Gateway/i }))

    await waitFor(() => {
      expect(window.coworkApi.workspace.activate).toHaveBeenCalledWith('gateway:private')
    })
    expect(sessionList).toHaveBeenCalledWith({ workspaceId: 'local' })
    expect(sessionList).not.toHaveBeenCalledWith({ workspaceId: 'gateway:private' })
  })

  it('adds Gateway workspaces from the switcher without exposing the token after submit', async () => {
    const addGateway = vi.fn(async () => ({
      id: 'gateway:private',
      kind: 'gateway',
      authority: 'gateway_standalone',
      label: 'Private Gateway',
      status: 'online',
      active: false,
      baseUrl: 'https://gateway.example.test',
      lastSyncedAt: null,
    }))
    installRendererTestCoworkApi({
      workspace: {
        addGateway,
        list: vi.fn()
          .mockResolvedValueOnce([{
            id: 'local',
            kind: 'local',
            label: 'Local',
            status: 'online',
            active: true,
            lastSyncedAt: null,
          }])
          .mockResolvedValueOnce([{
            id: 'gateway:private',
            kind: 'gateway',
            authority: 'gateway_standalone',
            label: 'Private Gateway',
            status: 'online',
            active: false,
            baseUrl: 'https://gateway.example.test',
            lastSyncedAt: null,
          }]),
      },
    })

    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /Local.*Online.*Local workspace - private on this device/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Gateway workspace' }))
    fireEvent.change(screen.getByLabelText('Gateway URL'), { target: { value: 'https://gateway.example.test' } })
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Private Gateway' } })
    fireEvent.change(screen.getByLabelText('Gateway token'), { target: { value: 'secret-token' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add Gateway' }))

    await waitFor(() => {
      expect(addGateway).toHaveBeenCalledWith({
        baseUrl: 'https://gateway.example.test',
        label: 'Private Gateway',
        token: 'secret-token',
      })
    })
    expect(screen.queryByDisplayValue('secret-token')).toBeNull()
  })

  it('renders configured top and lower downstream branding surfaces', () => {
    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'icon-text',
            icon: 'AC',
            title: 'Acme AI',
            subtitle: 'Private workspace',
            ariaLabel: 'Acme AI workspace',
          },
          lower: {
            text: 'Acme internal build',
            secondaryText: 'Support from Data Platform.',
            linkLabel: 'Get help',
            linkUrl: 'https://internal.acme.example/help',
          },
        }}
      />,
    )

    expect(screen.getByText('Acme AI')).toBeTruthy()
    expect(screen.getByText('Private workspace')).toBeTruthy()
    expect(screen.getByText('Acme internal build')).toBeTruthy()
    expect(screen.getByText('Support from Data Platform.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Get help' })).toHaveAttribute('href', 'https://internal.acme.example/help')
    expect(screen.getByText('Playbooks')).toBeTruthy()
  })

  it('supports icon-only, text-only, and logo-backed top branding variants', () => {
    const { rerender } = render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'icon',
            icon: 'AC',
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(screen.getByRole('img', { name: 'Acme AI workspace' })).toBeTruthy()
    expect(screen.queryByText('Acme AI')).toBeNull()

    rerender(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'text',
            title: 'Acme AI',
            subtitle: 'Private workspace',
          },
        }}
      />,
    )

    expect(screen.getByText('Acme AI')).toBeTruthy()
    expect(screen.getByText('Private workspace')).toBeTruthy()

    rerender(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'logo-text',
            logoUrl: 'open-cowork-asset://branding/acme-logo.svg',
            title: 'Acme AI',
          },
        }}
      />,
    )

    expect(document.querySelector('img[src="open-cowork-asset://branding/acme-logo.svg"]')).toHaveStyle({
      height: '28px',
      width: '28px',
    })
    expect(screen.getByText('Acme AI')).toBeTruthy()
  })

  it('applies configured top branding media size, fit, and icon-only alignment', () => {
    const { rerender } = render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'logo',
            logoUrl: 'open-cowork-asset://branding/acme-logo.svg',
            mediaSize: 40,
            mediaFit: 'horizontal',
            mediaAlign: 'end',
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(screen.getByRole('img', { name: 'Acme AI workspace' })).toHaveClass('justify-end')
    expect(document.querySelector('img[src="open-cowork-asset://branding/acme-logo.svg"]')).toHaveStyle({
      width: '40px',
      height: 'auto',
      maxHeight: '40px',
    })

    rerender(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'logo',
            logoUrl: 'open-cowork-asset://branding/acme-logo.svg',
            mediaSize: 36,
            mediaFit: 'vertical',
            mediaAlign: 'start',
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(screen.getByRole('img', { name: 'Acme AI workspace' })).toHaveClass('justify-start')
    expect(document.querySelector('img[src="open-cowork-asset://branding/acme-logo.svg"]')).toHaveStyle({
      height: '36px',
      width: 'auto',
    })
  })

  it('clamps direct top branding media sizes to renderer-safe bounds', () => {
    const { rerender } = render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'icon',
            icon: 'AC',
            mediaSize: 8,
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(screen.getByText('AC')).toHaveStyle({
      width: '16px',
      height: '16px',
    })

    rerender(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'icon',
            icon: 'AC',
            mediaSize: 120,
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(screen.getByText('AC')).toHaveStyle({
      width: '96px',
      height: '96px',
    })
  })

  it('keeps legacy logo data URLs as a fallback', () => {
    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'logo',
            logoDataUrl: 'data:image/png;base64,AAAA',
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(document.querySelector('img[src="data:image/png;base64,AAAA"]')).toBeTruthy()
  })

  it('prefers resolved logo URLs over legacy logo data URLs', () => {
    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'logo',
            logoUrl: 'open-cowork-asset://branding/acme-logo.svg',
            logoDataUrl: 'data:image/png;base64,AAAA',
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(document.querySelector('img[src="open-cowork-asset://branding/acme-logo.svg"]')).toBeTruthy()
    expect(document.querySelector('img[src="data:image/png;base64,AAAA"]')).toBeNull()
  })

  it('falls back instead of rendering an empty top-brand card for incompatible variants', () => {
    const { rerender } = render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'text',
            icon: 'AC',
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(screen.getByRole('img', { name: 'Acme AI workspace' })).toBeTruthy()
    expect(screen.getByText('AC')).toBeTruthy()

    rerender(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'logo',
            title: 'Acme AI',
          },
        }}
      />,
    )

    expect(screen.getByText('Acme AI')).toBeTruthy()

    rerender(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          top: {
            variant: 'logo-text',
            icon: 'AC',
            ariaLabel: 'Acme AI workspace',
          },
        }}
      />,
    )

    expect(screen.getByRole('img', { name: 'Acme AI workspace' })).toBeTruthy()
    expect(screen.getByText('AC')).toBeTruthy()
  })

  it('does not render unsafe downstream sidebar links', () => {
    render(
      <Sidebar
        currentView="home"
        onViewChange={vi.fn()}
        branding={{
          lower: {
            text: 'Acme internal build',
            linkLabel: 'Unsafe help',
            linkUrl: 'http://internal.acme.example/help',
          },
        }}
      />,
    )

    expect(screen.getByText('Acme internal build')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Unsafe help' })).toBeNull()
  })

  it('does not expose deprecated operational navigation buttons', () => {
    const onViewChange = vi.fn()
    render(
      <Sidebar
        currentView="home"
        onViewChange={onViewChange}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Connections' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Governance' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pulse' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Crews' })).toBeNull()
    expect(onViewChange).not.toHaveBeenCalled()
  })
})
