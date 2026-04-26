import { useEffect, useRef } from 'react'

// Traps keyboard focus inside a container while it's mounted. Use for
// modal dialogs, slide-over panels, and destructive-confirmation
// surfaces so a screen-reader or keyboard user can't accidentally
// Tab into the content behind the modal.
//
// On mount: captures the previously-focused element, moves focus to
// the first focusable element inside the container (or the container
// itself if nothing focusable exists).
// While mounted: Tab / Shift-Tab cycle within the container.
// On unmount: restores focus to whatever had it before.
// Optional `onEscape` fires on Escape so callers can wire close.
//
// Keeps the caller's autoFocus semantics intact — we don't fight an
// explicit initial focus target if the DOM already has one.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
].join(',')

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => !el.hasAttribute('inert') && el.offsetParent !== null)
}

export function useFocusTrap(
  containerRef: React.RefObject<HTMLElement | null>,
  options?: { onEscape?: () => void; active?: boolean },
) {
  const previousActive = useRef<HTMLElement | null>(null)
  const active = options?.active !== false
  const onEscape = options?.onEscape

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    previousActive.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null

    // Let an already-focused element inside the container (usually an
    // autoFocus input) keep focus. Otherwise, push focus to the first
    // focusable child, falling back to the container itself with a
    // programmatic tabindex.
    if (!container.contains(document.activeElement)) {
      const focusables = getFocusableElements(container)
      const target = focusables[0] || container
      if (target === container && !container.hasAttribute('tabindex')) {
        container.setAttribute('tabindex', '-1')
      }
      target.focus()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onEscape) {
        event.preventDefault()
        onEscape()
        return
      }
      if (event.key !== 'Tab') return
      const focusables = getFocusableElements(container)
      if (focusables.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const current = document.activeElement

      if (event.shiftKey && current === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && current === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      const previous = previousActive.current
      if (previous && typeof previous.focus === 'function') {
        // Guard against restoring focus to a detached node (e.g. the
        // trigger button itself was unmounted by the same interaction
        // that closed the modal).
        if (document.contains(previous)) {
          previous.focus()
        }
      }
    }
  }, [active, containerRef, onEscape])
}
