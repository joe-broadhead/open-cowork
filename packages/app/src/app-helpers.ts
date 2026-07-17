import type { AppView } from './app-types'
import { parseAppHash } from './browser-url-routing'
import { isDesktopRuntime } from './runtime-env'

export const UI_PRIMITIVES_HASH = '#/ui-primitives'
export const UI_PRIMITIVES_ENABLED = import.meta.env.DEV

export type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void) => {
    finished?: Promise<void>
    ready?: Promise<void>
    updateCallbackDone?: Promise<void>
  }
}

export function canUseViewTransition() {
  // Electron packaged shells often recover by reloading the renderer mid-boot
  // (splash → main). View Transitions abort as "Transition was skipped" in that
  // race and used to surface as a fatal Startup Error. Keep transitions on web.
  if (isDesktopRuntime()) return false
  return Boolean(
    (document as ViewTransitionDocument).startViewTransition
    && !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
}

/** True for the View Transition API's normal abort when a later update supersedes it. */
export function isViewTransitionSkippedError(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const record = error as { name?: unknown; message?: unknown }
  if (record.name !== 'AbortError') return false
  const message = typeof record.message === 'string' ? record.message : ''
  return message === 'Transition was skipped' || message.includes('Transition was skipped')
}

/**
 * Run a DOM update inside a View Transition when available. Skipped-transition
 * aborts are expected (overlapping navigations) and must not become unhandled
 * rejections that tear down the renderer.
 */
export function runViewTransition(update: () => void) {
  if (!canUseViewTransition()) {
    update()
    return
  }
  const transition = (document as ViewTransitionDocument).startViewTransition?.(update)
  const finished = transition?.finished
  if (finished && typeof (finished as Promise<void>).then === 'function') {
    void finished.catch((error: unknown) => {
      if (isViewTransitionSkippedError(error)) return
      console.warn('View transition failed:', error)
    })
  }
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
