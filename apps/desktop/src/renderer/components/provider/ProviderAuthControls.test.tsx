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
      instructions: '',
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
    expect(window.coworkApi.provider.callback).toHaveBeenCalledWith('openai', 0)
    expect(window.coworkApi.runtime.restart).not.toHaveBeenCalled()
    expect(screen.getByText('Provider login completed.')).toBeTruthy()
  })

  it('shows and copies auto auth instructions for device-code providers', async () => {
    vi.mocked(window.coworkApi.provider.authMethods).mockResolvedValue({
      'github-copilot': [{ type: 'oauth', label: 'GitHub Copilot' }],
    })
    vi.mocked(window.coworkApi.provider.authorize).mockResolvedValue({
      url: 'https://github.com/login/device',
      method: 'auto',
      instructions: 'Enter code ABCD 1234 at https://github.com/login/device',
    })
    const user = userEvent.setup()

    render(
      <ProviderAuthControls
        providerId="github-copilot"
        providerName="GitHub Copilot"
        connected={false}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Sign in with GitHub Copilot' }))

    expect(screen.getByText('Browser login opened. Follow the instructions below, then return here and confirm so Open Cowork can verify the new login.')).toBeTruthy()
    expect(screen.getByText('Login instructions')).toBeTruthy()
    expect(screen.getByText('Enter code ABCD 1234 at https://github.com/login/device')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(window.coworkApi.clipboard.writeText).toHaveBeenCalledWith('ABCD-1234')
    expect(screen.getByText('Login instructions copied to clipboard.')).toBeTruthy()
  })

  it('copies full browser auth instructions when no device code is present', async () => {
    vi.mocked(window.coworkApi.provider.authMethods).mockResolvedValue({
      'github-copilot': [{ type: 'oauth', label: 'GitHub Copilot' }],
    })
    vi.mocked(window.coworkApi.provider.authorize).mockResolvedValue({
      url: 'https://github.com/login/device',
      method: 'auto',
      instructions: 'Open the browser, choose Continue, then return to Open Cowork.',
    })
    const user = userEvent.setup()

    render(
      <ProviderAuthControls
        providerId="github-copilot"
        providerName="GitHub Copilot"
        connected={false}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Sign in with GitHub Copilot' }))
    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(window.coworkApi.clipboard.writeText).toHaveBeenCalledWith('Open the browser, choose Continue, then return to Open Cowork.')
  })

  it('accepts already-consumed browser auth callbacks when provider verification succeeds', async () => {
    vi.mocked(window.coworkApi.provider.authMethods).mockResolvedValue({
      openai: [browserMethod],
    })
    vi.mocked(window.coworkApi.provider.authorize).mockResolvedValue({
      url: 'https://auth.example.test',
      method: 'auto',
      instructions: '',
    })
    vi.mocked(window.coworkApi.provider.callback).mockRejectedValueOnce(new Error('callback already consumed'))
    vi.mocked(window.coworkApi.provider.list).mockResolvedValue([
      { id: 'openai', name: 'OpenAI', connected: true },
    ])
    const onAuthUpdated = vi.fn()
    const user = userEvent.setup()

    render(
      <ProviderAuthControls
        providerId="openai"
        providerName="OpenAI"
        connected={false}
        onAuthUpdated={onAuthUpdated}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }))
    await user.click(screen.getByRole('button', { name: "I've finished signing in" }))

    await waitFor(() => expect(onAuthUpdated).toHaveBeenCalledTimes(1))
    expect(window.coworkApi.provider.callback).toHaveBeenCalledWith('openai', 0)
    expect(screen.getByText('Provider login completed.')).toBeTruthy()
  })

  it('can clear stale OpenCode-native provider auth before a fresh login', async () => {
    vi.mocked(window.coworkApi.provider.authMethods).mockResolvedValue({
      openai: [browserMethod],
    })
    const onAuthUpdated = vi.fn()
    const user = userEvent.setup()

    render(
      <ProviderAuthControls
        providerId="openai"
        providerName="OpenAI"
        connected
        onAuthUpdated={onAuthUpdated}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Forget login' }))

    await waitFor(() => expect(window.coworkApi.provider.logout).toHaveBeenCalledWith('openai'))
    expect(onAuthUpdated).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Provider login removed. Sign in again to refresh the token.')).toBeTruthy()
  })
})
