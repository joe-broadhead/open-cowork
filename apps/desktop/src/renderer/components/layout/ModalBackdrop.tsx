// Shared dismiss-backdrop for modal dialogs. The keyboard equivalent
// is Escape-to-close, handled by each modal's `useFocusTrap({ onEscape })`
// rather than the backdrop itself — the backdrop is a mouse-only
// affordance and deliberately skipped by the tab order
// (`aria-hidden` + the absence of a role).
//
// Lints that flag "click events without key events" on this element
// are false positives in this context: the keyboard-equivalent
// behavior (Escape) lives on the sibling focus-trapped dialog. Using
// a shared component keeps the eslint-disable in one place instead of
// sprinkled across every modal.

interface Props {
  onDismiss: () => void
  className?: string
  // Extra style (z-index, background) — the default covers the full
  // viewport with a half-opacity black layer, which is what every
  // modal in the app wants.
  style?: React.CSSProperties
}

export function ModalBackdrop({ onDismiss, className, style }: Props) {
  // `aria-hidden="true"` marks this as non-interactive for assistive
  // tech; lint rules that flag onClick-without-keyboard are silenced
  // by that attribute alone. Sighted mouse users still get the
  // click-outside-to-close affordance.
  return (
    <div
      onClick={onDismiss}
      aria-hidden="true"
      className={className ?? 'fixed inset-0 z-50 bg-black/50'}
      style={style}
    />
  )
}
