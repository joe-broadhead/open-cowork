import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AutomationCreateWizard } from './AutomationCreateWizard'
import { createDefaultDraft, type AutomationAgentOption, type DraftState } from './automations-page-support'

function draft(overrides: Partial<DraftState> = {}) {
  return {
    ...createDefaultDraft(),
    ...overrides,
  }
}

function renderWizard(options: {
  defaults?: Partial<DraftState>
  onCreate?: (draft: DraftState) => Promise<void>
  onClose?: () => void
  agentOptions?: AutomationAgentOption[]
} = {}) {
  const onCreate = vi.fn(options.onCreate || (async () => undefined))
  const onClose = vi.fn(options.onClose || (() => undefined))
  const loadAgentOptions = vi.fn(async () => options.agentOptions || [])

  render(
    <AutomationCreateWizard
      defaults={draft(options.defaults)}
      onCreate={onCreate}
      onClose={onClose}
      loadAgentOptions={loadAgentOptions}
    />,
  )

  return { loadAgentOptions, onClose, onCreate }
}

describe('AutomationCreateWizard', () => {
  it('requires a title and goal before moving to schedule details', async () => {
    const user = userEvent.setup()
    renderWizard()

    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Add a title and goal before choosing schedule details.')
    expect(screen.getByRole('heading', { name: 'What & Why' })).toBeInTheDocument()
  })

  it('blocks scoped execution without a selected project directory', async () => {
    const user = userEvent.setup()
    renderWizard()

    await user.type(screen.getByLabelText('Title'), 'Scoped roadmap')
    await user.type(screen.getByLabelText('Goal'), 'Keep the project roadmap current.')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: /Scoped execution/ }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Scoped execution automations require a project directory.')
    expect(screen.getByRole('heading', { name: 'When & How' })).toBeInTheDocument()
  })

  it('creates an automation with the completed wizard draft', async () => {
    const user = userEvent.setup()
    const { onClose, onCreate } = renderWizard()

    await user.type(screen.getByLabelText('Title'), 'Weekly market review')
    await user.type(screen.getByLabelText('Goal'), 'Summarize market movement before the Monday planning meeting.')
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Create automation' }))

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    expect(onCreate.mock.calls[0]?.[0]).toMatchObject({
      title: 'Weekly market review',
      goal: 'Summarize market movement before the Monday planning meeting.',
      scheduleType: 'weekly',
      executionMode: 'planning_only',
      autonomyPolicy: 'review-first',
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('persists advanced specialist selections into the submitted draft', async () => {
    const user = userEvent.setup()
    const { loadAgentOptions, onCreate } = renderWizard({
      defaults: {
        title: 'Specialist review',
        goal: 'Route the weekly review through the research specialist.',
      },
      agentOptions: [
        {
          id: 'researcher',
          label: 'Researcher',
          description: 'Finds source material.',
          source: 'builtin',
        },
      ],
    })

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Show advanced settings' }))
    await user.click(await screen.findByRole('button', { name: /Researcher/ }))
    await waitFor(() => expect(loadAgentOptions).toHaveBeenLastCalledWith(expect.any(String), ['researcher']))
    await user.click(screen.getByRole('button', { name: 'Create automation' }))

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    expect(onCreate.mock.calls[0]?.[0].preferredAgentNames).toEqual(['researcher'])
    expect(loadAgentOptions).toHaveBeenCalledWith(expect.any(String), [])
  })
})
