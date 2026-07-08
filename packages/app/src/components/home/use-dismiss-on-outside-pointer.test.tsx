import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useRef } from 'react'
import { useDismissOnOutsidePointer } from './use-dismiss-on-outside-pointer'

function Widget({ active, onDismiss }: { active: boolean, onDismiss: () => void }) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLButtonElement>(null)
  useDismissOnOutsidePointer(active, onDismiss, [popoverRef, anchorRef])
  return (
    <div>
      <button ref={anchorRef} data-testid="anchor">anchor</button>
      <div ref={popoverRef} data-testid="popover">popover</div>
      <div data-testid="outside">outside</div>
    </div>
  )
}

describe('useDismissOnOutsidePointer (#920)', () => {
  it('dismisses on a pointer-down outside the popover and its anchor', () => {
    const onDismiss = vi.fn()
    const { getByTestId } = render(<Widget active onDismiss={onDismiss} />)
    fireEvent.mouseDown(getByTestId('outside'))
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('ignores pointer-downs inside the popover or the anchor', () => {
    const onDismiss = vi.fn()
    const { getByTestId } = render(<Widget active onDismiss={onDismiss} />)
    fireEvent.mouseDown(getByTestId('popover'))
    fireEvent.mouseDown(getByTestId('anchor'))
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('does not listen while inactive', () => {
    const onDismiss = vi.fn()
    const { getByTestId } = render(<Widget active={false} onDismiss={onDismiss} />)
    fireEvent.mouseDown(getByTestId('outside'))
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
