import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BuiltInAgentDetail } from '@open-cowork/shared'
import { HomePage } from './HomePage'

const researchAgent: BuiltInAgentDetail = {
  name: 'research',
  label: 'Research',
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

describe('HomePage', () => {
  it('keeps upstream Home copy as the default', async () => {
    render(
      <HomePage
        brandName="Open Cowork"
        onStartThread={vi.fn(async () => undefined)}
        onOpenPulse={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    )

    expect(screen.getByText('What shall we cowork on today?')).toBeTruthy()
    expect(screen.getByText('Open Cowork · Ask anything, or @mention an agent')).toBeTruthy()
    expect(screen.getByPlaceholderText('Ask anything, or @mention an agent')).toBeTruthy()
    await waitFor(() => expect(window.coworkApi.app.builtinAgents).toHaveBeenCalledTimes(1))
  })

  it('renders downstream-configured Home copy without changing agent suggestions', async () => {
    vi.mocked(window.coworkApi.app.builtinAgents).mockResolvedValue([researchAgent])

    render(
      <HomePage
        brandName="Acme Cowork"
        homeBranding={{
          greeting: 'What should {{brand}} work on today?',
          subtitle: 'Ask a question or delegate to an approved agent.',
          composerPlaceholder: 'Ask {{brand}} anything',
          suggestionLabel: 'Start with',
          statusReadyLabel: 'Online',
        }}
        onStartThread={vi.fn(async () => undefined)}
        onOpenPulse={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    )

    expect(screen.getByText('What should Acme Cowork work on today?')).toBeTruthy()
    expect(screen.getByText('Ask a question or delegate to an approved agent.')).toBeTruthy()
    expect(screen.getByPlaceholderText('Ask Acme Cowork anything')).toBeTruthy()
    expect(await screen.findByText('Start with')).toBeTruthy()
    expect(screen.getByText('@Research')).toBeTruthy()
    expect(screen.getByText('Online')).toBeTruthy()
  })
})
