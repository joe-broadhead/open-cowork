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
    vi.mocked(window.coworkApi.provider.callback).mockResolvedValue(true)
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
    expect(screen.getByText('Finish in your browser.')).toBeTruthy()
    expect(screen.queryByText('Browser login opened. Complete the flow there, then return here and confirm so Open Cowork can verify the new login.')).toBeNull()

    await user.click(screen.getByRole('button', { name: "I've finished signing in" }))

    expect(window.coworkApi.provider.callback).toHaveBeenCalledWith('openai', 0)
    await waitFor(() => expect(onAuthUpdated).toHaveBeenCalledTimes(1))
    expect(window.coworkApi.runtime.restart).not.toHaveBeenCalled()
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

  it('shows and copies auto authorization instructions returned by OpenCode', async () => {
    const instructions = 'Enter code XXXX-YYYY at github.com/login/device.'
    vi.mocked(window.coworkApi.provider.authMethods).mockResolvedValue({
      'github-copilot': [browserMethod],
    })
    vi.mocked(window.coworkApi.provider.authorize).mockResolvedValue({
      url: 'https://github.com/login/device',
      method: 'auto',
      instructions,
    })
    const user = userEvent.setup()

    render(
      <ProviderAuthControls
        providerId="github-copilot"
        providerName="GitHub Copilot"
        connected={false}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }))

    expect(screen.getByText(instructions)).toBeTruthy()
    expect(screen.queryByText('Browser login opened. Complete the flow there, then return here and confirm so Open Cowork can verify the new login.')).toBeNull()
    expect(screen.getByRole('button', { name: "I've finished signing in" })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Copy code' }))

    expect(window.coworkApi.clipboard.writeText).toHaveBeenCalledWith('XXXX-YYYY')
  })

  it('copies spaced GitHub device codes as normalized authorization codes', async () => {
    const instructions = 'Copy your one-time code ABCD EFGH, then visit https://github.com/login/device.'
    vi.mocked(window.coworkApi.provider.authMethods).mockResolvedValue({
      'github-copilot': [browserMethod],
    })
    vi.mocked(window.coworkApi.provider.authorize).mockResolvedValue({
      url: 'https://github.com/login/device',
      method: 'auto',
      instructions,
    })
    const user = userEvent.setup()

    render(
      <ProviderAuthControls
        providerId="github-copilot"
        providerName="GitHub Copilot"
        connected={false}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }))
    await user.click(screen.getByRole('button', { name: 'Copy code' }))

    expect(window.coworkApi.clipboard.writeText).toHaveBeenCalledWith('ABCD-EFGH')
  })

  it('falls back to the full instructions when no device code can be detected', async () => {
    const instructions = 'Finish signing in from the browser window.'
    vi.mocked(window.coworkApi.provider.authMethods).mockResolvedValue({
      openai: [browserMethod],
    })
    vi.mocked(window.coworkApi.provider.authorize).mockResolvedValue({
      url: 'https://auth.example.test',
      method: 'auto',
      instructions,
    })
    const user = userEvent.setup()

    render(
      <ProviderAuthControls
        providerId="openai"
        providerName="OpenAI"
        connected={false}
      />,
    )

    await user.click(await screen.findByRole('button', { name: 'Sign in with ChatGPT' }))
    await user.click(screen.getByRole('button', { name: 'Copy' }))

    expect(window.coworkApi.clipboard.writeText).toHaveBeenCalledWith(instructions)
  })

  it('still verifies browser login when the callback endpoint is already consumed', async () => {
    vi.mocked(window.coworkApi.provider.authMethods).mockResolvedValue({
      openai: [browserMethod],
    })
    vi.mocked(window.coworkApi.provider.authorize).mockResolvedValue({
      url: 'https://auth.example.test',
      method: 'auto',
      instructions: 'Finish in your browser.',
    })
    vi.mocked(window.coworkApi.provider.callback).mockRejectedValue(new Error('Callback already completed.'))
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
    expect(screen.getByText('Provider login completed.')).toBeTruthy()
  })
})
