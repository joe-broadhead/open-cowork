import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApprovalsQueueSurface } from '@open-cowork/ui'
import { ErrorState } from './index'

describe('ErrorState', () => {
  it('names what happened and how to fix it, with a recovery action', async () => {
    const user = userEvent.setup()
    const onRetry = vi.fn()
    render(
      <ErrorState
        title="Couldn’t load capabilities"
        message="We couldn’t reach the runtime."
        hint="Check the runtime is running, then reload."
        onRetry={onRetry}
        retryLabel="Reload"
      />,
    )

    // Designed error surface announces itself for assistive tech.
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('Couldn’t load capabilities')).toBeTruthy()
    expect(screen.getByText('We couldn’t reach the runtime.')).toBeTruthy()
    expect(screen.getByText('Check the runtime is running, then reload.')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('renders no action affordance when none is provided', () => {
    render(<ErrorState title="Broke" message="It broke" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('ApprovalsQueueSurface error state', () => {
  it('replaces the bare error string with a designed, recoverable error state', async () => {
    const user = userEvent.setup()
    const onReload = vi.fn()
    render(
      <ApprovalsQueueSurface
        items={[]}
        error="Runtime disconnected"
        onReload={onReload}
      />,
    )

    expect(screen.getByText('Couldn’t load approvals')).toBeTruthy()
    expect(screen.getByText('Runtime disconnected')).toBeTruthy()
    // The hint reassures the user nothing was auto-approved.
    expect(screen.getByText(/nothing was auto-approved/i)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Reload' }))
    expect(onReload).toHaveBeenCalledTimes(1)
  })
})
