import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeOfflineBanner } from './RuntimeOfflineBanner'

describe('RuntimeOfflineBanner', () => {
  it('announces runtime failures and invokes the restart action', async () => {
    const onRestart = vi.fn(async () => undefined)
    render(<RuntimeOfflineBanner error="socket closed" onRestart={onRestart} />)

    expect(screen.getByRole('status')).toHaveTextContent('Runtime unavailable:')
    expect(screen.getByText('socket closed')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(onRestart).toHaveBeenCalledTimes(1))
  })

  it('coalesces repeated restart clicks while a restart is in flight', async () => {
    let resolveRestart!: () => void
    const restartPromise = new Promise<void>((resolve) => {
      resolveRestart = resolve
    })
    const onRestart = vi.fn(() => restartPromise)
    render(<RuntimeOfflineBanner error="runtime crashed" onRestart={onRestart} />)

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('button', { name: 'Restarting…' })
    fireEvent.click(screen.getByRole('button', { name: 'Restarting…' }))

    expect(onRestart).toHaveBeenCalledTimes(1)
    resolveRestart()

    await screen.findByRole('button', { name: 'Try again' })
  })
})
