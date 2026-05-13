import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AutomationHelpDrawer } from './AutomationHelpDrawer'

describe('AutomationHelpDrawer', () => {
  it('explains the automation lifecycle and closes from the header button', () => {
    const onClose = vi.fn()
    render(<AutomationHelpDrawer onClose={onClose} />)

    expect(screen.getByRole('dialog', { name: 'Standing agent programs' })).toBeInTheDocument()
    expect(screen.getByText('1. Prepare')).toBeInTheDocument()
    expect(screen.getByText('2. Review')).toBeInTheDocument()
    expect(screen.getByText('3. Execute')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close help' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
