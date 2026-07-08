import { useEffect, useRef, type RefObject } from 'react'

// Dismiss an open composer popover/menu when a pointer-down (capture phase) lands outside it and
// outside any of the ignored anchors (its trigger, the textarea, etc.). Both composers hand-rolled
// this identical effect — HomeComposer twice — so it lives here once (#920).
export function useDismissOnOutsidePointer(
  active: boolean,
  onDismiss: () => void,
  ignoreRefs: Array<RefObject<HTMLElement | null>>,
): void {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  const ignoreRefsRef = useRef(ignoreRefs)
  ignoreRefsRef.current = ignoreRefs

  useEffect(() => {
    if (!active) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (ignoreRefsRef.current.some((ref) => ref.current?.contains(target))) return
      onDismissRef.current()
    }
    document.addEventListener('mousedown', handlePointerDown, true)
    return () => document.removeEventListener('mousedown', handlePointerDown, true)
  }, [active])
}
