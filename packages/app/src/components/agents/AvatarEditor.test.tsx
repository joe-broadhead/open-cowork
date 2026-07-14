import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { AvatarEditor } from './AvatarEditor'

const anchorRect = {
  bottom: 72,
  height: 48,
  left: 24,
  right: 72,
  top: 24,
  width: 48,
  x: 24,
  y: 24,
  toJSON: () => ({}),
} as DOMRect

describe('AvatarEditor', () => {
  it('is modal, cycles focus within the editor, and restores the avatar trigger on Escape', async () => {
    const onAvatarChange = vi.fn()
    const onColorChange = vi.fn()
    const user = userEvent.setup()

    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Edit avatar</button>
          <button type="button">Background profile action</button>
          {open ? (
            <AvatarEditor
              name="Ada"
              color="accent"
              src={null}
              anchorRect={anchorRect}
              onClose={() => setOpen(false)}
              onAvatarChange={onAvatarChange}
              onColorChange={onColorChange}
            />
          ) : null}
        </>
      )
    }

    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Edit avatar' })
    await user.click(trigger)

    const dialog = screen.getByRole('dialog', { name: 'Edit coworker avatar' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Upload image' })).toHaveFocus())
    expect((await axe(dialog)).violations).toEqual([])

    await user.tab({ shift: true })
    expect(screen.getByRole('button', { name: 'Set color to Neutral' })).toHaveFocus()
    expect(dialog).toContainElement(document.activeElement as HTMLElement)
    expect(screen.getByRole('button', { name: 'Background profile action' })).not.toHaveFocus()

    await user.tab()
    expect(screen.getByRole('button', { name: 'Upload image' })).toHaveFocus()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog', { name: 'Edit coworker avatar' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(onAvatarChange).not.toHaveBeenCalled()
    expect(onColorChange).not.toHaveBeenCalled()
  })
})
