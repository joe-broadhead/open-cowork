import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AuthState } from '@open-cowork/shared'
import { installRendererTestCoworkApi } from '../test/setup'
import { LoginScreen } from './LoginScreen'

function installAuthLogin(login: () => Promise<AuthState>) {
  installRendererTestCoworkApi({
    auth: {
      login: vi.fn(login),
    },
  })

  return vi.mocked(window.coworkApi.auth.login)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('LoginScreen', () => {
  it('calls onLoggedIn with the authenticated account email', async () => {
    const user = userEvent.setup()
    const login = installAuthLogin(async () => ({
      authenticated: true,
      email: 'user@example.com',
    }))
    const onLoggedIn = vi.fn()

    render(<LoginScreen brandName="Open Cowork" onLoggedIn={onLoggedIn} />)

    expect(screen.getByRole('heading', { name: 'Open Cowork' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Continue' }))

    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith('user@example.com'))
    expect(login).toHaveBeenCalledTimes(1)
  })

  it('shows the cancellation error without completing login', async () => {
    const user = userEvent.setup()
    installAuthLogin(async () => ({
      authenticated: false,
      email: null,
    }))
    const onLoggedIn = vi.fn()

    render(<LoginScreen brandName="Open Cowork" onLoggedIn={onLoggedIn} />)

    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Login was cancelled or failed. Please try again.')).toBeInTheDocument()
    expect(onLoggedIn).not.toHaveBeenCalled()
  })

  it('shows thrown login errors and re-enables the login button', async () => {
    const user = userEvent.setup()
    installAuthLogin(async () => {
      throw new Error('Browser profile is unavailable.')
    })

    render(<LoginScreen brandName="Open Cowork" onLoggedIn={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText('Browser profile is unavailable.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
  })

  it('disables the login button while waiting for the browser callback', async () => {
    const user = userEvent.setup()
    const loginResult = deferred<AuthState>()
    const onLoggedIn = vi.fn()
    installAuthLogin(() => loginResult.promise)

    render(<LoginScreen brandName="Open Cowork" onLoggedIn={onLoggedIn} />)

    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByRole('button', { name: 'Waiting for browser...' })).toBeDisabled()

    loginResult.resolve({
      authenticated: true,
      email: null,
    })

    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith(''))
  })
})
