import type { AppView } from './app-types'
import { parseAppHash } from './browser-url-routing'
import { isDesktopRuntime } from './runtime-env'

export const UI_PRIMITIVES_HASH = '#/ui-primitives'
export const UI_PRIMITIVES_ENABLED = import.meta.env.DEV

export type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => unknown
}

export function canUseViewTransition() {
  return Boolean(
    (document as ViewTransitionDocument).startViewTransition
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
}

export function browserUrlRoutingEnabled(): boolean {
  return typeof window !== 'undefined' && !isDesktopRuntime()
}

export function initialAppView(): AppView {
  if (UI_PRIMITIVES_ENABLED && typeof window !== 'undefined' && window.location.hash === UI_PRIMITIVES_HASH) return 'ui-primitives'
  if (browserUrlRoutingEnabled()) {
    const parsed = parseAppHash(window.location.hash, { devMode: UI_PRIMITIVES_ENABLED })
    if (parsed.view && parsed.view !== 'chat') return parsed.view
  }
  return 'home'
}

export function previewDismissed(version: string) {
  try {
    return window.localStorage.getItem(`open-cowork.preview-dismissed.${version}`) === 'true'
  } catch {
    return false
  }
}

export function dismissPreview(version: string) {
  try {
    window.localStorage.setItem(`open-cowork.preview-dismissed.${version}`, 'true')
  } catch {
    // localStorage can be unavailable in restricted renderer contexts.
  }
}

export function describeError(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function errorStack(error: unknown) {
  return error instanceof Error ? error.stack : undefined
}
