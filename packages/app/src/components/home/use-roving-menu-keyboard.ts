import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

// Roving-focus + keyboard control for an ARIA `menu` of `menuitem*` buttons (#918): focus the active
// (or first) option when the menu opens, Arrow/Home/End navigation between options, and Escape to
// close and return focus to the trigger. jsx-a11y cannot verify this behavior, so it is hand-wired
// here and shared by any menu that needs it.
export function useRovingMenuKeyboard(
  menuRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): { onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void } {
  useEffect(() => {
    if (!open) return
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])
    const active = items.find((item) => item.getAttribute('aria-checked') === 'true') || items[0]
    active?.focus()
  }, [menuRef, open])

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])
    if (items.length === 0) return
    const index = items.findIndex((item) => item === document.activeElement)
    const focusAt = (next: number) => {
      event.preventDefault()
      items[(next + items.length) % items.length]?.focus()
    }
    if (event.key === 'ArrowDown') focusAt(index + 1)
    else if (event.key === 'ArrowUp') focusAt(index - 1)
    else if (event.key === 'Home') focusAt(0)
    else if (event.key === 'End') focusAt(items.length - 1)
    else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      triggerRef.current?.focus()
    }
  }

  return { onKeyDown }
}
