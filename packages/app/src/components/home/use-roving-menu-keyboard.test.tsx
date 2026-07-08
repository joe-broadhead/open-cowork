import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useRef } from 'react'
import { useRovingMenuKeyboard } from './use-roving-menu-keyboard'

function Menu({ onClose }: { onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { onKeyDown } = useRovingMenuKeyboard(menuRef, triggerRef, true, onClose)
  return (
    <div>
      <button ref={triggerRef} data-testid="trigger">open</button>
      <div ref={menuRef} role="menu" onKeyDown={onKeyDown}>
        <button role="menuitemradio" aria-checked="false" data-testid="a">A</button>
        <button role="menuitemradio" aria-checked="true" data-testid="b">B</button>
        <button role="menuitemradio" aria-checked="false" data-testid="c">C</button>
      </div>
    </div>
  )
}

describe('useRovingMenuKeyboard (#918)', () => {
  it('focuses the active option on open', () => {
    const { getByTestId } = render(<Menu onClose={() => {}} />)
    expect(document.activeElement).toBe(getByTestId('b'))
  })

  it('moves focus with Arrow/Home/End and wraps', () => {
    const { getByTestId } = render(<Menu onClose={() => {}} />)
    const menu = getByTestId('b').closest('[role="menu"]')!
    fireEvent.keyDown(menu, { key: 'ArrowDown' }) // b -> c
    expect(document.activeElement).toBe(getByTestId('c'))
    fireEvent.keyDown(menu, { key: 'ArrowDown' }) // c -> a (wrap)
    expect(document.activeElement).toBe(getByTestId('a'))
    fireEvent.keyDown(menu, { key: 'ArrowUp' }) // a -> c (wrap)
    expect(document.activeElement).toBe(getByTestId('c'))
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(document.activeElement).toBe(getByTestId('a'))
    fireEvent.keyDown(menu, { key: 'End' })
    expect(document.activeElement).toBe(getByTestId('c'))
  })

  it('Escape closes and returns focus to the trigger', () => {
    const onClose = vi.fn()
    const { getByTestId } = render(<Menu onClose={onClose} />)
    fireEvent.keyDown(getByTestId('b').closest('[role="menu"]')!, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(getByTestId('trigger'))
  })
})
