import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../../stores/session'
import { Toaster, toast } from './Toaster'

function resetSessionStore() {
  useSessionStore.setState(useSessionStore.getInitialState(), true)
}

beforeEach(() => {
  resetSessionStore()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Toaster', () => {
  it('renders global errors outside the chat view', async () => {
    render(<Toaster />)

    act(() => {
      useSessionStore.getState().addGlobalError('Could not save settings.')
    })

    expect(await screen.findByRole('alert', { name: 'App error: Could not save settings.' })).toBeInTheDocument()
    expect(screen.getByText('Could not save settings.')).toBeInTheDocument()
  })

  it('dismisses notifications from the keyboard', async () => {
    const user = userEvent.setup()
    render(<Toaster />)

    act(() => {
      useSessionStore.getState().addGlobalError('Keyboard dismiss me.')
    })

    expect(await screen.findByRole('alert', { name: 'App error: Keyboard dismiss me.' })).toBeInTheDocument()
    screen.getByRole('button', { name: 'Dismiss' }).focus()
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(screen.queryByText('Keyboard dismiss me.')).not.toBeInTheDocument()
    })
  })

  it('auto-dismisses visible toasts after five seconds', async () => {
    vi.useFakeTimers()
    render(<Toaster />)

    act(() => {
      useSessionStore.getState().addGlobalError('Temporary notice.')
    })

    expect(screen.getByText('Temporary notice.')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(4999)
    })
    expect(screen.getByText('Temporary notice.')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByText('Temporary notice.')).not.toBeInTheDocument()
  })

  it('pauses auto-dismiss while hovered', async () => {
    vi.useFakeTimers()
    render(<Toaster />)

    act(() => {
      useSessionStore.getState().addGlobalError('Hover pause notice.')
    })

    const notice = screen.getByRole('alert', { name: 'App error: Hover pause notice.' })
    fireEvent.pointerEnter(notice)

    act(() => {
      vi.advanceTimersByTime(10000)
    })
    expect(screen.getByText('Hover pause notice.')).toBeInTheDocument()

    fireEvent.pointerLeave(notice)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.queryByText('Hover pause notice.')).not.toBeInTheDocument()
  })

  it('supports explicit success toasts with actions', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(<Toaster />)

    act(() => {
      toast({
        tone: 'success',
        message: 'Export complete.',
        action: {
          label: 'Open',
          onClick,
        },
      })
    })

    expect(await screen.findByRole('status', { name: 'Done: Export complete.' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open' }))

    expect(onClick).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(screen.queryByText('Export complete.')).not.toBeInTheDocument()
    })
  })

  it('collapses older notices when more than three are active', async () => {
    render(<Toaster />)

    act(() => {
      for (const message of ['One', 'Two', 'Three', 'Four']) {
        useSessionStore.getState().addGlobalError(message)
      }
    })

    expect(await screen.findByText('+2 earlier notices')).toBeInTheDocument()
    expect(screen.queryByText('One')).not.toBeInTheDocument()
    expect(screen.queryByText('Two')).not.toBeInTheDocument()
    expect(screen.getByText('Three')).toBeInTheDocument()
    expect(screen.getByText('Four')).toBeInTheDocument()
  })
})
