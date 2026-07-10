import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuiltInAgentDetail, CustomAgentSummary } from '@open-cowork/shared'
import { useSessionStore } from '../stores/session'
import { CommandPalette } from './CommandPalette'

const buildAgent: BuiltInAgentDetail = {
  name: 'build',
  label: 'Build',
  source: 'opencode',
  mode: 'primary',
  hidden: false,
  disabled: false,
  color: 'primary',
  description: 'Builds the implementation.',
  instructions: 'Build directly.',
  skills: [],
  toolAccess: [],
  nativeToolIds: [],
  configuredToolIds: [],
}

const researchAgent: BuiltInAgentDetail = {
  name: 'research',
  label: 'Research Agent',
  source: 'open-cowork',
  mode: 'subagent',
  hidden: false,
  disabled: false,
  color: 'info',
  description: 'Researches a focused question.',
  instructions: 'Research thoroughly.',
  skills: [],
  toolAccess: [],
  nativeToolIds: [],
  configuredToolIds: [],
}

const leadCustomAgent: CustomAgentSummary = {
  scope: 'machine',
  directory: null,
  name: 'lead-writer',
  description: 'Owns long-form writing work.',
  instructions: 'Lead writing work directly.',
  skillNames: [],
  toolIds: [],
  enabled: true,
  mode: 'primary',
  color: 'accent',
  avatar: null,
  model: null,
  variant: null,
  temperature: null,
  top_p: null,
  steps: null,
  options: null,
  deniedToolPatterns: [],
  writeAccess: false,
  valid: true,
  issues: [],
}

function createDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('CommandPalette', () => {
  beforeEach(() => {
    useSessionStore.setState(useSessionStore.getInitialState(), true)
  })

  it('loads runtime agents and inserts @-mentions through a selected agent action', async () => {
    vi.mocked(window.coworkApi.app.builtinAgents).mockResolvedValue([researchAgent])
    const onClose = vi.fn()
    const onNavigate = vi.fn()
    const onEnsureSession = vi.fn(async () => true)
    const onInsertComposer = vi.fn()
    const user = userEvent.setup()

    render(
      <CommandPalette
        onClose={onClose}
        onNavigate={onNavigate}
        onCreateThread={vi.fn(async () => null)}
        onEnsureSession={onEnsureSession}
        onInsertComposer={onInsertComposer}
        onSetAgentMode={vi.fn()}
        onStartAgentChat={vi.fn()}
        onOpenSettings={vi.fn()}
        onToggleSearch={vi.fn()}
      />,
    )

    expect(screen.getByRole('dialog', { name: 'Command palette' })).toHaveAttribute('aria-modal', 'true')
    const search = screen.getByRole('searchbox', { name: 'Search command palette' })
    expect(search).toHaveAttribute('aria-controls', 'command-palette-results')
    expect(screen.getByRole('listbox', { name: 'Command palette results' })).toBeTruthy()

    await user.type(search, 'research')
    const option = await screen.findByRole('option', { name: /Research Agent/ })
    expect(option).toHaveAttribute('aria-selected', 'true')
    expect(search).toHaveAttribute('aria-activedescendant', option.id)
    await user.click(option)

    await waitFor(() => expect(onEnsureSession).toHaveBeenCalledTimes(1))
    expect(onNavigate).toHaveBeenCalledWith('chat')
    expect(onInsertComposer).toHaveBeenCalledWith('@research ')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('starts custom primary agents as chat modes instead of inserting mentions', async () => {
    vi.mocked(window.coworkApi.app.builtinAgents).mockResolvedValue([])
    vi.mocked(window.coworkApi.agents.list).mockResolvedValue([leadCustomAgent])
    const onClose = vi.fn()
    const onStartAgentChat = vi.fn()
    const onInsertComposer = vi.fn()
    const onEnsureSession = vi.fn(async () => true)
    const user = userEvent.setup()

    render(
      <CommandPalette
        onClose={onClose}
        onNavigate={vi.fn()}
        onCreateThread={vi.fn(async () => null)}
        onEnsureSession={onEnsureSession}
        onInsertComposer={onInsertComposer}
        onSetAgentMode={vi.fn()}
        onStartAgentChat={onStartAgentChat}
        onOpenSettings={vi.fn()}
        onToggleSearch={vi.fn()}
      />,
    )

    const search = screen.getByRole('searchbox', { name: 'Search command palette' })
    await user.type(search, 'lead writer')
    const option = await screen.findByRole('option', { name: /Use Lead Writer/ })
    await user.click(option)

    expect(onStartAgentChat).toHaveBeenCalledWith('lead-writer', null)
    expect(onEnsureSession).not.toHaveBeenCalled()
    expect(onInsertComposer).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes immediately after kicking off a custom primary agent chat', async () => {
    vi.mocked(window.coworkApi.app.builtinAgents).mockResolvedValue([])
    vi.mocked(window.coworkApi.agents.list).mockResolvedValue([leadCustomAgent])
    const startChat = createDeferred<void>()
    const onClose = vi.fn()
    const onStartAgentChat = vi.fn(() => startChat.promise)
    const user = userEvent.setup()

    render(
      <CommandPalette
        onClose={onClose}
        onNavigate={vi.fn()}
        onCreateThread={vi.fn(async () => null)}
        onEnsureSession={vi.fn(async () => true)}
        onInsertComposer={vi.fn()}
        onSetAgentMode={vi.fn()}
        onStartAgentChat={onStartAgentChat}
        onOpenSettings={vi.fn()}
        onToggleSearch={vi.fn()}
      />,
    )

    await user.type(screen.getByRole('searchbox', { name: 'Search command palette' }), 'lead writer')
    await user.click(await screen.findByRole('option', { name: /Use Lead Writer/ }))

    expect(onStartAgentChat).toHaveBeenCalledWith('lead-writer', null)
    expect(onClose).toHaveBeenCalledTimes(1)
    startChat.resolve()
  })

  it('persists clearing a custom primary agent before switching to a built-in mode', async () => {
    vi.mocked(window.coworkApi.app.builtinAgents).mockResolvedValue([buildAgent])
    vi.mocked(window.coworkApi.agents.list).mockResolvedValue([])
    const onSetAgentMode = vi.fn()
    const session = {
      id: 'session-1',
      title: 'Session 1',
      directory: '/tmp/project',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      composerAgentName: 'writer-lead',
    }
    useSessionStore.setState({
      currentSessionId: 'session-1',
      sessions: [session],
      sessionsByWorkspace: { local: [session] },
      sessionPrimaryAgents: { 'session-1': 'writer-lead' },
      globalErrors: [],
    })
    const user = userEvent.setup()

    render(
      <CommandPalette
        onClose={vi.fn()}
        onNavigate={vi.fn()}
        onCreateThread={vi.fn(async () => null)}
        onEnsureSession={vi.fn(async () => true)}
        onInsertComposer={vi.fn()}
        onSetAgentMode={onSetAgentMode}
        onStartAgentChat={vi.fn()}
        onOpenSettings={vi.fn()}
        onToggleSearch={vi.fn()}
      />,
    )

    await user.type(screen.getByRole('searchbox', { name: 'Search command palette' }), 'build')
    await user.click(await screen.findByRole('option', { name: /Use Build/ }))

    await waitFor(() => expect(window.coworkApi.session.setComposerPreferences).toHaveBeenCalledWith(
      'session-1',
      { agentName: null },
    ))
    expect(useSessionStore.getState().sessions[0]?.composerAgentName).toBeNull()
    expect(onSetAgentMode).toHaveBeenCalledWith('build')
  })

  it('keeps retired operational destinations out of the command palette', async () => {
    const onClose = vi.fn()
    const onNavigate = vi.fn()
    const user = userEvent.setup()

    render(
      <CommandPalette
        onClose={onClose}
        onNavigate={onNavigate}
        onCreateThread={vi.fn(async () => null)}
        onEnsureSession={vi.fn(async () => true)}
        onInsertComposer={vi.fn()}
        onSetAgentMode={vi.fn()}
        onStartAgentChat={vi.fn()}
        onOpenSettings={vi.fn()}
        onToggleSearch={vi.fn()}
      />,
    )

    const search = screen.getByRole('searchbox', { name: 'Search command palette' })
    await user.type(search, 'governance')

    expect(screen.queryByRole('option', { name: /Governance/ })).not.toBeInTheDocument()
    expect(onNavigate).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('navigates to Knowledge from the Go To section', async () => {
    const onClose = vi.fn()
    const onNavigate = vi.fn()
    const user = userEvent.setup()

    render(
      <CommandPalette
        onClose={onClose}
        onNavigate={onNavigate}
        onCreateThread={vi.fn(async () => null)}
        onEnsureSession={vi.fn(async () => true)}
        onInsertComposer={vi.fn()}
        onSetAgentMode={vi.fn()}
        onStartAgentChat={vi.fn()}
        onOpenSettings={vi.fn()}
        onToggleSearch={vi.fn()}
      />,
    )

    const search = screen.getByRole('searchbox', { name: 'Search command palette' })
    await user.type(search, 'knowledge')
    const option = await screen.findByRole('option', { name: /Knowledge/ })
    await user.click(option)

    expect(onNavigate).toHaveBeenCalledWith('knowledge')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('drops Go To entries for feature-disabled product areas so the palette matches the sidebar', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()

    render(
      <CommandPalette
        onClose={vi.fn()}
        features={{ channels: false, knowledge: false }}
        onNavigate={onNavigate}
        onCreateThread={vi.fn(async () => null)}
        onEnsureSession={vi.fn(async () => true)}
        onInsertComposer={vi.fn()}
        onSetAgentMode={vi.fn()}
        onStartAgentChat={vi.fn()}
        onOpenSettings={vi.fn()}
        onToggleSearch={vi.fn()}
      />,
    )

    const search = screen.getByRole('searchbox', { name: 'Search command palette' })
    await user.type(search, 'channels')
    expect(screen.queryByRole('option', { name: /Channels/ })).not.toBeInTheDocument()

    await user.clear(search)
    await user.type(search, 'knowledge')
    expect(screen.queryByRole('option', { name: /Knowledge/ })).not.toBeInTheDocument()

    // Ungated destinations stay available.
    await user.clear(search)
    await user.type(search, 'health')
    expect(await screen.findByRole('option', { name: /Health Center/ })).toBeInTheDocument()
    expect(onNavigate).not.toHaveBeenCalled()
  })
})
