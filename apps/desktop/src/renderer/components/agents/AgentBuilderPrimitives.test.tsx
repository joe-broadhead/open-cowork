import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CustomAgentConfig } from '@open-cowork/shared'
import { InferenceTab, ScopeRow, WorkbenchTabs } from './AgentBuilderPrimitives'

const draft: CustomAgentConfig = {
  scope: 'machine',
  name: 'analyst',
  description: 'Analyze metrics.',
  instructions: 'Use canonical metrics.',
  skillNames: ['analyst'],
  toolIds: ['warehouse'],
  enabled: true,
  color: 'accent',
  model: null,
  variant: null,
  temperature: null,
  steps: null,
}

describe('AgentBuilderPrimitives', () => {
  it('switches workbench tabs', () => {
    const onChange = vi.fn()
    render(<WorkbenchTabs tab="instructions" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Capabilities' }))

    expect(onChange).toHaveBeenCalledWith('capabilities')
    expect(screen.getByRole('button', { name: 'Instructions' })).toHaveStyle({
      color: 'var(--color-text)',
    })
  })

  it('changes scope and prompts for project directories', () => {
    const onScopeChange = vi.fn()
    const onChooseDirectory = vi.fn()
    const { rerender } = render(
      <ScopeRow
        draft={draft}
        projectTargetDirectory={null}
        onScopeChange={onScopeChange}
        onChooseDirectory={onChooseDirectory}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Project' }))
    expect(onScopeChange).toHaveBeenCalledWith('project')

    rerender(
      <ScopeRow
        draft={{ ...draft, scope: 'project' }}
        projectTargetDirectory={null}
        onScopeChange={onScopeChange}
        onChooseDirectory={onChooseDirectory}
      />,
    )
    expect(screen.getByText('Choose a project directory')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Choose directory' }))
    expect(onChooseDirectory).toHaveBeenCalledTimes(1)
  })

  it('normalizes inference updates', () => {
    const onChange = vi.fn()
    render(<InferenceTab draft={{ ...draft, variant: 'reasoning' }} onChange={onChange} />)

    fireEvent.change(screen.getByPlaceholderText('openrouter/anthropic/claude-sonnet-4'), {
      target: { value: 'openrouter/anthropic/claude-sonnet-4' },
    })
    fireEvent.change(screen.getByPlaceholderText('reasoning'), {
      target: { value: '' },
    })
    fireEvent.change(screen.getByPlaceholderText('0.0 – 2.0'), {
      target: { value: '0.7' },
    })
    fireEvent.change(screen.getByPlaceholderText('20'), {
      target: { value: '4.6' },
    })

    expect(onChange).toHaveBeenCalledWith({ model: 'openrouter/anthropic/claude-sonnet-4' })
    expect(onChange).toHaveBeenCalledWith({ variant: null })
    expect(onChange).toHaveBeenCalledWith({ temperature: 0.7 })
    expect(onChange).toHaveBeenCalledWith({ steps: 5 })
  })

  it('ignores invalid numeric inference values', () => {
    const onChange = vi.fn()
    render(<InferenceTab draft={{ ...draft, temperature: 1, steps: 3 }} onChange={onChange} />)

    fireEvent.change(screen.getByPlaceholderText('0.0 – 2.0'), {
      target: { value: '' },
    })
    fireEvent.change(screen.getByPlaceholderText('20'), {
      target: { value: '0' },
    })

    expect(onChange).toHaveBeenCalledWith({ temperature: null })
    expect(onChange).toHaveBeenCalledWith({ steps: null })
  })
})
