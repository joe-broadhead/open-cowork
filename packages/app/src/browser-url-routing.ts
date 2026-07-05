import { normalizeAppView, type AppView } from './app-types.ts'

// Hash-based URL routing for the BROWSER (cloud web) runtime only.
//
// The unified renderer historically kept the active view in memory, so a
// browser refresh always landed back on Home and no view was shareable. These
// helpers map view state to a stable `#/…` scheme:
//
//   #/home, #/projects, #/knowledge, …   plain views (legacy aliases accepted
//                                        on parse via normalizeAppView)
//   #/chat/<sessionId>                   chat bound to a session
//
// Kept pure (no window access) so parsing/formatting is node-testable; App.tsx
// owns the window.location wiring and gates it on !isDesktopRuntime() so the
// Electron shell's behavior is unchanged (its dev-only #/ui-primitives flow
// still parses through here).

export type ParsedAppHash = {
  view: AppView | null
  sessionId: string | null
}

export type ParseAppHashOptions = {
  // The ui-primitives gallery is DEV-only; parsing it in production would
  // route to a view whose palette/nav entries do not exist.
  devMode?: boolean
}

export function parseAppHash(hash: string, options: ParseAppHashOptions = {}): ParsedAppHash {
  const none: ParsedAppHash = { view: null, sessionId: null }
  const raw = (hash || '').replace(/^#/, '')
  if (!raw || raw === '/') return { view: 'home', sessionId: null }
  if (!raw.startsWith('/')) return none
  const segments = raw.slice(1).split('/')
  const head = segments[0] || ''
  if (head === 'chat') {
    if (segments.length !== 2 || !segments[1]) return none
    let sessionId: string
    try {
      sessionId = decodeURIComponent(segments[1])
    } catch {
      return none
    }
    return sessionId ? { view: 'chat', sessionId } : none
  }
  if (segments.length !== 1) return none
  const view = normalizeAppView(head)
  if (!view || view === 'settings') return none
  if (view === 'ui-primitives' && !options.devMode) return none
  return { view, sessionId: null }
}

export function appHashFor(view: AppView, sessionId?: string | null): string {
  if (view === 'chat' && sessionId) return `#/chat/${encodeURIComponent(sessionId)}`
  return `#/${view}`
}
