import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderDescriptor } from '@open-cowork/shared'
import { SetupModelCatalog } from './SetupModelCatalog'

const provider: ProviderDescriptor = {
  id: 'openrouter',
  name: 'OpenRouter',
  description: 'Model catalog',
  connected: true,
  credentials: [],
  defaultModel: 'vendor/model-20',
  models: Array.from({ length: 45 }, (_value, index) => ({
    id: `vendor/model-${index}`,
    name: index === 44 ? 'Needle Reasoner' : `Catalog Model ${index}`,
    featured: index === 42,
  })),
}

describe('SetupModelCatalog', () => {
  it('starts with a small recommended set led by the provider default', () => {
    render(<SetupModelCatalog provider={provider} selectedModelId="" onSelect={vi.fn()} />)

    expect(screen.getByRole('button', { name: /Catalog Model 20/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Catalog Model 42/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Catalog Model 0/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Needle Reasoner/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Catalog Model/ })).toHaveLength(2)
    expect(screen.getByText('2 recommended models')).toBeInTheDocument()
  })

  it('searches by display name, model id, and provider, then paginates the full catalog accessibly', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    render(<SetupModelCatalog provider={provider} selectedModelId="" onSelect={onSelect} />)

    const search = screen.getByRole('searchbox', { name: 'Search models' })
    await user.type(search, 'Needle Reasoner')
    await user.click(screen.getByRole('button', { name: /Needle Reasoner/ }))
    expect(onSelect).toHaveBeenCalledWith('vendor/model-44')

    await user.clear(search)
    await user.type(search, 'vendor/model-19')
    expect(screen.getByRole('button', { name: /Catalog Model 19/ })).toBeInTheDocument()

    await user.clear(search)
    await user.type(search, 'OpenRouter')
    expect(screen.getByText('30 of 45 models')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show 15 more models' }))
    expect(screen.getByText('45 of 45 models')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Needle Reasoner/ })).toBeInTheDocument()
  })

  it('resets browsing state when the provider changes', async () => {
    const user = userEvent.setup()
    const { rerender } = render(
      <SetupModelCatalog provider={provider} selectedModelId="" onSelect={vi.fn()} />,
    )
    await user.type(screen.getByRole('searchbox', { name: 'Search models' }), 'Needle')
    expect(screen.getByRole('button', { name: /Needle Reasoner/ })).toBeInTheDocument()

    const nextProvider: ProviderDescriptor = {
      ...provider,
      id: 'acme',
      name: 'Acme',
      defaultModel: 'acme/default',
      models: [{ id: 'acme/default', name: 'Acme Default', featured: true }],
    }
    rerender(<SetupModelCatalog provider={nextProvider} selectedModelId="" onSelect={vi.fn()} />)

    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search models' })).toHaveValue(''))
    expect(screen.getByRole('button', { name: /Acme Default/ })).toBeInTheDocument()
    expect(screen.getByText('1 recommended model')).toBeInTheDocument()
  })
})
