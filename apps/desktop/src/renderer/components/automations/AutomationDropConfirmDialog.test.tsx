import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AutomationDropConfirmDialog } from './AutomationDropConfirmDialog'

describe('AutomationDropConfirmDialog', () => {
  it('renders the drop action and dispatches cancel/confirm actions', () => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()

    render(
      <AutomationDropConfirmDialog
        action={{
          valid: true,
          title: 'Archive automation',
          message: 'Move this automation to archived.',
          type: 'pause',
          targetColumn: 'paused',
          automationId: 'automation-1',
          confirm: true,
        }}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    )

    expect(screen.getByRole('dialog', { name: 'Archive automation' })).toBeInTheDocument()
    expect(screen.getByText('Move this automation to archived.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
