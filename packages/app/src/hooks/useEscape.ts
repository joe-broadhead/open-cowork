import { useEffect, useRef } from 'react'

// One shared, stacked Escape handler for the whole renderer.
//
// Several surfaces (the question dock, the task drill-in drawer, the agent
// builder, the capabilities sub-views, the workspace switcher) each need to
// dismiss themselves on Escape. Wiring a bespoke `window.addEventListener`
// in every component is fragile: when more than one mounts, a single Escape
// fans out to every listener at once. Instead each surface registers through
// `useEscape`, which keeps a module-level stack and runs only the top-most
// (most-recently-mounted) enabled handler.
//
// The single shared listener is installed in the capture phase so it always
// runs before bubble-phase window listeners — notably the app-level
// navigation Escape in `useAppGlobalEvents`. When a stacked handler consumes
// the event it calls `stopImmediatePropagation`, so neither the app-level
// handler nor any other window listener also fires. That keeps today's
// containment guarantee: the app navigation Escape stays a pure fallback that
// only runs when no modal/popover is open.

type EscapeEntry = {
  // Read the current handler through a ref so re-renders that pass a fresh
  // closure don't churn the stack or change ordering.
  handlerRef: { current: () => void }
  // Read live so a consumer registered while closed (enabled=false) is
  // skipped without unregistering/re-registering on every open/close.
  enabledRef: { current: boolean }
}

// Most-recently-registered entry sits at the end of the array (the top of the
// stack). Escape walks from the top down to the first enabled entry.
const stack: EscapeEntry[] = []

let listenerRefCount = 0
let sharedListener: ((event: KeyboardEvent) => void) | null = null

function handleSharedKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const entry = stack[index]
    if (!entry || !entry.enabledRef.current) continue
    event.preventDefault()
    // stopImmediatePropagation (not just stopPropagation) so other listeners
    // on window — the app-level navigation Escape and any test spies — never
    // also fire for a consumed Escape.
    event.stopImmediatePropagation()
    event.stopPropagation()
    entry.handlerRef.current()
    return
  }
}

function acquireSharedListener() {
  if (listenerRefCount === 0) {
    sharedListener = handleSharedKeyDown
    // Capture phase: run before bubble-phase window listeners (e.g. the
    // app-level Escape) regardless of which mounted first.
    window.addEventListener('keydown', sharedListener, true)
  }
  listenerRefCount += 1
}

function releaseSharedListener() {
  listenerRefCount -= 1
  if (listenerRefCount <= 0) {
    listenerRefCount = 0
    if (sharedListener) {
      window.removeEventListener('keydown', sharedListener, true)
      sharedListener = null
    }
  }
}

export type UseEscapeOptions = {
  // Register but stay inert when false (e.g. a popover that's currently
  // closed) — an inert consumer is never the one that handles Escape.
  enabled?: boolean
}

// Register `handler` to run when Escape is pressed while this is the top-most
// enabled consumer. Returns nothing; cleanup happens on unmount.
export function useEscape(handler: () => void, options?: UseEscapeOptions) {
  const enabled = options?.enabled ?? true

  // Keep the latest handler/enabled values in refs so the stack entry is
  // stable for the lifetime of the component — re-renders update the refs in
  // place rather than re-ordering the stack.
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  useEffect(() => {
    const entry: EscapeEntry = { handlerRef, enabledRef }
    stack.push(entry)
    acquireSharedListener()
    return () => {
      const index = stack.indexOf(entry)
      if (index !== -1) stack.splice(index, 1)
      releaseSharedListener()
    }
  }, [])
}
