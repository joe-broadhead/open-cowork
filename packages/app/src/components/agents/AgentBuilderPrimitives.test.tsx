import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CustomAgentConfig, ProviderDescriptor } from '@open-cowork/shared'
import {
  InferenceTab,
  ScopeRow,
  WorkbenchTabs,
  resolveAgentBuilderModelSelection,
} from './AgentBuilderPrimitives'

// The canonical <Select> renders a custom listbox: a trigger <button> whose
// accessible name is "<label>: <selectedLabel>", and an opened role="listbox"
// of role="option" buttons. It does not respond to fireEvent.change, so we open
// the trigger and click the matching option to drive a selection.
function selectTrigger(labelPrefix: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${labelPrefix}:`) })
}

function openSelect(labelPrefix: string): void {
  fireEvent.click(selectTrigger(labelPrefix))
}

function pickFromSelect(labelPrefix: string, optionName: string | RegExp): void {
  openSelect(labelPrefix)
  fireEvent.click(screen.getByRole('option', { name: optionName }))
}

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

const providers: ProviderDescriptor[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Aggregated model catalog.',
    credentials: [],
    connected: true,
    defaultModel: 'anthropic/claude-sonnet-4',
    models: [
      {
        id: 'anthropic/claude-sonnet-4',
        name: 'Claude Sonnet 4',
        featured: true,
        reasoning: true,
        variants: ['standard', 'reasoning'],
        limit: { context: 200_000 },
        cost: { input: 3, output: 15 },
      },
    ],
  },
  {
    id: 'google',
    name: 'Google',
    description: 'Gemini provider.',
    credentials: [],
    connected: false,
    models: [
      {
        id: 'gemini-pro',
        name: 'Gemini Pro',
        limit: { context: 1_000_000 },
      },
    ],
  },
]

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

    fireEvent.click(screen.getByRole('radio', { name: 'Project' }))
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
    render(
      <InferenceTab
        draft={{ ...draft, model: 'openrouter/anthropic/claude-sonnet-4', variant: 'reasoning' }}
        providers={providers}
        defaultProviderId="openrouter"
        onChange={onChange}
      />,
    )

    pickFromSelect('Model', /Claude Sonnet 4/)
    pickFromSelect('Variant', 'Provider default')
    fireEvent.click(screen.getByRole('button', { name: /Advanced model ID/ }))
    fireEvent.change(screen.getByLabelText('Advanced model ID'), {
      target: { value: 'openrouter/meta/llama-3' },
    })
    fireEvent.change(screen.getByLabelText('Temperature'), {
      target: { value: '0.7' },
    })
    fireEvent.change(screen.getByLabelText('Max steps'), {
      target: { value: '4.6' },
    })

    expect(onChange).toHaveBeenCalledWith({ model: 'openrouter/anthropic/claude-sonnet-4', variant: null })
    expect(onChange).toHaveBeenCalledWith({ variant: null })
    expect(onChange).toHaveBeenCalledWith({ model: 'openrouter/meta/llama-3' })
    expect(onChange).toHaveBeenCalledWith({ temperature: 0.7 })
    expect(onChange).toHaveBeenCalledWith({ steps: 5 })
  })

  it('surfaces unconnected providers without fabricating models', () => {
    const onChange = vi.fn()
    render(
      <InferenceTab
        draft={{ ...draft, model: 'google/gemini-pro' }}
        providers={providers}
        defaultProviderId="openrouter"
        onChange={onChange}
      />,
    )

    expect(screen.getByText('Google is not connected')).toBeInTheDocument()
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument()
  })

  it('does not persist a hidden model when selecting an unconnected provider', () => {
    const onChange = vi.fn()
    render(
      <InferenceTab
        draft={{ ...draft, model: null }}
        providers={providers}
        defaultProviderId="openrouter"
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Google/ }))

    expect(screen.getByText('Google is not connected')).toBeInTheDocument()
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument()
    expect(onChange).toHaveBeenCalledWith({ model: null, variant: null })
  })

  it('keeps inherited models visibly unpinned and preserves uncataloged variants', () => {
    const onChange = vi.fn()
    const { rerender } = render(
      <InferenceTab
        draft={{ ...draft, model: null }}
        providers={providers}
        defaultProviderId="openrouter"
        onChange={onChange}
      />,
    )

    expect(selectTrigger('Model')).toHaveAccessibleName('Model: Inherit session default')

    rerender(
      <InferenceTab
        draft={{ ...draft, model: 'openrouter/meta/llama-3', variant: 'json' }}
        providers={providers}
        defaultProviderId="openrouter"
        onChange={onChange}
      />,
    )

    const advancedVariant = screen.getByLabelText('Advanced variant')
    expect(advancedVariant).toHaveValue('json')
    fireEvent.change(advancedVariant, { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith({ variant: null })
  })

  it('surfaces saved uncataloged model overrides instead of showing inheritance', async () => {
    const onChange = vi.fn()
    render(
      <InferenceTab
        draft={{ ...draft, model: 'openrouter/meta/llama-3', variant: null }}
        providers={providers}
        defaultProviderId="openrouter"
        onChange={onChange}
      />,
    )

    expect(selectTrigger('Model')).toHaveAccessibleName('Model: Uncataloged: meta/llama-3')
    openSelect('Model')
    expect(screen.getByRole('option', { name: 'Uncataloged: meta/llama-3' })).toBeInTheDocument()
    expect(await screen.findByLabelText('Advanced model ID')).toHaveValue('openrouter/meta/llama-3')
  })

  it('does not persist a reasoning variant from reasoning metadata alone', () => {
    const onChange = vi.fn()
    render(
      <InferenceTab
        draft={{ ...draft, model: 'openrouter/reasoning-only' }}
        providers={[{
          ...providers[0]!,
          models: [{
            id: 'reasoning-only',
            name: 'Reasoning Only',
            reasoning: true,
            limit: { context: 128_000 },
          }],
        }]}
        defaultProviderId="openrouter"
        onChange={onChange}
      />,
    )

    expect(screen.getByText('Reasoning')).toBeInTheDocument()
    expect(screen.queryByLabelText('Variant')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Advanced model ID/ }))
    expect(screen.getByLabelText('Advanced variant')).toBeInTheDocument()
  })

  it('keeps existing provider models when catalog refresh returns no models', async () => {
    const onChange = vi.fn()
    const refreshProviderCatalog = vi.fn(async () => [])
    render(
      <InferenceTab
        draft={{ ...draft, model: 'openrouter/anthropic/claude-sonnet-4' }}
        providers={providers}
        defaultProviderId="openrouter"
        onRefreshProviderCatalog={refreshProviderCatalog}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(refreshProviderCatalog).toHaveBeenCalledWith('openrouter'))
    expect(selectTrigger('Model')).not.toBeDisabled()
    openSelect('Model')
    expect(screen.getByRole('option', { name: /Claude Sonnet 4/ })).toBeInTheDocument()
    expect(screen.queryByText(/No catalog models are loaded/)).not.toBeInTheDocument()
  })

  it('merges refreshed provider models without dropping configured models', async () => {
    const onChange = vi.fn()
    const refreshProviderCatalog = vi.fn(async () => [{
      id: 'meta/llama-3',
      name: 'Llama 3',
      limit: { context: 128_000 },
    }])
    render(
      <InferenceTab
        draft={{ ...draft, model: 'openrouter/anthropic/claude-sonnet-4' }}
        providers={providers}
        defaultProviderId="openrouter"
        onRefreshProviderCatalog={refreshProviderCatalog}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    await waitFor(() => expect(refreshProviderCatalog).toHaveBeenCalledWith('openrouter'))
    openSelect('Model')
    expect(screen.getByRole('option', { name: /Claude Sonnet 4/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Llama 3/ })).toBeInTheDocument()
  })

  it('keeps an empty dynamic provider selected so it can be refreshed', async () => {
    const onChange = vi.fn()
    const refreshProviderCatalog = vi.fn(async () => [])
    render(
      <InferenceTab
        draft={{ ...draft, model: null }}
        providers={[
          ...providers,
          {
            id: 'dynamic',
            name: 'Dynamic',
            description: 'Loads models on demand.',
            credentials: [],
            connected: true,
            models: [],
          },
        ]}
        defaultProviderId="openrouter"
        onRefreshProviderCatalog={refreshProviderCatalog}
        onChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Dynamic/ }))

    expect(screen.getByRole('button', { name: /Dynamic/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(/No catalog models are loaded/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(refreshProviderCatalog).toHaveBeenCalledWith('dynamic'))
    expect(onChange).toHaveBeenCalledWith({ model: null, variant: null })
  })

  it('resolves provider-prefixed catalog model ids', () => {
    const providerPrefixedProviders: ProviderDescriptor[] = [{
      ...providers[0]!,
      models: [{
        id: 'openrouter/anthropic/claude-sonnet-4',
        name: 'Claude Sonnet 4',
        limit: { context: 200_000 },
      }],
    }]

    const selection = resolveAgentBuilderModelSelection(
      'openrouter/anthropic/claude-sonnet-4',
      providerPrefixedProviders,
      'openrouter',
    )

    expect(selection.modelId).toBe('openrouter/anthropic/claude-sonnet-4')
    expect(selection.model?.name).toBe('Claude Sonnet 4')
  })

  it('ignores invalid numeric inference values', () => {
    const onChange = vi.fn()
    render(<InferenceTab draft={{ ...draft, temperature: 1, steps: 3 }} onChange={onChange} />)

    fireEvent.change(screen.getByLabelText('Temperature'), {
      target: { value: '' },
    })
    fireEvent.change(screen.getByLabelText('Max steps'), {
      target: { value: '0' },
    })

    expect(onChange).toHaveBeenCalledWith({ temperature: null })
    expect(onChange).toHaveBeenCalledWith({ steps: null })
  })
})
