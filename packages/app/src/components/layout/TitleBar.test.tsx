import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../../stores/session'
import { TitleBar } from './TitleBar'

describe('TitleBar', () => {
  it('routes the sidebar button through the app-owned session store', () => {
    const toggleSidebar = vi.fn()
    useSessionStore.setState({ toggleSidebar })

    render(<TitleBar />)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }))

    expect(toggleSidebar).toHaveBeenCalledTimes(1)
  })
})
