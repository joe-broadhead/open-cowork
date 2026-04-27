import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderAuthMethod } from '@open-cowork/shared'
import { ProviderAuthControls } from './ProviderAuthControls'

const browserMethod: ProviderAuthMethod = {
  type: 'oauth',
  label: 'ChatGPT',
}

describe('ProviderAuthControls', () => {
  it('drives the OpenCode-native browser auth flow and verifies provider connection', async () => {
    vi.mocked(window.coworkApi.provider.authMethods).mockResolvedValue({
      openai: [browserMethod],
    })
    vi.mocked(window.coworkApi.provider.authorize).mockResolvedValue({
      url: 'https://auth.example.test',
      method: 'auto',
      instructions: 'Finish in your browser.',
    })
    vi.mocked(window.coworkApi.provider.list).mockResolvedValue([
      { id: 'openai', name: 'OpenAI', connected: true },
    ])
    const onBeforeAuthorize = vi.fn(async () => true)
    const onAuthUpdated = vi.fn()
    const user = userEvent.setup()

    render(
      <ProviderAuthControls
        providerId="openai"
        providerName="OpenAI"
        connected={false}
        onBeforeAuthorize={onBeforeAuthorize}
        onAuthUpdated={onAuthUpdated}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }))

    expect(onBeforeAuthorize).toHaveBeenCalledTimes(1)
    expect(window.coworkApi.provider.authorize).toHaveBeenCalledWith('openai', 0, {})
    expect(screen.getByText('Browser login opened. Complete the flow there, then return here and confirm so Open Cowork can verify the new login.')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: "I've finished signing in" }))

    await waitFor(() => expect(onAuthUpdated).toHaveBeenCalledTimes(1))
    expect(window.coworkApi.runtime.restart).not.toHaveBeenCalled()
    expect(screen.getByText('Provider login completed.')).toBeTruthy()
  })
})
