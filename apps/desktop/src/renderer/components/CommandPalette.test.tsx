import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { BuiltInAgentDetail } from '@open-cowork/shared'
import { CommandPalette } from './CommandPalette'

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

describe('CommandPalette', () => {
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
        onOpenSettings={vi.fn()}
        onToggleSearch={vi.fn()}
      />,
    )

    await user.type(screen.getByPlaceholderText('Search actions, agents, and commands...'), 'research')
    await user.click(await screen.findByText('Research Agent'))

    await waitFor(() => expect(onEnsureSession).toHaveBeenCalledTimes(1))
    expect(onNavigate).toHaveBeenCalledWith('chat')
    expect(onInsertComposer).toHaveBeenCalledWith('@research ')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
